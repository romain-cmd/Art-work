import { artworkSummary, sizeSummary } from "../lib/artwork-groups";
import { artworkLabel, artworkMarkings } from "../lib/artwork-status";
import { personalizationLabel } from "../lib/personalization";
import { ProofReviewContent, REVIEW_STYLES } from "../components/proof-review-content";
import { commentPoint } from "../lib/artwork-workspace";
/* eslint-disable react/prop-types -- no PropTypes package in this project */
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import prisma from "../db.server";
import { event } from "../lib/artwork-cases.server";
import { sendInternalNotificationEmail } from "../lib/send-internal-notification-email.server";

// PUBLIC route (no "app." prefix): no Shopify authentication here,
// since this is opened by the end customer from their email.
export const loader = async ({ request }) => {
  const tokens = (new URL(request.url).searchParams.get("tokens") || "").split(",").filter(Boolean).slice(0, 200);
  if (!tokens.length) return { proofs: [], dossier: null };
  const candidates = await prisma.proof.findMany({ where: { token: { in: tokens }, deletedAt: null, personalization: { isActive: true } }, include: { personalization: true, personalizations: true }, orderBy: { createdAt: "asc" } });
  if (!candidates.length) return { proofs: [], dossier: null };
  const first = candidates[0].personalization;
  const dossier = await prisma.artworkCase.findUnique({ where: { shop_draftOrderId: { shop: first.shop, draftOrderId: first.draftOrderId } } });
  if (!dossier || dossier.archivedAt) return { proofs: [], dossier: null };
  const required = await prisma.artworkItem.findMany({ where: { shop: first.shop, draftOrderId: first.draftOrderId, isActive: true, requirement: "required" } });
  const proofs = candidates.filter((p) => p.personalization.shop === first.shop && p.personalization.draftOrderId === first.draftOrderId && required.some((i) => i.lineItemId === p.personalization.lineItemId) && p.personalizations.every((marking) => marking.isActive && marking.shop === first.shop && marking.draftOrderId === first.draftOrderId && required.some((i) => i.lineItemId === marking.lineItemId)) && (p.envoyeLe || p.status !== "en_attente"));
  return { proofs: proofs.map((p) => ({ ...p, personalization: { ...(p.snapshot || p.personalization), personalizationId: p.personalizationId }, markings: artworkSummary(p).length ? artworkSummary(p) : artworkMarkings(p, [p.personalization]), sizes: sizeSummary(p) })), dossier: { name: dossier.name, yachtName: dossier.yachtName, customerName: dossier.customerName } };
};

