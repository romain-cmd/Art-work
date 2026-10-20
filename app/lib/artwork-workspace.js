import { currentProofs, uniqueProofs } from "./artwork-status.js";

export function dossierProofs(dossier) {
  return uniqueProofs(dossier.personalizations.flatMap((p) => (p.proofs || []).map((proof) => ({ ...proof, personalization: p }))));
}

export function preparationIssues(dossier) {
  return dossier.items.flatMap((item) => {
    if (item.isActive === false || item.requirement === "none") return [];
    const label = [item.title, item.variantTitle].filter(Boolean).join(" · ");
    if (item.requirement === "pending") return [{ item, message: `Décider si ${label} nécessite un BAT.` }];
    const rows = dossier.personalizations.filter((p) => p.lineItemId === item.lineItemId);
    if (!rows.length) return [{ item, message: `Préparer les marquages de ${label}.` }];
    if (rows.some((p) => !currentProofs(p).length)) return [{ item, message: `Ajouter un artwork pour les marquages non couverts de ${label}.` }];
    return [];
  });
}

export function artworkContext(dossier, proof) {
  const linked = dossier.personalizations.filter((p) => p.proofs?.some((pr) => pr.id === proof.id));
  const p = linked.find((p) => dossier.items.some((i) => i.lineItemId === p.lineItemId && i.requirement === "required")) || linked[0];
  const item = dossier.items.find((i) => i.lineItemId === p?.lineItemId);
  return { p, item, markings: dossier.personalizations.filter((row) => row.lineItemId === item?.lineItemId) };
}

export function compatibleItems(items, item) {
  return items.filter((i) => i.isActive !== false && i.requirement !== "none" && (i.id === item.id || (item.productId && i.productId === item.productId)));
}

export const compactMarking = (p) => [p.type, p.location].filter(Boolean).join(" · ");

export function commentPoint(comment) {
  const match = /^Point 1 \((\d+)% from left, (\d+)% from top\):/.exec(comment || "");
  return match && Number(match[1]) <= 100 && Number(match[2]) <= 100 ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

// Detect edits made in Shopify or another tab while the assistant is open.
export function builderFingerprint(dossier, ids) {
  const items = dossier.items.filter((i) => ids.includes(i.id)).map((i) => [i.id, i.quantity, i.variantTitle || "", i.colorLabel || "", i.sizeLabel || "", i.requirement]).sort((a, b) => a[0].localeCompare(b[0]));
  const lines = dossier.items.filter((i) => ids.includes(i.id)).map((i) => i.lineItemId);
  const markings = dossier.personalizations.filter((p) => lines.includes(p.lineItemId)).map((p) => [p.id, ...["type", "quantity", "dimensions", "color", "location", "customText", "logoUrl"].map((k) => p[k] ?? null), currentProofs(p).map((pr) => pr.id).sort()]).sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify({ items, markings });
}

export function waitingSince(proofs) {
  const dates = proofs.filter((p) => p.isCurrent !== false && p.status === "en_attente" && p.envoyeLe).map((p) => new Date(p.envoyeLe).getTime()).filter(Number.isFinite);
  return dates.length ? new Date(Math.min(...dates)).toISOString() : null;
}
