/* eslint-disable react/prop-types */
import { useEffect, useState } from "react";
import { Link, useBlocker, useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { sendKanbanCardEmail } from "../lib/send-kanban-card-email.server";
import { currentProofs, fileExtension, isPersonalizationApproved, summarizeCase } from "../lib/artwork-status";
import { event, metadata, readDossier, reconcileCase } from "../lib/artwork-cases.server";
import { WORKSPACE_STYLES } from "../lib/workspace-styles";
const COLUMNS = [{ key: "a_faire", label: "À faire" }, { key: "en_cours", label: "En cours" }, { key: "termine", label: "Terminé" }];
const TYPES = ["Broderie", "Impression", "Gravure", "Sérigraphie"];
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [cards, personalizations, dossiers, items, partners] = await Promise.all([
    prisma.kanbanCard.findMany({ where: { shop: session.shop }, orderBy: { createdAt: "asc" } }),
    prisma.personalization.findMany({ where: { shop: session.shop, isActive: true }, include: { proofs: { where: { isCurrent: true }, orderBy: { createdAt: "desc" } } } }),
    prisma.artworkCase.findMany({ where: { shop: session.shop, archivedAt: null } }),
    prisma.artworkItem.findMany({ where: { shop: session.shop, isActive: true } }),
    prisma.partnerEmail.findMany({ where: { shop: session.shop } }),
  ]);
  return { rows: cards.flatMap((card) => {
    const p = personalizations.find((p) => p.id === card.personalizationId);
    const dossier = dossiers.find((d) => d.draftOrderId === card.draftOrderId);
    const item = items.find((i) => i.lineItemId === p?.lineItemId && i.draftOrderId === card.draftOrderId);
    const summary = dossier && summarizeCase(items.filter((i) => i.draftOrderId === dossier.draftOrderId), personalizations.filter((p) => p.draftOrderId === dossier.draftOrderId));
    return p && dossier && item?.requirement === "required" ? [{ card, p, dossier, blocked: summary.status !== "valide" || !isPersonalizationApproved(p) || !dossier.orderId }] : [];
  }), partners: Object.fromEntries(partners.map((p) => [p.type, p.email])) };
};
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request); const fd = await request.formData(); const intent = fd.get("intent");
  try {
    const card = await prisma.kanbanCard.findFirst({ where: { id: String(fd.get("cardId") || ""), shop: session.shop } });
    if (!card) throw new Error("Travail de production introuvable.");
    let dossier = await prisma.artworkCase.findUnique({ where: { shop_draftOrderId: { shop: session.shop, draftOrderId: card.draftOrderId } } });
    if (!dossier || dossier.archivedAt) throw new Error("Ce dossier est archivé. Réactive-le avant de poursuivre.");
    const draft = await metadata(admin, card.draftOrderId);
    if (!draft) throw new Error("Le devis Shopify n’est plus disponible. La production est bloquée.");
    await reconcileCase(admin, session.shop, draft);
    dossier = await prisma.artworkCase.findUnique({ where: { id: dossier.id } });
    const p = await prisma.personalization.findFirst({ where: { id: card.personalizationId, shop: session.shop, isActive: true }, include: { proofs: { where: { isCurrent: true }, orderBy: { createdAt: "desc" } } } });
    const item = p && await prisma.artworkItem.findUnique({ where: { shop_draftOrderId_lineItemId: { shop: session.shop, draftOrderId: card.draftOrderId, lineItemId: p.lineItemId } } });
    if (!p || !item?.isActive || item.requirement !== "required") throw new Error("Cet article ne fait plus partie des travaux à produire.");
    const live = await readDossier(dossier.id, session.shop);
    const ready = summarizeCase(live.items, live.personalizations).status === "valide" && isPersonalizationApproved(p) && Boolean(dossier.orderId);
    if (intent === "email-card") {
      if (!ready) throw new Error("Qualifie tous les articles et valide tous les BAT actuels du dossier avant de transmettre au partenaire.");
      const email = String(fd.get("partnerEmail") || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Indique une adresse email valide.");
      const settings = await prisma.shopSettings.findUnique({ where: { shop: session.shop } });
      await sendKanbanCardEmail({ to: email, orderName: `${card.orderName}${dossier.yachtName ? ` / ${dossier.yachtName}` : ""}`, item: p, subjectTemplate: settings?.partnerEmailSubject, messageTemplate: settings?.partnerEmailMessage });
      await prisma.kanbanCard.update({ where: { id: card.id }, data: { lastSentAt: new Date(), lastSentTo: email } });
      if (fd.get("rememberPartner") === "on") await prisma.partnerEmail.upsert({ where: { shop_type: { shop: session.shop, type: p.type } }, create: { shop: session.shop, type: p.type, email }, update: { email } });
      await event(dossier.id, `Production transmise à ${email} : ${p.productTitle}, ${p.proofs.length} BAT actuel(s) validé(s).`);
      return { success: true, message: "Dossier transmis au partenaire" };
    }
    if (intent === "set-dates") {
      const start = String(fd.get("startDate") || ""); const end = String(fd.get("endDate") || "");
      const valid = (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
      if (!valid(start) || !valid(end) || (start && end && start > end)) throw new Error("La date de fin doit être valide et postérieure ou égale au début.");
      await prisma.kanbanCard.update({ where: { id: card.id }, data: { startDate: start ? new Date(start) : null, endDate: end ? new Date(end) : null } });
      await event(dossier.id, `Échéance de production mise à jour : ${p.productTitle}, ${end || "sans échéance"}.`);
      return { success: true, message: "Échéance enregistrée" };
    }
    if (intent === "archive-card" || intent === "restore-card") {
      if (intent === "archive-card" && (card.status !== "termine" || !ready)) throw new Error("Termine ce travail et vérifie ses BAT avant de l’archiver.");
      await prisma.kanbanCard.update({ where: { id: card.id }, data: { archivedAt: intent === "archive-card" ? new Date() : null } });
      await event(dossier.id, `Travail ${intent === "archive-card" ? "archivé" : "réactivé"} : ${p.productTitle}.`);
      return { success: true, message: intent === "archive-card" ? "Travail archivé" : "Travail réactivé" };
    }
    if (intent === "move-card") {
      const status = String(fd.get("status") || "");
      if (!COLUMNS.some((c) => c.key === status)) throw new Error("Statut invalide.");
      if (card.archivedAt) throw new Error("Réactive ce travail avant de le déplacer.");
      if (status !== "a_faire" && !ready) throw new Error("Production bloquée : tous les BAT actuels doivent être approuvés.");
      await prisma.kanbanCard.update({ where: { id: card.id }, data: { status } });
      if (card.status !== status) await event(dossier.id, `Production : ${p.productTitle}, ${COLUMNS.find((c) => c.key === status).label.toLowerCase()}.`);
      return { success: true, message: "Statut de production mis à jour" };
    }
    throw new Error("Action inconnue.");
  } catch (e) { return { error: e.message }; }
};
function ProductionForm({ cardId, intent, children, label, onDone }) {
  const fetcher = useFetcher(); const app = useAppBridge(); const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const before = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", before); return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  useEffect(() => { if (fetcher.state === "idle" && fetcher.data?.success) { setDirty(false); app.toast.show(fetcher.data.message); onDone?.(); } }, [fetcher.state, fetcher.data, app, onDone]);
  return <fetcher.Form className="aw-form" data-production-editor={dirty ? "dirty" : "clean"} method="post" onChange={() => setDirty(true)}><input type="hidden" name="cardId" value={cardId}/><input type="hidden" name="intent" value={intent}/><fieldset disabled={fetcher.state !== "idle"}>{children}{fetcher.data?.error && <p className="aw-error" role="alert">{fetcher.data.error}</p>}<button className="aw-button primary">{fetcher.state !== "idle" ? "En cours…" : label}</button></fieldset></fetcher.Form>;
}
const date = (v) => v ? new Date(v).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }) : "";
const inputDate = (v) => v ? new Date(v).toISOString().slice(0, 10) : "";
function ProductionCard({ row, partner, onDrag, onEnd }) {
  const { card, p, dossier, blocked } = row; const [mode, setMode] = useState(null);
  const toggleMode = (next) => {
    if (document.querySelector(`[data-card-editor="${card.id}"] [data-production-editor="dirty"]`) && !window.confirm("Fermer sans enregistrer les modifications ?")) return;
    setMode(mode === next ? null : next);
  };
  const overdue = card.endDate && card.status !== "termine" && inputDate(card.endDate) < new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
  return <article data-card-editor={card.id} className={`aw-production-card${overdue ? " overdue" : ""}${blocked ? " blocked" : ""}`} draggable={!blocked && !card.archivedAt && !mode} onDragStart={(e) => { e.dataTransfer.setData("text/plain", card.id); onDrag(card.id); }} onDragEnd={onEnd}>
    <div className="aw-between"><strong>{dossier.yachtName || dossier.customerName || card.orderName}</strong><span className="aw-badge">{p.type}</span></div><h3>{p.productTitle}</h3><p className="aw-muted">{card.orderName} · {p.quantity} pièce(s)</p>
    <p>{[p.dimensions, p.color, p.location, p.customText].filter(Boolean).join(" · ")}</p>
    {blocked && <p className="aw-notice">Bloqué : dossier incomplet ou BAT actuel non validé. Qualifie les articles et valide tous les BAT du dossier avant production.</p>}
    <p className={overdue ? "aw-error" : "aw-muted"}>{card.endDate ? `${overdue ? "En retard · " : "Échéance : "}${date(card.endDate)}` : "Échéance non définie"}</p>
    <Link className="aw-button" to={`/app/personnalisation?case=${dossier.id}`}>Ouvrir le dossier</Link>
    <details><summary>Fichiers de production</summary>{p.logoUrl && <a href={`/app/download?url=${encodeURIComponent(p.logoUrl)}&filename=${encodeURIComponent(p.logoFileName || `logo${fileExtension(p.logoMimeType, p.logoUrl)}`)}`} target="_blank" rel="noreferrer">Télécharger le logo</a>}{currentProofs(p).filter((proof) => proof.status === "approuve").map((proof) => <p key={proof.id}><a href={`/app/download?url=${encodeURIComponent(proof.imageUrl)}&filename=${encodeURIComponent(proof.fileName || `BAT-V${proof.version}${fileExtension(proof.mimeType, proof.imageUrl)}`)}`} target="_blank" rel="noreferrer">BAT V{proof.version} validé</a></p>)}</details>
    {card.lastSentAt && <small>Transmis le {date(card.lastSentAt)} à {card.lastSentTo}</small>}
    {!card.archivedAt && <><div className="aw-toolbar"><button className="aw-button" onClick={() => toggleMode("dates")}>Échéance</button><button className="aw-button" disabled={blocked} onClick={() => toggleMode("email")}>Transmettre au partenaire</button></div>
      {mode === "dates" && <ProductionForm cardId={card.id} intent="set-dates" label="Enregistrer les dates" onDone={() => setMode(null)}><div className="aw-grid"><label>Début prévu<input type="date" name="startDate" defaultValue={inputDate(card.startDate)}/></label><label>Fin prévue<input type="date" name="endDate" defaultValue={inputDate(card.endDate)}/></label></div></ProductionForm>}
      {mode === "email" && <ProductionForm cardId={card.id} intent="email-card" label="Confirmer la transmission" onDone={() => setMode(null)}><label>Email du partenaire<input type="email" name="partnerEmail" defaultValue={card.lastSentTo || partner || ""} required/></label><label className="aw-check"><input type="checkbox" name="rememberPartner"/>Utiliser comme partenaire par défaut pour {p.type.toLowerCase()}</label><p>{currentProofs(p).length} BAT actuel(s) validé(s) et le logo seront joints. Les anciennes versions sont exclues.</p></ProductionForm>}
      <ProductionForm cardId={card.id} intent="move-card" label="Appliquer le statut"><label>État de production<select name="status" defaultValue={card.status}><option value="a_faire">À faire</option><option value="en_cours" disabled={blocked}>Démarrer la production</option><option value="termine" disabled={blocked}>Marquer comme terminé</option></select></label></ProductionForm>
    </>}
    {card.archivedAt ? <ProductionForm cardId={card.id} intent="restore-card" label="Réactiver le travail"/> : card.status === "termine" && !blocked && <ProductionForm cardId={card.id} intent="archive-card" label="Archiver le travail terminé"/>}
  </article>;
}
export default function Kanban() {
  const { rows, partners } = useLoaderData(); const [params, setParams] = useSearchParams();
  const q = params.get("q") || ""; const type = params.get("type") || "all"; const archived = params.get("archives") === "1"; const list = params.get("view") === "list";
  const updateFilter = (name, value) => { if (document.querySelector('[data-production-editor="dirty"]') && !window.confirm("Changer de vue sans enregistrer les modifications ?")) return; const next = new URLSearchParams(params); if (value) next.set(name, value); else next.delete(name); setParams(next, { replace: true }); };
  const [dragged, setDragged] = useState(null); const [over, setOver] = useState(null); const fetcher = useFetcher(); const revalidator = useRevalidator();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname && Boolean(document.querySelector('[data-production-editor="dirty"]')));
  useEffect(() => { if (blocker.state === "blocked") { if (window.confirm("Quitter sans enregistrer les modifications de production ?")) blocker.proceed(); else blocker.reset(); } }, [blocker]);
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === "visible" && !document.querySelector('[data-production-editor="dirty"]') && revalidator.state === "idle") revalidator.revalidate(); }, 45000); return () => clearInterval(timer); }, [revalidator]);
  const visible = rows.filter(({ card, p, dossier }) => Boolean(card.archivedAt) === archived && (type === "all" || p.type === type) && `${card.orderName} ${p.productTitle} ${dossier.yachtName || ""} ${dossier.customerName || ""} ${card.lastSentTo || ""}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => (a.card.endDate ? new Date(a.card.endDate).getTime() : Infinity) - (b.card.endDate ? new Date(b.card.endDate).getTime() : Infinity) || new Date(a.card.createdAt) - new Date(b.card.createdAt));
  const drop = (status) => { if (dragged) { fetcher.submit({ intent: "move-card", cardId: dragged, status }, { method: "post" }); } setDragged(null); setOver(null); };
  return <s-page heading="Suivi de production"><style>{WORKSPACE_STYLES}</style><main className="aw-workspace"><h1>Suivi de production</h1><p className="aw-muted">Travaux des commandes Shopify, classés par échéance. Seuls les BAT actuels validés peuvent être transmis.</p>
    <section className="aw-panel"><div className="aw-toolbar"><label className="aw-grow">Rechercher<input value={q} onChange={(e) => updateFilter("q", e.target.value)} placeholder="Commande, yacht, client, produit ou partenaire"/></label><label>Technique<select value={type} onChange={(e) => updateFilter("type", e.target.value)}><option value="all">Toutes</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></label><button className="aw-button" onClick={() => updateFilter("archives", archived ? "" : "1")}>{archived ? "Voir les actifs" : "Archives"}</button><button className="aw-button" onClick={() => updateFilter("view", list ? "" : "list")}>{list ? "Vue tableau" : "Vue liste"}</button></div><p>{visible.length} travail(s) · {visible.filter((r) => r.blocked).length} bloqué(s)</p></section>
    {fetcher.data?.error && <p role="alert" className="aw-error">{fetcher.data.error}</p>}
    {!visible.length && <section className="aw-panel aw-empty"><h2>Aucun travail dans cette vue</h2><p>Les cartes apparaissent pour les articles avec BAT requis lorsque le devis devient une commande Shopify. Essaie aussi un autre filtre.</p></section>}
    {list ? <div>{visible.map((row) => <ProductionCard key={row.card.id} row={row} partner={partners[row.p.type]} onDrag={setDragged} onEnd={() => setDragged(null)}/>)}</div> : <div className="aw-production-grid">{COLUMNS.map((col) => <section key={col.key} className={`aw-production-column${over === col.key ? " dragover" : ""}`} onDragOver={(e) => { if (dragged) { e.preventDefault(); setOver(col.key); } }} onDragLeave={() => setOver(null)} onDrop={(e) => { e.preventDefault(); drop(col.key); }}><h2>{col.label} ({visible.filter((r) => r.card.status === col.key).length})</h2>{visible.filter((r) => r.card.status === col.key).map((row) => <ProductionCard key={row.card.id} row={row} partner={partners[row.p.type]} onDrag={setDragged} onEnd={() => setDragged(null)}/>)}</section>)}</div>}
  </main></s-page>;
}
