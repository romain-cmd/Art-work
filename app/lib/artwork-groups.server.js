import { copyPersonalization } from "./personalization.js";
import { markingSignature } from "./artwork-groups.js";
import { noteAddedMarking } from "./artwork-production.server.js";

export async function groupedMarkings(db, source, items, caseId) {
  const signature = (rows) => JSON.stringify(rows.map(markingSignature).sort());
  const result = [...source];
  for (const item of items.filter((item) => item.lineItemId !== source[0].lineItemId)) {
    let markings = await db.personalization.findMany({ where: { shop: item.shop, draftOrderId: item.draftOrderId, lineItemId: item.lineItemId, isActive: true } });
    if (!markings.length) {
      markings = [];
      for (const template of source) {
        const p = await db.personalization.create({ data: { shop: item.shop, draftOrderId: item.draftOrderId, lineItemId: item.lineItemId, variantId: item.variantId,
          sourceQuantity: item.quantity, productTitle: item.title, ...copyPersonalization(template, item) } });
        markings.push(p);
        await noteAddedMarking(db, p, caseId);
      }
    } else if (signature(markings) !== signature(source)) throw new Error(`Les marquages de ${item.title} (${item.variantTitle || item.sizeLabel || "variante"}) diffèrent. Garde un BAT séparé ou harmonise leurs caractéristiques avant le regroupement.`);
    if (item.requirement !== "required") await db.artworkItem.update({ where: { id: item.id }, data: { requirement: "required" } });
    result.push(...markings);
  }
  return result;
}
