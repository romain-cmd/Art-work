/* eslint-disable react/prop-types -- no PropTypes package in this project */
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import prisma from "../db.server";
import { sendInternalNotificationEmail } from "../lib/send-internal-notification-email.server";

// PUBLIC route (no "app." prefix): no Shopify authentication here,
// since this is opened by the end customer from their email.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const tokensParam = url.searchParams.get("tokens") || "";
  const tokens = tokensParam.split(",").filter(Boolean);

  if (tokens.length === 0) {
    return { proofs: [] };
  }

  const proofs = await prisma.proof.findMany({
    where: { token: { in: tokens } },
    include: { personalization: true },
    orderBy: { createdAt: "asc" },
  });

  return { proofs };
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const token = formData.get("token");
  const decision = formData.get("decision"); // "approuve" | "modification_demandee"
  const commentaireClient = formData.get("commentaireClient") || null;

  const proof = await prisma.proof.findUnique({
    where: { token },
    include: { personalization: true },
  });
  if (!proof) {
    return { success: false, error: "This design could not be found." };
  }

  if (decision !== "approuve" && decision !== "modification_demandee") {
    return { success: false, error: "Invalid decision." };
  }

  await prisma.proof.update({
    where: { token },
    data: {
      status: decision,
      commentaireClient: decision === "modification_demandee" ? commentaireClient : null,
      reponduLe: new Date(),
    },
  });

  // La notification interne ne doit jamais faire échouer la réponse du
  // client, même si l'envoi de l'email plante.
  try {
    const settings = await prisma.shopSettings.findUnique({
      where: { shop: proof.personalization.shop },
    });
    if (settings?.notificationEmail) {
      // eslint-disable-next-line no-undef
      const adminUrl = process.env.SHOPIFY_APP_URL
        ? // eslint-disable-next-line no-undef
          `${process.env.SHOPIFY_APP_URL}/app/personnalisation`
        : null;
      await sendInternalNotificationEmail({
        to: settings.notificationEmail,
        productTitle: proof.personalization.productTitle,
        decision,
        comment: decision === "modification_demandee" ? commentaireClient : null,
        adminUrl,
      });
    }
  } catch (error) {
    console.error("Failed to send internal notification email", error);
  }

  return { success: true, token, status: decision };
};

// Page-scoped CSS (this route isn't inside the Shopify admin, so no
// Polaris components are available here — a real stylesheet gives us
// hover states, focus rings and responsive rules inline styles can't).
const PAGE_STYLES = `
  .pr-page {
    min-height: 100vh;
    background: #f4f5f7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1a2233;
  }
  .pr-container {
    max-width: 860px;
    margin: 0 auto;
    padding: 40px 20px 64px;
  }
  .pr-eyebrow {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #64748b;
    margin: 0 0 6px;
  }
  .pr-title {
    font-size: 24px;
    font-weight: 700;
    margin: 0 0 28px;
    color: #0b2545;
  }
  .pr-card {
    background: #ffffff;
    border: 1px solid #e4e7ec;
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 20px;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
  }
  .pr-card-title {
    font-size: 17px;
    font-weight: 600;
    margin: 0 0 14px;
    color: #0b2545;
  }
  .pr-details {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 10px 18px;
    background: #f8f9fb;
    border: 1px solid #eef0f3;
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 16px;
  }
  .pr-logo {
    grid-column: 1 / -1;
    height: 40px;
    width: fit-content;
    object-fit: contain;
    background: #fff;
    border: 1px solid #e4e7ec;
    border-radius: 6px;
    padding: 4px 8px;
  }
  .pr-details-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #94a3b8;
    margin: 0 0 2px;
  }
  .pr-details-value {
    font-size: 14px;
    color: #1a2233;
    margin: 0;
  }
  .pr-image {
    width: 100%;
    display: block;
    border-radius: 10px;
    border: 1px solid #e4e7ec;
    margin-bottom: 16px;
    background: #f8f9fb;
    object-fit: contain;
    max-height: 85vh;
  }
  .pr-pdf-frame {
    width: 100%;
    height: 85vh;
    min-height: 600px;
    display: block;
    border-radius: 10px;
    border: 1px solid #e4e7ec;
    margin-bottom: 16px;
    background: #f8f9fb;
  }
  .pr-pdf-fallback {
    display: inline-block;
    font-size: 13px;
    margin: -8px 0 16px;
    color: #0b2545;
    font-weight: 600;
    text-decoration: underline;
  }
  .pr-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    padding: 6px 12px;
    border-radius: 999px;
    margin-bottom: 14px;
  }
  .pr-status--approved {
    background: #dcfce7;
    color: #15803d;
  }
  .pr-status--changes {
    background: #fee2e2;
    color: #b91c1c;
  }
  .pr-comment {
    font-size: 13px;
    color: #64748b;
    font-style: italic;
    margin: -4px 0 14px;
  }
  .pr-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .pr-btn {
    appearance: none;
    border: none;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    padding: 10px 18px;
    border-radius: 8px;
    transition: background-color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
  }
  .pr-btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .pr-btn--primary {
    background: #0b2545;
    color: #ffffff;
  }
  .pr-btn--primary:hover:not(:disabled) {
    background: #081b33;
  }
  .pr-btn--secondary {
    background: #ffffff;
    color: #0b2545;
    border: 1px solid #cbd5e1;
  }
  .pr-btn--secondary:hover:not(:disabled) {
    background: #f8f9fb;
    border-color: #0b2545;
  }
  .pr-btn--ghost {
    background: transparent;
    color: #64748b;
  }
  .pr-btn--ghost:hover:not(:disabled) {
    background: #f1f2f4;
  }
  .pr-textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: inherit;
    font-size: 14px;
    padding: 10px 12px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    resize: vertical;
    margin-bottom: 10px;
  }
  .pr-textarea:focus {
    outline: none;
    border-color: #0b2545;
    box-shadow: 0 0 0 3px rgba(11, 37, 69, 0.12);
  }
  .pr-error {
    color: #b91c1c;
    font-size: 13px;
    margin: 10px 0 0;
  }
  .pr-empty {
    background: #ffffff;
    border: 1px solid #e4e7ec;
    border-radius: 16px;
    padding: 32px 24px;
    text-align: center;
    color: #64748b;
  }
  .pr-thankyou {
    max-width: 480px;
    margin: 60px auto 0;
    text-align: center;
    padding: 0 20px;
  }
  .pr-thankyou-icon {
    width: 56px;
    height: 56px;
    line-height: 56px;
    border-radius: 999px;
    background: #dcfce7;
    color: #15803d;
    font-size: 26px;
    margin: 0 auto 16px;
  }
  .pr-thankyou h1 {
    font-size: 22px;
    color: #0b2545;
    margin: 0 0 10px;
  }
  .pr-thankyou p {
    color: #475569;
    font-size: 15px;
    line-height: 1.5;
    margin: 0;
  }
`;