export const action = async ({ request }) => {
  const fd = await request.formData(); const token = String(fd.get("token") || ""); const decision = fd.get("decision"); let comment = String(fd.get("commentaireClient") || "").trim().slice(0, 3500);
  if (!["approuve", "modification_demandee"].includes(decision)) return { error: "Invalid decision." };
  if (decision === "modification_demandee" && !comment) return { error: "Please describe the changes you need." };
  const proof = await prisma.proof.findUnique({ where: { token }, include: { personalization: true, personalizations: true } });
  if (!proof?.isCurrent || proof.deletedAt || !proof.personalizations.length || proof.personalizations.some((p) => !p.isActive || p.shop !== proof.personalization.shop || p.draftOrderId !== proof.personalization.draftOrderId) || !proof.personalization.isActive || !proof.envoyeLe) return { error: "This version is no longer available for approval. Please use the latest email from our team." };
  if (decision === "modification_demandee" && fd.get("changeTarget") && fd.get("changeTarget") !== "all") {
    const targets = artworkSummary(proof).length ? artworkSummary(proof) : artworkMarkings(proof, [proof.personalization]);
    const index = Number(fd.get("changeTarget"));
    if (!Number.isInteger(index) || !targets[index]) return { error: "Please select a marking from this artwork." };
    comment = `${personalizationLabel(targets[index], { english: true, product: false })} : ${comment}`;
  }
  if (decision === "modification_demandee" && fd.has("pointX")) {
    const x = Number(fd.get("pointX")); const y = Number(fd.get("pointY"));
    if (![x, y].every((v) => Number.isInteger(v) && v >= 0 && v <= 100)) return { error: "Please place a point inside the artwork." };
    comment = `Point 1 (${x}% from left, ${y}% from top): ${comment}`;
  }
  const dossier = await prisma.artworkCase.findUnique({ where: { shop_draftOrderId: { shop: proof.personalization.shop, draftOrderId: proof.personalization.draftOrderId } } });
  const item = await prisma.artworkItem.findUnique({ where: { shop_draftOrderId_lineItemId: { shop: proof.personalization.shop, draftOrderId: proof.personalization.draftOrderId, lineItemId: proof.personalization.lineItemId } } });
  if (!dossier || dossier.archivedAt || !item?.isActive || item.requirement !== "required") return { error: "This design is no longer awaiting approval." };
  const groupLines = [...new Set(proof.personalizations.map((p) => p.lineItemId))];
  const groupItems = await prisma.artworkItem.findMany({ where: { shop: proof.personalization.shop, draftOrderId: proof.personalization.draftOrderId, lineItemId: { in: groupLines }, isActive: true, requirement: "required" } });
  if (groupItems.length !== groupLines.length) return { error: "These sizes or markings have changed. Please request a new artwork from our team." };
  const changed = await prisma.$transaction(async (tx) => {
    const update = await tx.proof.updateMany({ where: { id: proof.id, isCurrent: true, status: "en_attente" }, data: { status: decision, commentaireClient: decision === "modification_demandee" ? comment : null, reponduLe: new Date(), approvedVia: "Lien client" } });
    if (update.count) await event(dossier.id, `BAT V${proof.version} ${decision === "approuve" ? "validé" : "à corriger"} : ${artworkLabel(proof)}.${comment ? ` Commentaire : ${comment}` : ""}`, "Client", tx);
    return update.count;
  });
  if (!changed) return { error: "A response has already been recorded for this design. Refresh the page to see it." };
  try {
    const settings = await prisma.shopSettings.findUnique({ where: { shop: proof.personalization.shop } });
    if (settings?.notificationEmail) {
      // eslint-disable-next-line no-undef
      const adminUrl = `${process.env.SHOPIFY_APP_URL}/app/personnalisation?case=${dossier.id}`;
      await sendInternalNotificationEmail({ to: settings.notificationEmail, productTitle: artworkLabel(proof), decision, comment: decision === "modification_demandee" ? comment : null, adminUrl });
    }
  } catch (error) { console.error("Failed to send internal notification email", error); }
  return { success: true, token, status: decision };
};

