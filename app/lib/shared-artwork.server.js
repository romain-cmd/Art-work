import { snapshotArtwork } from "./artwork-status.js";
import { reopenProduction } from "./artwork-production.server.js";

export async function createArtwork(db, markings, file, previous = null) {
  if (!markings.length) throw new Error("Sélectionne au moins une personnalisation.");
  const first = markings[0];
  if (markings.some((p) => p.shop !== first.shop || p.draftOrderId !== first.draftOrderId || !p.isActive)) throw new Error("Les marquages doivent appartenir au même dossier actif.");
  const lineIds = [...new Set(markings.map((p) => p.lineItemId))];
  const items = await db.artworkItem.findMany({ where: { shop: first.shop, draftOrderId: first.draftOrderId, lineItemId: { in: lineIds }, isActive: true } });
  if (items.length !== lineIds.length || (items.length > 1 && (!items[0].productId || items.some((i) => i.productId !== items[0].productId)))) throw new Error("Le BAT commun doit réunir des variantes actives du même produit Shopify.");
  if (previous) {
    const retired = await db.proof.updateMany({ where: { id: previous.id, isCurrent: true, deletedAt: null }, data: { isCurrent: false } });
    if (!retired.count) throw new Error("Cet artwork a changé. Actualise le dossier.");
  }
  return db.proof.create({ data: { personalizationId: first.id,
    personalizations: { connect: markings.map((p) => ({ id: p.id })) },
    imageUrl: file.imageUrl, mimeType: file.mimeType, fileName: file.fileName,
    version: previous ? previous.version + 1 : 1, supersedesId: previous?.id || null,
    snapshot: snapshotArtwork(markings, items) } });
}

export async function reopenArtworkProduction(db, markings, caseId) {
  for (const p of markings) await reopenProduction(db, p, caseId);
}

// Reconcile all changed markings together, so one shared file gets one new version.
export async function invalidateArtworks(db, changed, caseId, reason) {
  if (!changed.length) return;
  const old = await db.proof.findMany({ where: { isCurrent: true, deletedAt: null,
    personalizations: { some: { id: { in: changed.map((p) => p.id) } } } }, include: { personalizations: true } });
  const affected = new Map(changed.map((p) => [p.id, p]));
  for (const proof of old) {
    const activeItems = await db.artworkItem.findMany({ where: { shop: proof.personalization?.shop || proof.personalizations[0].shop, draftOrderId: proof.personalizations[0].draftOrderId,
      lineItemId: { in: proof.personalizations.map((p) => p.lineItemId) }, isActive: true, requirement: "required" } });
    const markings = proof.personalizations.filter((p) => p.isActive && activeItems.some((i) => i.lineItemId === p.lineItemId));
    // An absent/ambiguous Shopify line must never be approved through another marking.
    if (!markings.length) {
      await db.proof.updateMany({ where: { id: proof.id, isCurrent: true }, data: { isCurrent: false } });
    } else await createArtwork(db, markings, proof, proof);
    for (const p of proof.personalizations) affected.set(p.id, p);
  }
  await reopenArtworkProduction(db, [...affected.values()], caseId);
  if (old.length) await db.artworkEvent.create({ data: { caseId, actor: "Équipe", message: `${reason} Nouvelle validation des artworks concernés requise.` } });
}
