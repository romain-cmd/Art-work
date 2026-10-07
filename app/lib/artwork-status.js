export const ARTWORK_TAG = "ARTWORK_REQUIRED";
export const CASE_STATUSES = {
  a_personnaliser: { label: "À préparer", action: "Préparer les BAT", color: "#a15c00" },
  a_envoyer: { label: "Prêt à envoyer", action: "Envoyer au client", color: "#2456a6" },
  en_attente_reponse: { label: "En attente du client", action: "Voir / relancer", color: "#526277" },
  a_corriger: { label: "À corriger", action: "Corriger les BAT", color: "#b42318" },
  valide: { label: "BAT validés", action: "Voir le dossier", color: "#137547" },
  sans_bat: { label: "Sans BAT requis", action: "Voir le dossier", color: "#526277" },
};
export const currentProofs = (p) => (p.proofs || []).filter((proof) => proof.isCurrent !== false);
export const isPersonalizationApproved = (p) => {
  const proofs = currentProofs(p);
  return proofs.length > 0 && proofs.every((proof) => proof.status === "approuve");
};
export function summarizeCase(items, personalizations) {
  const active = items.filter((i) => i.isActive !== false);
  const ps = personalizations.filter((p) => p.isActive !== false && active.some((i) => i.lineItemId === p.lineItemId && i.requirement === "required"));
  const required = active.filter((i) => i.requirement === "required");
  const proofs = ps.flatMap(currentProofs);
  const approved = proofs.filter((p) => p.status === "approuve").length;
  const pendingQualification = active.some((i) => i.requirement === "pending");
  const missing = required.some((item) => {
    const rows = ps.filter((p) => p.lineItemId === item.lineItemId);
    return !rows.length || rows.some((p) => !currentProofs(p).length);
  });
  let status;
  if (proofs.some((p) => p.status === "modification_demandee")) status = "a_corriger";
  else if (pendingQualification || missing || !active.length) status = "a_personnaliser";
  else if (!required.length) status = "sans_bat";
  else if (proofs.some((p) => p.status === "en_attente" && !p.envoyeLe)) status = "a_envoyer";
  else if (proofs.some((p) => p.status === "en_attente")) status = "en_attente_reponse";
  else status = "valide";
  return { status, approved, total: proofs.length, required: required.length, missing, pendingQualification,
    unsent: proofs.filter((p) => p.status === "en_attente" && !p.envoyeLe).length,
    waiting: proofs.filter((p) => p.status === "en_attente" && p.envoyeLe).length };
}
export function snapshotPersonalization(p) {
  return Object.fromEntries(["productTitle", "type", "quantity", "size", "dimensions", "color", "location", "customText", "logoUrl"].map((k) => [k, p[k] ?? null]));
}
export function fileExtension(mime, url = "") {
  const types = { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg", "application/postscript": ".eps", "application/illustrator": ".ai" };
  if (types[mime]) return types[mime];
  try { return new URL(url).pathname.match(/\.[a-z0-9]{1,6}$/i)?.[0] || ""; } catch { return ""; }
}
export function acceptsBat(file) {
  return file && file.size > 0 && file.size <= 20 * 1024 * 1024 && ["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(file.type);
}