// Small info box listing the personalization details for this proof —
// only the fields that were actually filled in are shown.
function PersonalizationDetails({ personalization }) {
  const rows = [
    ["Type", personalization.type],
    ["Quantity", personalization.quantity],
    ["Size", personalization.size],
    ["Color", personalization.color],
    ["Placement", personalization.location],
    ["Custom text", personalization.customText],
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");

  if (rows.length === 0 && !personalization.logoUrl) return null;

  return (
    <div className="pr-details">
      {personalization.logoUrl && (
        <img className="pr-logo" src={personalization.logoUrl} alt="Logo" />
      )}
      {rows.map(([label, value]) => (
        <div key={label}>
          <p className="pr-details-label">{label}</p>
          <p className="pr-details-value">{value}</p>
        </div>
      ))}
    </div>
  );
}

function ProofCard({ proof }) {
  const fetcher = useFetcher();
  const [isRequestingChange, setIsRequestingChange] = useState(false);
  const [comment, setComment] = useState("");

  // After each decision, React Router automatically refreshes the page's
  // data in the background (no visible navigation): the status shown
  // below always reflects the database for THIS card, without ever
  // touching the other cards on the page.
  const isSubmitting = fetcher.state !== "idle";
  const alreadyAnswered = proof.status !== "en_attente";

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
    }
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <div className="pr-card">
      <h3 className="pr-card-title">{proof.personalization.productTitle}</h3>

      <PersonalizationDetails personalization={proof.personalization} />

      {proof.mimeType === "application/pdf" ? (
        <>
          <iframe
            className="pr-pdf-frame"
            src={proof.imageUrl}
            title={`Proposed design — ${proof.personalization.productTitle}`}
          />
          <a
            className="pr-pdf-fallback"
            href={proof.imageUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open the PDF in a new tab
          </a>
        </>
      ) : (
        <img className="pr-image" src={proof.imageUrl} alt="Proposed design" />
      )}

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
        <div className="pr-actions">
          <button
            type="button"
            className="pr-btn pr-btn--primary"
            disabled={isSubmitting}
            onClick={() => submitDecision("approuve")}
          >
            Approve
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
        <div>
          <textarea
            rows={3}
            className="pr-textarea"
            placeholder="Describe what needs to change..."
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
              onClick={() => setIsRequestingChange(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {fetcher.data?.error && <p className="pr-error">{fetcher.data.error}</p>}
    </div>
  );
}

export default function ProofReview() {
  const { proofs } = useLoaderData();
  const allAnswered =
    proofs.length > 0 && proofs.every((proof) => proof.status !== "en_attente");

  // Once the customer has responded to every design shown, the page's
  // data refreshes automatically in the background: this final screen
  // appears without a page reload.
  if (allAnswered) {
    return (
      <div className="pr-page">
        <style>{PAGE_STYLES}</style>
        <div className="pr-thankyou">
          <div className="pr-thankyou-icon">✓</div>
          <h1>Thank you!</h1>
          <p>
            All your responses have been sent to our team. We&apos;ll be in
            touch shortly regarding your order.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pr-page">
      <style>{PAGE_STYLES}</style>
      <div className="pr-container">
        <p className="pr-eyebrow">Design approval</p>
        <h1 className="pr-title">Review your designs</h1>

        {proofs.length === 0 && (
          <div className="pr-empty">This link is invalid or has expired.</div>
        )}

        {proofs.map((proof) => (
          <ProofCard key={proof.id} proof={proof} />
        ))}
      </div>
    </div>
  );
}
