/* eslint-disable react/prop-types */
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { Link, useBlocker, useFetcher, useLoaderData, useLocation, useNavigate, useNavigation, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { uploadFileToShopify } from "../lib/shopify-files.server";
import { sendProofValidationEmail } from "../lib/send-proof-email.server";
import { DEFAULT_CLIENT_EMAIL_MESSAGE, DEFAULT_CLIENT_EMAIL_SUBJECT } from "../lib/email-defaults";
import { applyPlaceholders } from "../lib/email-template";
import { ARTWORK_TAG, CASE_STATUSES, acceptsBat, currentProofs, snapshotPersonalization, summarizeCase } from "../lib/artwork-status";
import { ensureProductionCards, event, indexCases, invalidateProofs, metadata, readDossier, reconcileCase, searchDrafts, setArtworkTag, upsertCase } from "../lib/artwork-cases.server";
import { WORKSPACE_STYLES } from "../lib/workspace-styles";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  let syncError = null;
  try { await indexCases(admin, session.shop, url.searchParams.has("refresh")); } catch (e) { syncError = e.message; }
  const selectedId = url.searchParams.get("case");
  let selected = selectedId ? await readDossier(selectedId, session.shop) : null;
  if (selected && !selected.archivedAt) {
    try {
      const draft = await metadata(admin, selected.draftOrderId);
      if (draft) { await reconcileCase(admin, session.shop, draft); selected = await readDossier(selectedId, session.shop); }
      else syncError = "Ce devis n’existe plus dans Shopify. Les BAT restent conservés.";
    } catch (e) { syncError = e.message; }
  }
  const cases = await prisma.artworkCase.findMany({ where: { shop: session.shop }, orderBy: [{ shopifyUpdatedAt: "desc" }, { id: "desc" }] });
  const draftIds = cases.map((c) => c.draftOrderId);
  const [items, ps, settings] = await Promise.all([
    prisma.artworkItem.findMany({ where: { shop: session.shop, draftOrderId: { in: draftIds }, isActive: true } }),
    prisma.personalization.findMany({ where: { shop: session.shop, draftOrderId: { in: draftIds }, isActive: true }, include: { proofs: { where: { isCurrent: true } } } }),
    prisma.shopSettings.findUnique({ where: { shop: session.shop } }),
  ]);
  return { cases: cases.map((c) => ({ ...c, summary: summarizeCase(items.filter((i) => i.draftOrderId === c.draftOrderId), ps.filter((p) => p.draftOrderId === c.draftOrderId)), products: items.filter((i) => i.draftOrderId === c.draftOrderId).map((i) => `${i.title} ${i.variantTitle || ""} ${i.sku || ""}`).join(" ") })), selected,
    syncError, shop: session.shop, indexedAt: settings?.artworkIndexedAt,
    emailSubject: settings?.clientEmailSubject || DEFAULT_CLIENT_EMAIL_SUBJECT, emailMessage: settings?.clientEmailMessage || DEFAULT_CLIENT_EMAIL_MESSAGE };
};

