import { markingSignature } from "./artwork-groups.js";
import { builderFingerprint } from "./artwork-workspace.js";

export function correctionGroups(dossier, proof) {
  const groups = new Map();
  for (const p of dossier.personalizations.filter((p) => p.proofs.some((pr) => pr.id === proof.id))) {
    const key = markingSignature(p);
    if (!groups.has(key)) groups.set(key, { key: p.id, type: p.type, location: p.location || "", dimensions: p.dimensions || "", color: p.color || "", customText: p.customText || "", logoUrl: p.logoUrl, logoMimeType: p.logoMimeType, members: [] });
    const item = dossier.items.find((i) => i.lineItemId === p.lineItemId);
    groups.get(key).members.push({ id: p.id, quantity: p.quantity, max: item?.quantity || p.quantity, variant: item?.variantTitle || p.productTitle });
  }
  return [...groups.values()];
}

export function correctionFingerprint(dossier, proof) {
  const lines = dossier.personalizations.filter((p) => p.proofs.some((pr) => pr.id === proof.id)).map((p) => p.lineItemId);
  return JSON.stringify([proof.id, builderFingerprint(dossier, dossier.items.filter((i) => lines.includes(i.lineItemId)).map((i) => i.id))]);
}
