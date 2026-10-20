import { personalizationLabel } from "./personalization.js";

// A changed marking must be explicitly produced again after its new BAT is approved.
// Keep dates and transmission history so the office can contact the previous partner.
export async function reopenProduction(db, p, caseId) {
  const card = await db.kanbanCard.findUnique({ where: { personalizationId: p.id } });
  if (!card || (card.status === "a_faire" && !card.archivedAt && !card.lastSentAt)) return;
  await db.kanbanCard.update({ where: { id: card.id }, data: { status: "a_faire", archivedAt: null } });
  await db.artworkEvent.create({ data: { caseId, actor: "Équipe",
    message: `Production à revoir : ${personalizationLabel(p)}. État précédent : ${card.status}.${card.lastSentTo ? ` Prévenir le partenaire déjà destinataire : ${card.lastSentTo}.` : ""}` } });
}

export async function noteAddedMarking(db, p, caseId) {
  const started = await db.kanbanCard.findFirst({ where: { shop: p.shop, draftOrderId: p.draftOrderId,
    OR: [{ status: { in: ["en_cours", "termine"] } }, { lastSentAt: { not: null } }] } });
  if (started) await db.artworkEvent.create({ data: { caseId, actor: "Équipe",
    message: `Marquage ajouté après démarrage ou transmission de la production : ${personalizationLabel(p)}. Vérifier les travaux et prévenir les partenaires concernés. Les nouveaux BAT doivent être validés avant de poursuivre.` } });
}