const str = (fd, key) => String(fd.get(key) || "").trim();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
async function checkedPersonalization(fd, shop, dossier) {
  const p = await prisma.personalization.findFirst({ where: { id: str(fd, "personalizationId"), shop, draftOrderId: dossier.draftOrderId, isActive: true }, include: { proofs: true } });
  if (!p) throw new Error("Personnalisation introuvable. Actualise le dossier.");
  const item = await prisma.artworkItem.findUnique({ where: { shop_draftOrderId_lineItemId: { shop, draftOrderId: dossier.draftOrderId, lineItemId: p.lineItemId } } });
  if (!item?.isActive || item.requirement !== "required") throw new Error("Cet article ne nécessite pas de BAT. Modifie son suivi pour poursuivre.");
  return p;
}
function specifications(fd) {
  const type = str(fd, "type"); const quantity = Number(fd.get("quantity"));
  if (!["Broderie", "Impression", "Gravure", "Sérigraphie"].includes(type)) throw new Error("Choisis une technique de marquage.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) throw new Error("La quantité doit être un entier supérieur à zéro.");
  return { type, quantity, dimensions: str(fd, "dimensions") || null, color: str(fd, "color") || null, location: str(fd, "location") || null, customText: str(fd, "customText") || null };
}
async function proofFiles(admin, fd) {
  const files = fd.getAll("proofImages").filter((f) => f && f.size > 0);
  if (files.some((f) => !acceptsBat(f))) throw new Error("Pour un BAT, utilise un PNG, JPG, WebP ou PDF de 20 Mo maximum.");
  return Promise.all(files.map(async (file) => ({ imageUrl: await uploadFileToShopify(admin, file), mimeType: file.type, fileName: file.name })));
}
async function logoFile(admin, fd) {
  const file = fd.get("logo");
  if (!file?.size) return {};
  if (file.size > 20 * 1024 * 1024 || !/\.(png|jpe?g|webp|svg|pdf|ai|eps)$/i.test(file.name)) throw new Error("Logo : image, PDF, AI ou EPS, 20 Mo maximum.");
  return { logoUrl: await uploadFileToShopify(admin, file), logoMimeType: file.type, logoFileName: file.name };
}
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const fd = await request.formData(); const intent = str(fd, "intent");
  try {
    if (intent === "refresh-index") { await indexCases(admin, session.shop, true); return { success: true, message: "Index Shopify actualisé" }; }
    if (intent === "search-drafts") {
      const q = str(fd, "query").slice(0, 200);
      const page = await searchDrafts(admin, q, str(fd, "after") || null, 20);
      return { results: page.nodes, pageInfo: page.pageInfo, searchQuery: q };
    }
    if (intent === "add-case") {
      const id = str(fd, "draftOrderId"); const draft = await metadata(admin, id);
      if (!draft) throw new Error("Devis introuvable dans Shopify.");
      await setArtworkTag(admin, id, true);
      await upsertCase(session.shop, draft, { activate: true });
      const dossier = await reconcileCase(admin, session.shop, draft);
      await event(dossier.id, "Devis ajouté au suivi artwork.");
      return { success: true, message: "Devis ajouté au suivi", openCase: dossier.id };
    }
    const dossier = await prisma.artworkCase.findFirst({ where: { id: str(fd, "caseId"), shop: session.shop } });
    if (!dossier) throw new Error("Dossier introuvable.");
    if (intent === "archive-case" || intent === "restore-case") {
      const enabled = intent === "restore-case";
      await setArtworkTag(admin, dossier.draftOrderId, enabled);
      await prisma.artworkCase.update({ where: { id: dossier.id }, data: { archivedAt: enabled ? null : new Date() } });
      await event(dossier.id, enabled ? "Dossier réactivé." : "Dossier retiré du suivi actif. Fichiers et historique conservés.");
      return { success: true, message: enabled ? "Dossier réactivé" : "Dossier archivé" };
    }
    if (dossier.archivedAt) throw new Error("Réactive ce dossier pour le modifier.");
    if (intent === "rename-yacht") {
      await prisma.artworkCase.update({ where: { id: dossier.id }, data: { yachtName: str(fd, "yachtName") || null } });
      return { success: true, message: "Nom du yacht enregistré" };
    }
    // Reconcile against current Shopify data before accepting any specification or send action.
    const draft = await metadata(admin, dossier.draftOrderId);
    if (!draft) throw new Error("Ce devis n’existe plus dans Shopify.");
    await reconcileCase(admin, session.shop, draft);
    if (intent === "set-requirement") {
      const item = await prisma.artworkItem.findFirst({ where: { id: str(fd, "itemId"), shop: session.shop, draftOrderId: dossier.draftOrderId, isActive: true } });
      const requirement = str(fd, "requirement");
      if (!item || !["pending", "required", "none"].includes(requirement)) throw new Error("Article ou choix invalide.");
      await prisma.artworkItem.update({ where: { id: item.id }, data: { requirement } });
      await event(dossier.id, `${item.title} : ${requirement === "required" ? "BAT requis" : requirement === "none" ? "sans BAT requis" : "à qualifier"}.`);
      await ensureProductionCards(session.shop, dossier.draftOrderId);
      return { success: true, message: "Article mis à jour" };
    }
    if (intent === "save-personalization") {
      const specs = specifications(fd);
      const existing = str(fd, "personalizationId") ? await checkedPersonalization(fd, session.shop, dossier) : null;
      const item = await prisma.artworkItem.findFirst({ where: { shop: session.shop, draftOrderId: dossier.draftOrderId, lineItemId: existing?.lineItemId || str(fd, "lineItemId"), isActive: true } });
      if (!item || item.requirement !== "required") throw new Error("Sélectionne d’abord « BAT requis » pour cet article.");
      if (specs.quantity > item.quantity) throw new Error(`La quantité personnalisée ne peut pas dépasser ${item.quantity}, quantité du devis.`);
      const uploads = await proofFiles(admin, fd); const logo = await logoFile(admin, fd);
      const reuseId = str(fd, "reuseId");
      if (!logo.logoUrl && reuseId) {
        const source = await prisma.personalization.findFirst({ where: { id: reuseId, shop: session.shop, draftOrderId: dossier.draftOrderId, isActive: true } });
        if (source) Object.assign(logo, { logoUrl: source.logoUrl, logoMimeType: source.logoMimeType, logoFileName: source.logoFileName });
      }
      await prisma.$transaction(async (tx) => {
        const p = existing ? await tx.personalization.update({ where: { id: existing.id }, data: { ...specs, ...logo } }) : await tx.personalization.create({ data: { shop: session.shop, draftOrderId: dossier.draftOrderId, lineItemId: item.lineItemId, variantId: item.variantId, sourceQuantity: item.quantity, productTitle: item.title, ...specs, ...logo } });
        if (existing && ["type", "quantity", "dimensions", "color", "location", "customText", "logoUrl"].some((k) => p[k] !== existing[k])) {
          await invalidateProofs(tx, p, dossier.id, `Caractéristiques modifiées : ${p.productTitle}.`);
        }
        for (const upload of uploads) await tx.proof.create({ data: { personalizationId: p.id, ...upload, snapshot: snapshotPersonalization(p) } });
        await event(dossier.id, `${existing ? "Personnalisation modifiée" : "Personnalisation préparée"} : ${p.productTitle}${uploads.length ? `, ${uploads.length} BAT enregistré(s)` : ""}.`, "Équipe", tx);
      });
      await ensureProductionCards(session.shop, dossier.draftOrderId);
      return { success: true, message: "Personnalisation et fichiers enregistrés" };
    }
    if (intent === "copy-personalization") {
      const source = await checkedPersonalization(fd, session.shop, dossier);
      const ids = fd.getAll("targetItemId").map(String);
      const targets = await prisma.artworkItem.findMany({ where: { id: { in: ids }, shop: session.shop, draftOrderId: dossier.draftOrderId, isActive: true, requirement: "required", NOT: { lineItemId: source.lineItemId } } });
      if (!targets.length) throw new Error("Choisis au moins un autre article avec BAT requis.");
      await prisma.$transaction(async (tx) => {
        for (const target of targets) await tx.personalization.create({ data: { shop: session.shop, draftOrderId: dossier.draftOrderId, lineItemId: target.lineItemId, variantId: target.variantId, sourceQuantity: target.quantity, productTitle: target.title, quantity: target.quantity, type: source.type, dimensions: source.dimensions, color: source.color, location: source.location, customText: source.customText, logoUrl: source.logoUrl, logoMimeType: source.logoMimeType, logoFileName: source.logoFileName } });
        await event(dossier.id, `Paramètres et logo copiés sur ${targets.length} article(s). Chaque BAT reste à préparer.`, "Équipe", tx);
      });
      await ensureProductionCards(session.shop, dossier.draftOrderId);
      return { success: true, message: "Paramètres copiés. Ajoute les BAT de chaque article." };
    }
    if (intent === "add-proofs" || intent === "revise-proof") {
      const p = await checkedPersonalization(fd, session.shop, dossier); const uploads = await proofFiles(admin, fd);
      if (!uploads.length) throw new Error("Choisis un BAT image ou PDF.");
      const old = intent === "revise-proof" ? p.proofs.find((proof) => proof.id === str(fd, "proofId") && proof.isCurrent) : null;
      if (intent === "revise-proof" && (!old || uploads.length !== 1)) throw new Error("Choisis un seul fichier pour remplacer ce BAT.");
      await prisma.$transaction(async (tx) => {
        if (old) { const retired = await tx.proof.updateMany({ where: { id: old.id, isCurrent: true }, data: { isCurrent: false } }); if (!retired.count) throw new Error("Ce BAT a déjà été remplacé. Actualise le dossier."); }
        for (const upload of uploads) await tx.proof.create({ data: { personalizationId: p.id, ...upload, snapshot: snapshotPersonalization(p), version: old ? old.version + 1 : 1, supersedesId: old?.id || null } });
        await event(dossier.id, `${old ? `BAT V${old.version + 1}` : "BAT"} enregistré : ${p.productTitle}. À envoyer au client.`, "Équipe", tx);
      });
      return { success: true, message: "BAT enregistré. Il reste à l’envoyer au client." };
    }
    if (intent === "manual-approve") {
      const p = await checkedPersonalization(fd, session.shop, dossier); const proof = p.proofs.find((x) => x.id === str(fd, "proofId") && x.isCurrent && x.status === "en_attente");
      const via = str(fd, "approvedVia");
      if (!proof || !["Email", "WhatsApp", "Téléphone"].includes(via)) throw new Error("Choisis le canal de validation du BAT actuel.");
      await prisma.$transaction(async (tx) => {
        const approved = await tx.proof.updateMany({ where: { id: proof.id, isCurrent: true, status: "en_attente" }, data: { status: "approuve", reponduLe: new Date(), approvedVia: via } });
        if (!approved.count) throw new Error("Ce BAT a changé. Actualise le dossier avant de le valider.");
        await event(dossier.id, `BAT V${proof.version} validé par ${via} : ${p.productTitle}.`, "Équipe", tx);
      });
      return { success: true, message: "Validation enregistrée" };
    }
    if (intent === "send-for-validation") {
      const customerEmail = str(fd, "customerEmail"); const mode = str(fd, "sendMode");
      if (!validEmail(customerEmail)) throw new Error("Indique une adresse email valide.");
      const live = await readDossier(dossier.id, session.shop);
      const summary = summarizeCase(live.items, live.personalizations);
      if (summary.pendingQualification || summary.missing) throw new Error("Qualifie tous les articles et prépare les BAT requis avant l’envoi.");
      const requiredIds = live.items.filter((i) => i.requirement === "required").map((i) => i.lineItemId);
      const pending = live.personalizations.filter((p) => requiredIds.includes(p.lineItemId)).flatMap((p) => currentProofs(p).filter((proof) => proof.status === "en_attente" && (mode === "reminder" ? proof.envoyeLe : !proof.envoyeLe)).map((proof) => ({ ...proof, personalization: p })));
      if (!pending.length) throw new Error(mode === "reminder" ? "Aucun BAT à relancer." : "Aucun nouveau BAT à envoyer.");
      // Ensure the user reviewed exactly the versions that will be sent, even if Shopify changed in another tab.
      const expected = str(fd, "proofIds").split(",").filter(Boolean).sort().join(",");
      if (expected !== pending.map((p) => p.id).sort().join(",")) throw new Error("Le dossier a changé. Vérifie les nouvelles versions avant de confirmer l’envoi.");
      const settings = await prisma.shopSettings.findUnique({ where: { shop: session.shop } });
      // eslint-disable-next-line no-undef
      const reviewUrl = `${process.env.SHOPIFY_APP_URL}/proof-review?tokens=${pending.map((p) => p.token).join(",")}`;
      await sendProofValidationEmail({ to: customerEmail, orderName: `${dossier.name}${dossier.yachtName ? ` / ${dossier.yachtName}` : ""}`, items: pending.map((p) => `${p.personalization.productTitle}, BAT V${p.version}`), reviewUrl, subjectTemplate: settings?.clientEmailSubject, messageTemplate: settings?.clientEmailMessage });
      await prisma.$transaction(async (tx) => {
        await tx.proof.updateMany({ where: { id: { in: pending.map((p) => p.id) }, isCurrent: true, status: "en_attente" }, data: { envoyeLe: new Date() } });
        await event(dossier.id, `${mode === "reminder" ? "Relance" : "Envoi"} à ${customerEmail} : ${pending.length} BAT.`, "Équipe", tx);
      });
      return { success: true, message: mode === "reminder" ? "Relance envoyée" : "BAT envoyés au client" };
    }
    throw new Error("Action inconnue.");
  } catch (e) { return { success: false, error: e.message }; }
};

