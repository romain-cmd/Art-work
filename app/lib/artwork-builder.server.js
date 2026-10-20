import { noteAddedMarking } from "./artwork-production.server.js";
import { groupedMarkings } from "./artwork-groups.server.js";
import { createArtwork, reopenArtworkProduction } from "./shared-artwork.server.js";
import { builderFingerprint } from "./artwork-workspace.js";

export function builderSelection(items, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length) throw new Error("Sélectionne les vêtements concernés.");
  const selected = ids.map((id) => items.find((i) => i.id === id && i.isActive !== false && i.requirement !== "none"));
  if (selected.some((i) => !i) || (selected.length > 1 && (!selected[0].productId || selected.some((i) => i.productId !== selected[0].productId)))) throw new Error("Sélectionne uniquement des variantes actives du même produit.");
  return selected;
}

export async function savePreparedArtwork(db, { dossier, items, existing, additions, files, expected }) {
  return db.$transaction(async (tx) => {
    const base = items[0];
    const currentItems = await tx.artworkItem.findMany({ where: { shop: dossier.shop, draftOrderId: dossier.draftOrderId, id: { in: items.map((i) => i.id) }, isActive: true } });
    const currentMarkings = await tx.personalization.findMany({ where: { shop: dossier.shop, draftOrderId: dossier.draftOrderId, lineItemId: { in: items.map((i) => i.lineItemId) }, isActive: true }, include: { proofs: true } });
    if (expected !== builderFingerprint({ items: currentItems, personalizations: currentMarkings }, items.map((i) => i.id))) throw new Error("Le dossier a changé pendant l’import. Vérifie les vêtements et marquages avant de recommencer.");
    for (const item of items) await tx.artworkItem.update({ where: { id: item.id }, data: { requirement: "required" } });
    const source = [...existing];
    for (const row of additions) {
      const p = await tx.personalization.create({ data: { shop: dossier.shop, draftOrderId: dossier.draftOrderId,
        lineItemId: base.lineItemId, variantId: base.variantId, productTitle: base.title, sourceQuantity: base.quantity, ...row.specs,
        quantity: row.quantities[base.id], ...row.logo } });
      source.push(p);
      await noteAddedMarking(tx, p, dossier.id);
    }
    const quantities = Object.fromEntries(source.map((p, index) => [p.id, index < existing.length ? null : additions[index - existing.length].quantities]));
    const grouped = await groupedMarkings(tx, source, items, dossier.id, quantities);
    await reopenArtworkProduction(tx, grouped, dossier.id);
    const proofs = [];
    for (const file of files) proofs.push(await createArtwork(tx, grouped, file));
    await tx.artworkEvent.create({ data: { caseId: dossier.id, actor: "Équipe", message: `BAT préparé : ${base.title}, ${items.length} variante(s), ${files.length} fichier(s).` } });
    return proofs;
  });
}