function ProofCard({ proof }) {
  const fetcher = useFetcher();
  const [isRequestingChange, setIsRequestingChange] = useState(false);
  const [comment, setComment] = useState("");
  const [target, setTarget] = useState("all");
  const [annotating, setAnnotating] = useState(false); const [annotation, setAnnotation] = useState(null);

  // After each decision, React Router automatically refreshes the page's
  // data in the background (no visible navigation): the status shown
  // below always reflects the database for THIS card, without ever
  // touching the other cards on the page.
  const isSubmitting = fetcher.state !== "idle";
  const alreadyAnswered = proof.status !== "en_attente" || !proof.isCurrent;

  useEffect(() => {
    if (fetcher.data?.success) {
      setIsRequestingChange(false);
    }
  }, [fetcher.data]);

  const submitDecision = (decision) => {
    const formData = new FormData();
    formData.set("token", proof.token);
    formData.set("decision", decision);
    if (decision === "modification_demandee") {
      formData.set("commentaireClient", comment);
      formData.set("changeTarget", target);
      if (annotation) { formData.set("pointX", String(annotation.x)); formData.set("pointY", String(annotation.y)); }
    }
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <ProofReviewContent proof={proof} summaryUrl={`/proof-review/summary?token=${encodeURIComponent(proof.token)}`} annotating={annotating} annotation={annotation || commentPoint(proof.commentaireClient)} onAnnotate={(point) => { setAnnotation(point); setAnnotating(false); }}>
      {proof.status === "approuve" && (
        <div className="pr-status pr-status--approved">✓ Approved</div>
      )}
      {proof.status === "modification_demandee" && (
        <div>
          <div className="pr-status pr-status--changes">Changes requested</div>
          {proof.commentaireClient && (
            <p className="pr-comment">“{proof.commentaireClient}”</p>
          )}
        </div>
      )}

      {!alreadyAnswered && !isRequestingChange && (
        <div className="pr-actions pr-decision">
          <button
            type="button"
            className="pr-btn pr-btn--primary"
            disabled={isSubmitting}
            onClick={() => submitDecision("approuve")}
          >
            {isSubmitting ? "Saving…" : "Approve this design"}
          </button>
          <button
            type="button"
            className="pr-btn pr-btn--secondary"
            disabled={isSubmitting}
            onClick={() => setIsRequestingChange(true)}
          >
            Request changes
          </button>
        </div>
      )}

      {!alreadyAnswered && isRequestingChange && (
        <div className="pr-change-form">
          {proof.mimeType !== "application/pdf" && <><button type="button" className="pr-btn pr-btn--secondary" onClick={() => setAnnotating(!annotating)}>{annotating ? "Cancel point placement" : "Add a point on the artwork"}</button>{annotating && <p className="pr-pin-help" role="status">Click a location on the artwork above, or describe it in your comment.</p>}{annotation && <p className="pr-pin-help">Point 1: {annotation.x}% from left, {annotation.y}% from top. <button type="button" className="pr-btn pr-btn--ghost" onClick={() => setAnnotation(null)}>Remove point</button></p>}</>}
          <label>Which marking needs a change?
            <select className="pr-select" value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="all">Whole artwork / other</option>
              {(proof.markings || [proof.personalization]).map((p, index) => <option key={index} value={String(index)}>{personalizationLabel(p, { english: true, product: false })}</option>)}
            </select>
          </label>
          <label htmlFor={`comment-${proof.id}`}>Describe the changes</label>
          <textarea id={`comment-${proof.id}`} maxLength={3500}
            rows={3}
            className="pr-textarea"
            placeholder="Describe the changes and specify the marking (for example: back print or chest embroidery)..."
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="pr-actions">
            <button
              type="button"
              className="pr-btn pr-btn--primary"
              disabled={isSubmitting || comment.trim() === ""}
              onClick={() => submitDecision("modification_demandee")}
            >
              {isSubmitting ? "Sending..." : "Send request"}
            </button>
            <button
              type="button"
              className="pr-btn pr-btn--ghost"
              disabled={isSubmitting}
              onClick={() => { setIsRequestingChange(false); setAnnotating(false); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {fetcher.data?.error && <p className="pr-error" role="alert">{fetcher.data.error}</p>}
    </ProofReviewContent>
  );
}

export default function ProofReview() {
  const { proofs, dossier } = useLoaderData();
  const actionable = proofs.filter((p) => p.isCurrent);
  const answered = actionable.filter((p) => p.status !== "en_attente").length;
  const allAnswered = actionable.length > 0 && answered === actionable.length;
  return <div className="pr-page"><style>{REVIEW_STYLES}</style><div className="pr-container">
    <p className="pr-eyebrow">Marina Yacht Wear · Artwork approval</p>
    <h1 className="pr-title">{dossier?.yachtName || "Review your designs"}</h1>
    {dossier && <p>{dossier.name}{dossier.customerName ? ` · ${dossier.customerName}` : ""}</p>}
    {actionable.length > 0 && <><p aria-live="polite">{answered} of {actionable.length} designs reviewed</p><div className="pr-progress" role="progressbar" aria-label="Designs reviewed" aria-valuenow={answered} aria-valuemin={0} aria-valuemax={actionable.length}><span style={{ width: `${answered / actionable.length * 100}%` }}/></div></>}
    {allAnswered && <div className="pr-empty"><h2>Thank you!</h2><p>Your responses have been recorded. Your decisions and designs remain available below.</p></div>}
    {!proofs.length && <div className="pr-empty">This link is unavailable. Please contact your Marina Yacht Wear representative for the latest designs.</div>}
    {proofs.map((proof) => <ProofCard key={proof.id} proof={proof}/>)}
    <p className="pr-comment">Please check the design, placement, marking dimensions and colour before approving. Requests for changes are sent directly to our team.</p>
  </div></div>;
}