const DirtyContext = createContext((...args) => { void args; });
export function WorkflowForm({ intent, caseId = null, children = null, label = "Enregistrer", onDone = null, confirm = null, className = "", onInput = null }) {
  const fetcher = useFetcher(); const app = useAppBridge(); const id = useId(); const markDirty = useContext(DirtyContext); const ref = useRef(null);
  useEffect(() => () => markDirty(id, false), [id, markDirty]);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) { markDirty(id, false); if (ref.current) delete ref.current.dataset.workflowDirty; app.toast.show(fetcher.data.message || "Enregistré"); onDone?.(fetcher.data); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state]);
  return <fetcher.Form ref={ref} method="post" encType="multipart/form-data" className={`aw-form ${className}`} onChange={(e) => { markDirty(id, true); ref.current.dataset.workflowDirty = "true"; onInput?.(e); }} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
    <input type="hidden" name="intent" value={intent}/><input type="hidden" name="caseId" value={caseId || ""}/>
    <fieldset disabled={fetcher.state !== "idle"}>{children}
      {fetcher.data?.error && <p className="aw-error" role="alert">{fetcher.data.error}</p>}
      <button className="aw-button primary" type="submit">{fetcher.state !== "idle" ? "En cours…" : label}</button>
    </fieldset>
  </fetcher.Form>;
}
const date = (value) => value ? new Date(value).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" }) : "Synchronisation à venir";
const Badge = ({ status }) => <span className="aw-badge" style={{ color: CASE_STATUSES[status]?.color }}>{CASE_STATUSES[status]?.label}</span>;
function AddCase({ onClose, onOpen }) {
  const fetcher = useFetcher(); const [q, setQ] = useState("");
  return <section className="aw-panel"><div className="aw-between"><h2>Ajouter un devis Shopify</h2><button className="aw-button" onClick={onClose}>Fermer</button></div>
    <p>Le tag <strong>{ARTWORK_TAG}</strong> sera ajouté au devis. Tu peux aussi l’ajouter directement dans Shopify.</p>
    <fetcher.Form method="post" className="aw-toolbar"><input type="hidden" name="intent" value="search-drafts"/><label className="aw-grow">Rechercher dans Shopify<input name="query" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Numéro, nom ou email"/></label><button className="aw-button primary" disabled={fetcher.state !== "idle"}>Rechercher</button></fetcher.Form>
    {fetcher.data?.error && <p role="alert" className="aw-error">{fetcher.data.error}</p>}
    {fetcher.data?.results?.map((r) => <div key={r.id} className="aw-search-result"><div><strong>{r.name}</strong><p>{[r.shippingAddress?.firstName || r.billingAddress?.firstName, r.shippingAddress?.lastName || r.billingAddress?.lastName].filter(Boolean).join(" ") || r.email || "Client non renseigné"} · {r.shippingAddress?.company || ""}</p><small>Modifié le {date(r.updatedAt)}</small></div>
      <WorkflowForm intent="add-case" label="Ajouter au suivi" onDone={(data) => onOpen(data.openCase)}><input type="hidden" name="draftOrderId" value={r.id}/></WorkflowForm></div>)}
    {fetcher.data?.results?.length === 0 && <p>Aucun devis trouvé. Essaie le numéro ou l’email du client.</p>}
    {fetcher.data?.pageInfo?.hasNextPage && <fetcher.Form method="post"><input type="hidden" name="intent" value="search-drafts"/><input type="hidden" name="query" value={fetcher.data.searchQuery || ""}/><input type="hidden" name="after" value={fetcher.data.pageInfo.endCursor}/><button className="aw-button">Résultats suivants</button></fetcher.Form>}
  </section>;
}
function PersonalizationEditor({ dossier, item, p = null, onClose }) {
  const [reuse, setReuse] = useState(null); const source = reuse || p;
  return <section className="aw-editor"><div className="aw-between"><h3>{p ? "Modifier la personnalisation" : "Préparer une personnalisation"}</h3><button className="aw-button" onClick={() => { if (window.confirm("Fermer ce formulaire ? Les changements non enregistrés seront perdus.")) onClose(); }}>Fermer</button></div>
    {!p && dossier.personalizations.some((row) => row.logoUrl) && <label>Réutiliser un logo et des paramètres<select value={reuse?.id || ""} onChange={(e) => setReuse(dossier.personalizations.find((row) => row.id === e.target.value) || null)}><option value="">Nouvelle personnalisation</option>{dossier.personalizations.filter((row) => row.logoUrl).map((row) => <option key={row.id} value={row.id}>{row.productTitle} · {row.type} · {row.location}</option>)}</select></label>}
    <WorkflowForm key={reuse?.id || p?.id || "new"} intent="save-personalization" caseId={dossier.id} label="Enregistrer la personnalisation et les fichiers" onDone={onClose}>
      <input type="hidden" name="personalizationId" value={p?.id || ""}/><input type="hidden" name="lineItemId" value={item.lineItemId}/><input type="hidden" name="reuseId" value={reuse?.id || ""}/>
      <div className="aw-grid"><label>Technique<select name="type" defaultValue={source?.type || "Broderie"}>{["Broderie", "Impression", "Gravure", "Sérigraphie"].map((t) => <option key={t}>{t}</option>)}</select></label>
        <label>Quantité personnalisée<input type="number" name="quantity" min="1" max={item.quantity} required defaultValue={p?.quantity || item.quantity}/></label>
        <label>Dimensions du marquage<input name="dimensions" placeholder="Ex. largeur 80 mm × hauteur 35 mm" defaultValue={source?.dimensions || ""}/></label>
        <label>Couleur du marquage<input name="color" placeholder="Ex. bleu marine, fil Madeira 1243" defaultValue={source?.color || ""}/></label>
        <label>Emplacement<select name="location" defaultValue={source?.location || "Poitrine gauche"}>{["Poitrine gauche", "Poitrine droite", "Manche", "Dos", "Autre"].map((v) => <option key={v}>{v}</option>)}</select></label>
        <label>Texte à personnaliser<input name="customText" defaultValue={source?.customText || ""}/></label></div>
      {p?.size && <p className="aw-muted">Ancienne information taille / dimensions : {p.size}</p>}
      <label>Logo source <small>Image, PDF, AI ou EPS, 20 Mo maximum. {source?.logoUrl ? "Logo existant conservé si aucun fichier n’est choisi." : ""}</small><input type="file" name="logo" accept="image/*,.pdf,.ai,.eps"/></label>
      <label>Ajouter des BAT à valider <small>PNG, JPG, WebP ou PDF, 20 Mo maximum par fichier. Tu peux les ajouter plus tard.</small><input type="file" name="proofImages" accept="image/png,image/jpeg,image/webp,application/pdf" multiple/></label>
      {p && <p className="aw-notice">Une modification des caractéristiques crée une nouvelle version des BAT. L’ancienne validation reste dans l’historique.</p>}
    </WorkflowForm>
  </section>;
}
function ProofView({ proof, p, caseId, readOnly }) {
  const [mode, setMode] = useState(null); const pdf = proof.mimeType === "application/pdf" || /\.pdf(?:\?|$)/i.test(proof.imageUrl);
  return <article className={`aw-proof ${!proof.isCurrent ? "historic" : ""}`}>
    <div className="aw-between"><strong>BAT V{proof.version}{!proof.isCurrent ? " · historique" : ""}</strong><span className="aw-badge">{proof.status === "approuve" ? "Validé" : proof.status === "modification_demandee" ? "À corriger" : proof.envoyeLe ? "En attente du client" : "À envoyer"}</span></div>
    <a href={proof.imageUrl} target="_blank" rel="noreferrer" className="aw-proof-preview">{pdf ? <span>Ouvrir le BAT PDF ↗</span> : <img src={proof.imageUrl} alt={`BAT V${proof.version} de ${p.productTitle}`} loading="lazy"/>}</a>
    <p className="aw-muted">{proof.fileName || "Fichier BAT"}</p>{proof.snapshot && !proof.isCurrent && <details><summary>Caractéristiques de cette version</summary><p>{[proof.snapshot.productTitle, proof.snapshot.type, `${proof.snapshot.quantity} pièce(s)`, proof.snapshot.dimensions || proof.snapshot.size, proof.snapshot.color, proof.snapshot.location, proof.snapshot.customText].filter(Boolean).join(" · ")}</p></details>}{proof.commentaireClient && <blockquote>{proof.commentaireClient}</blockquote>}
    {proof.envoyeLe && <small>Dernier envoi : {date(proof.envoyeLe)}</small>}{proof.reponduLe && <small>Réponse : {date(proof.reponduLe)}{proof.approvedVia ? ` · ${proof.approvedVia}` : ""}</small>}
    {!readOnly && proof.isCurrent && <div className="aw-toolbar"><button className="aw-button" onClick={() => setMode(mode === "revise" ? null : "revise")}>Nouvelle version</button>{proof.status === "en_attente" && <button className="aw-button" onClick={() => setMode(mode === "approve" ? null : "approve")}>Validation reçue ailleurs</button>}</div>}
    {mode && <WorkflowForm intent={mode === "revise" ? "revise-proof" : "manual-approve"} caseId={caseId} label={mode === "revise" ? "Enregistrer la nouvelle version" : "Enregistrer la validation"} onDone={() => setMode(null)} confirm={mode === "approve" ? "Confirmer que le client a validé cette version du BAT ?" : undefined}>
      <input type="hidden" name="personalizationId" value={p.id}/><input type="hidden" name="proofId" value={proof.id}/>
      {mode === "revise" ? <label>Nouveau BAT<input required type="file" name="proofImages" accept="image/png,image/jpeg,image/webp,application/pdf"/></label> : <label>Canal de validation<select name="approvedVia" required><option value="">Choisir</option><option>Email</option><option>WhatsApp</option><option>Téléphone</option></select></label>}
    </WorkflowForm>}
  </article>;
}
function PersonalizationView({ p, dossier, item }) {
  const [editing, setEditing] = useState(false); const [copy, setCopy] = useState(false);
  const current = currentProofs(p); const history = p.proofs.filter((pr) => !pr.isCurrent);
  return <section className="aw-personalization"><div className="aw-between"><h3>{p.type} · {p.quantity} pièce(s)</h3>{!dossier.archivedAt && item.requirement === "required" && <div className="aw-toolbar"><button className="aw-button" onClick={() => { if (editing && document.querySelector('[data-workflow-dirty="true"]') && !window.confirm("Fermer sans enregistrer les modifications ?")) return; setEditing(!editing); }}>Modifier</button><button className="aw-button" onClick={() => setCopy(!copy)}>Copier sur des articles</button></div>}</div>
    <p>{[p.dimensions, p.color, p.location, p.customText].filter(Boolean).join(" · ") || "Caractéristiques à compléter"}</p>
    {p.logoUrl && <a href={p.logoUrl} target="_blank" rel="noreferrer">Ouvrir le logo source ↗</a>}
    {editing && <PersonalizationEditor dossier={dossier} item={item} p={p} onClose={() => setEditing(false)}/>}
    {copy && <WorkflowForm intent="copy-personalization" caseId={dossier.id} label="Copier les paramètres et le logo" onDone={() => setCopy(false)}><input type="hidden" name="personalizationId" value={p.id}/><p>Les BAT et les validations ne sont pas copiés.</p>{dossier.items.filter((i) => i.requirement === "required" && i.lineItemId !== p.lineItemId).map((i) => <label className="aw-check" key={i.id}><input type="checkbox" name="targetItemId" value={i.id}/>{i.title} · {i.variantTitle} · {i.quantity} pièce(s)</label>)}</WorkflowForm>}
    {!current.length && <p className="aw-notice">Aucun BAT préparé. Ce marquage ne peut pas encore être validé.</p>}
    <div className="aw-proof-grid">{current.map((proof) => <ProofView key={proof.id} proof={proof} p={p} caseId={dossier.id} readOnly={Boolean(dossier.archivedAt) || item.requirement !== "required"}/>)}</div>
    {!dossier.archivedAt && item.requirement === "required" && <details><summary>Ajouter un BAT / une vue supplémentaire</summary><WorkflowForm intent="add-proofs" caseId={dossier.id} label="Enregistrer les BAT"><input type="hidden" name="personalizationId" value={p.id}/><label>BAT image ou PDF<input type="file" name="proofImages" required accept="image/png,image/jpeg,image/webp,application/pdf" multiple/></label></WorkflowForm></details>}
    {history.length > 0 && <details><summary>Historique des versions ({history.length})</summary><div className="aw-proof-grid">{history.map((proof) => <ProofView key={proof.id} proof={proof} p={p} caseId={dossier.id} readOnly/>)}</div></details>}
  </section>;
}
function SendPreview({ dossier, mode, subject, message }) {
  const [open, setOpen] = useState(false);
  const requiredIds = dossier.items.filter((i) => i.requirement === "required").map((i) => i.lineItemId);
  const proofs = dossier.personalizations.filter((p) => requiredIds.includes(p.lineItemId)).flatMap((p) => currentProofs(p).filter((proof) => proof.status === "en_attente" && (mode === "reminder" ? proof.envoyeLe : !proof.envoyeLe)).map((proof) => ({ ...proof, productTitle: p.productTitle })));
  if (!proofs.length) return null;
  const summary = summarizeCase(dossier.items, dossier.personalizations); const blocked = summary.missing || summary.pendingQualification;
  const name = `${dossier.name}${dossier.yachtName ? ` / ${dossier.yachtName}` : ""}`;
  return <section><button className={`aw-button ${mode === "reminder" ? "" : "primary"}`} disabled={blocked} onClick={() => setOpen(!open)}>{mode === "reminder" ? "Relancer le client" : `Envoyer ${proofs.length} BAT au client`}</button>
    {blocked && <small className="aw-muted">Qualifie les articles et prépare tous les BAT requis avant l’envoi.</small>}
    {open && <div className="aw-editor"><h3>{mode === "reminder" ? "Vérifier la relance" : "Vérifier l’envoi"}</h3><WorkflowForm intent="send-for-validation" caseId={dossier.id} label={mode === "reminder" ? "Confirmer la relance" : "Confirmer l’envoi"} onDone={() => setOpen(false)}>
      <input type="hidden" name="sendMode" value={mode}/><input type="hidden" name="proofIds" value={proofs.map((p) => p.id).join(",")}/>
      <label>Destinataire<input type="email" name="customerEmail" defaultValue={dossier.email || ""} required/></label>
      <strong>BAT inclus</strong><ul>{proofs.map((p) => <li key={p.id}><a href={p.imageUrl} target="_blank" rel="noreferrer">{p.productTitle}, V{p.version}</a>{p.envoyeLe ? ` · envoyé le ${date(p.envoyeLe)}` : " · nouvel envoi"}</li>)}</ul>
      <div className="aw-email-preview"><strong>{applyPlaceholders(subject, { orderName: name })}</strong><p>{applyPlaceholders(message, { orderName: name })}</p><p>Review my designs</p></div>
    </WorkflowForm></div>}
  </section>;
}
function DossierView({ dossier, shop, emailSubject, emailMessage }) {
  const [tab, setTab] = useState("articles"); const [editor, setEditor] = useState(null); const summary = summarizeCase(dossier.items, dossier.personalizations);
  const changeTab = (next) => { if (next !== tab && document.querySelector('[data-workflow-dirty="true"]') && !window.confirm("Changer d’onglet sans enregistrer les modifications ?")) return; setTab(next); };
  const hasPending = dossier.items.some((i) => i.requirement === "pending");
  return <>
    <header className="aw-panel"><div className="aw-between"><div><h1>{dossier.yachtName || dossier.customerName || "Dossier artwork"}</h1><p>{dossier.name} · {dossier.customerName || dossier.email || "Client non renseigné"}</p><Badge status={summary.status}/></div><a className="aw-button" href={`https://${shop}/admin/draft_orders/${dossier.draftOrderId.split("/").pop()}`} target="_blank" rel="noreferrer">Ouvrir dans Shopify ↗</a></div>
      <p className="aw-muted">Dernière modification Shopify : {date(dossier.shopifyUpdatedAt)} · Synchronisé : {date(dossier.syncedAt)}</p>
      <div className="aw-toolbar"><strong>{summary.approved} BAT validé(s) sur {summary.total}</strong><span>{summary.required} article(s) avec BAT requis</span>{dossier.orderId && <span className="aw-badge">Commande {dossier.orderName}</span>}</div>
      {dossier.archivedAt ? <div className="aw-notice"><p>Dossier archivé. Les fichiers et l’historique sont conservés.</p><WorkflowForm caseId={dossier.id} intent="restore-case" label="Réactiver le dossier"/></div> : <><div className="aw-toolbar"><SendPreview dossier={dossier} mode="new" subject={emailSubject} message={emailMessage}/><SendPreview dossier={dossier} mode="reminder" subject={emailSubject} message={emailMessage}/></div><details><summary>Informations et actions du dossier</summary><WorkflowForm intent="rename-yacht" caseId={dossier.id} label="Enregistrer le nom"><label>Nom du yacht<input name="yachtName" defaultValue={dossier.yachtName || ""}/></label></WorkflowForm><WorkflowForm intent="archive-case" caseId={dossier.id} label="Retirer du suivi artwork" confirm="Retirer ce devis du suivi actif ? Ses fichiers et son historique seront conservés."/></details></>}
    </header>
    <nav className="aw-tabs" aria-label="Sections du dossier"><button className={tab === "articles" ? "active" : ""} onClick={() => changeTab("articles")}>Articles et BAT</button><button className={tab === "history" ? "active" : ""} onClick={() => changeTab("history")}>Historique ({dossier.events.length})</button></nav>
    {tab === "history" ? <section className="aw-panel"><h2>Historique du dossier</h2>{dossier.removedPersonalizations?.length > 0 && <details><summary>BAT d’articles retirés du devis ({dossier.removedPersonalizations.length})</summary>{dossier.removedPersonalizations.map((p) => <section key={p.id}><h3>{p.productTitle} · article retiré ou à vérifier</h3><div className="aw-proof-grid">{p.proofs.map((proof) => <ProofView key={proof.id} proof={proof} p={p} caseId={dossier.id} readOnly/>)}</div></section>)}</details>}{dossier.events.length ? <ol className="aw-timeline">{dossier.events.map((e) => <li key={e.id}><strong>{e.message}</strong><small>{date(e.createdAt)} · {e.actor}</small></li>)}</ol> : <p>Les nouveaux événements apparaîtront ici. Les anciens BAT sont conservés dans chaque article.</p>}</section> : <>
      {hasPending && <p className="aw-notice">Pour chaque article « À qualifier », choisis s’il nécessite un BAT. Les articles sans BAT ne bloqueront pas la validation.</p>}
      {dossier.items.map((item) => <section key={item.id} className="aw-panel"><div className="aw-between"><div><h2>{item.title}</h2><p className="aw-muted">Variante / taille du vêtement : {item.variantTitle || "Non renseignée"} · Quantité Shopify : {item.quantity}{item.sku ? ` · Réf. ${item.sku}` : ""}</p></div><span className="aw-badge">{item.requirement === "required" ? "BAT requis" : item.requirement === "none" ? "Sans BAT requis" : "À qualifier"}</span></div>
        {!dossier.archivedAt && <WorkflowForm intent="set-requirement" caseId={dossier.id} label="Appliquer" className="aw-inline-form"><input type="hidden" name="itemId" value={item.id}/><label>Suivi de cet article<select key={item.requirement} name="requirement" defaultValue={item.requirement}><option value="pending">À qualifier</option><option value="required">BAT requis</option><option value="none">Sans BAT requis</option></select></label></WorkflowForm>}
        {item.requirement !== "required" && <p className="aw-muted">{item.requirement === "none" ? "Cet article n’entre pas dans la validation des BAT." : "Décide si cet article nécessite un artwork."}</p>}
        {dossier.personalizations.filter((p) => p.lineItemId === item.lineItemId).map((p) => <PersonalizationView key={p.id} p={p} item={item} dossier={dossier}/>)}
        {item.requirement === "required" && !dossier.archivedAt && <button className="aw-button" onClick={() => setEditor(item.id)}>Ajouter une personnalisation</button>}
        {editor === item.id && <PersonalizationEditor dossier={dossier} item={item} onClose={() => setEditor(null)}/>}
      </section>)}
    </>}
  </>;
}
export default function Personnalisation() {
  const data = useLoaderData(); const navigate = useNavigate(); const navigation = useNavigation(); const revalidator = useRevalidator(); const [add, setAdd] = useState(false);
  const [dirty, setDirty] = useState({}); const dirtyRef = useRef({});
  const markDirty = useRef((id, value) => { if (Boolean(dirtyRef.current[id]) === value) return; dirtyRef.current = { ...dirtyRef.current, [id]: value }; setDirty(dirtyRef.current); }).current;
  const hasDirty = Object.values(dirty).some(Boolean);
  const blocker = useBlocker(hasDirty);
  useEffect(() => { if (blocker.state === "blocked") { if (window.confirm("Quitter ce dossier et perdre les modifications non enregistrées ?")) { dirtyRef.current = {}; setDirty({}); blocker.proceed(); } else blocker.reset(); } }, [blocker]);
  useEffect(() => { const before = (e) => { if (Object.values(dirtyRef.current).some(Boolean)) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", before); return () => window.removeEventListener("beforeunload", before); }, []);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && !Object.values(dirtyRef.current).some(Boolean) && navigation.state === "idle" && revalidator.state === "idle") revalidator.revalidate(); };
    window.addEventListener("focus", refresh); const interval = setInterval(refresh, 45000); return () => { window.removeEventListener("focus", refresh); clearInterval(interval); };
  }, [navigation.state, revalidator]);
  const location = useLocation(); const url = new URL(location.pathname + location.search, "https://app.local"); const filter = url.searchParams.get("status") || "all"; const q = url.searchParams.get("q") || ""; const archive = url.searchParams.get("archived") === "1";
  const [query, setQuery] = useState(q); const [page, setPage] = useState(1);
  const update = (key, value) => { const params = new URLSearchParams(url.search); value ? params.set(key, value) : params.delete(key); params.delete("case"); setPage(1); navigate(`?${params}`, { preventScrollReset: true }); };
  const open = (id) => { const params = new URLSearchParams(url.search); params.set("case", id); setAdd(false); navigate(`?${params}`); };
  const active = data.cases.filter((c) => Boolean(c.archivedAt) === archive);
  const matching = active.filter((c) => `${c.name} ${c.customerName || ""} ${c.yachtName || ""} ${c.email || ""} ${c.products}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
  const visible = matching.filter((c) => filter === "all" || c.summary.status === filter);
  const attention = active.filter((c) => c.summary.status === "a_corriger");
  return <DirtyContext.Provider value={markDirty}><s-page heading={data.selected ? "Dossier artwork" : "Dossiers artwork"}><style>{WORKSPACE_STYLES}</style><main className="aw-workspace">
    {data.syncError && <p role="alert" className="aw-error">{data.syncError} Les dernières données connues sont affichées.</p>}
    {data.selected ? <><Link className="aw-back" to={`?${new URLSearchParams([...url.searchParams].filter(([k]) => k !== "case"))}`}>← Retour aux dossiers</Link><DossierView key={data.selected.id} dossier={data.selected} shop={data.shop} emailSubject={data.emailSubject} emailMessage={data.emailMessage}/></> : <>
      <header className="aw-between"><div><h1>Dossiers artwork</h1><p className="aw-muted">Uniquement les devis nécessitant un BAT. Derniers devis modifiés en premier.</p></div><button className="aw-button primary" onClick={() => setAdd(!add)}>Ajouter un devis Shopify</button></header>
      {add && <AddCase onClose={() => setAdd(false)} onOpen={open}/>}
      {attention.length > 0 && !archive && <div className="aw-notice"><strong>Actions prioritaires : {attention.length} dossier(s) à corriger</strong><button className="aw-button" onClick={() => update("status", "a_corriger")}>Voir les corrections</button></div>}
      <section className="aw-panel"><div className="aw-toolbar"><form className="aw-toolbar aw-grow" onSubmit={(e) => { e.preventDefault(); update("q", query); }}><label className="aw-grow">Rechercher un dossier<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Devis, client, yacht, produit ou référence"/></label><button className="aw-button">Rechercher</button></form><WorkflowForm intent="refresh-index" label="Actualiser Shopify"/></div>
        <div className="aw-filters"><button className={filter === "all" ? "active" : ""} onClick={() => update("status", "")}>Tous ({matching.length})</button>{Object.entries(CASE_STATUSES).map(([key, meta]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => update("status", key)}>{meta.label} ({matching.filter((c) => c.summary.status === key).length})</button>)}<button onClick={() => update("archived", archive ? "" : "1")}>{archive ? "Voir les actifs" : "Archives"}</button></div>
        <p className="aw-muted">{visible.length} dossier(s){archive ? " archivé(s)" : " actif(s)"} · Index Shopify : {date(data.indexedAt)}</p>
        {!visible.length ? <div className="aw-empty"><h2>{q || filter !== "all" ? "Aucun dossier ne correspond" : "Aucun dossier artwork"}</h2><p>{q || filter !== "all" ? "Essaie un autre filtre ou une autre recherche." : `Ajoute un devis ici ou utilise le tag ${ARTWORK_TAG} dans Shopify.`}</p></div> : <div className="aw-table-wrap"><table className="aw-table"><thead><tr><th>Devis / client</th><th>Avancement</th><th>Modification Shopify</th><th>Action</th></tr></thead><tbody>{visible.slice(0, page * 30).map((c) => <tr key={c.id}><td><button className="aw-name" onClick={() => open(c.id)}>{c.yachtName || c.customerName || c.name}</button><small>{c.name} · {c.customerName || c.email || "Client non renseigné"}</small></td><td><Badge status={c.summary.status}/><small>{c.summary.approved} / {c.summary.total} BAT validé(s){c.summary.pendingQualification ? " · articles à qualifier" : ""}</small></td><td>{date(c.shopifyUpdatedAt)}</td><td><button className="aw-button" onClick={() => open(c.id)}>{CASE_STATUSES[c.summary.status].action}</button></td></tr>)}</tbody></table></div>}
        {visible.length > page * 30 && <button className="aw-button" onClick={() => setPage(page + 1)}>Afficher 30 dossiers supplémentaires</button>}
      </section>
    </>}
  </main></s-page></DirtyContext.Provider>;
}
