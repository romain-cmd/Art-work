import { copyPersonalization } from "./personalization.js";
import { markingSignature } from "./artwork-groups.js";
import { noteAddedMarking } from "./artwork-production.server.js";

export async function groupedMarkings(db, source, items, caseId, quantities = {}) {
  const signature = (rows) => JSON.stringify(rows.map(markingSignature).sort());
  const result = [...source];
  for (const item of items.filter((item) => item.lineItemId !== source[0].lineItemId)) {
    let markings = await db.personalization.findMany({ where: { shop: item.shop, draftOrderId: item.draftOrderId, lineItemId: item.lineItemId, isActive: true } });
    if (!markings.length) {
      markings = [];
      for (const template of source) {
        const p = await db.personalization.create({ data: { shop: item.shop, draftOrderId: item.draftOrderId, lineItemId: item.lineItemId, variantId: item.variantId,
          sourceQuantity: item.quantity, productTitle: item.title, ...copyPersonalization(template, item),
          ...(quantities[template.id] ? { quantity: quantities[template.id][item.id] } : {}) } });
        markings.push(p);
        await noteAddedMarking(db, p, caseId);
      }
    } else {
      if (signature(markings) !== signature(source)) throw new Error(`Les marquages de ${item.title} (${item.variantTitle || item.sizeLabel || "variante"}) diffèrent. Garde un BAT séparé ou harmonise leurs caractéristiques avant le regroupement.`);
      for (const template of source) {
        if (quantities[template.id] && !markings.some((p) => markingSignature(p) === markingSignature(template) && p.quantity === quantities[template.id][item.id])) throw new Error(`La quantité du marquage déjà préparé sur ${item.variantTitle || item.title} diffère. Modifie ce marquage dans Vêtements et marquages avant le regroupement.`);
      }
    }
    if (item.requirement !== "required") await db.artworkItem.update({ where: { id: item.id }, data: { requirement: "required" } });
    result.push(...markings);
  }
  return result;
}
