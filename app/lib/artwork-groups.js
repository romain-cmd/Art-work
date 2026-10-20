export function variantDetails(variant) {
  const options = variant?.selectedOptions || [];
  const name = (o) => o.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return { productId: variant?.product?.id || null,
    sizeLabel: options.find((o) => /^(size|taille)$/.test(name(o)))?.value || null,
    colorLabel: options.find((o) => /^(color|colour|couleur)$/.test(name(o)))?.value || null };
}

export function markingSignature(p) {
  return JSON.stringify(["type", "dimensions", "color", "location", "customText", "logoUrl"].map((key) => p[key] || ""));
}

export function itemChangesAffectArtwork(previous, next) {
  const metadata = new Set(["productId", "sizeLabel", "colorLabel"]);
  return Object.keys(next).some((key) => {
    // First enrichment after the migration must not revoke existing approvals.
    if (metadata.has(key) && previous[key] == null) return false;
    return (previous[key] ?? null) !== (next[key] ?? null);
  });
}

export function artworkSummary(proof) {
  const entries = proof.snapshot?.personalizations || proof.personalizations || [];
  const groups = new Map();
  for (const p of entries) {
    const key = markingSignature(p);
    const existing = groups.get(key);
    if (existing) existing.quantity += p.quantity;
    else groups.set(key, { ...p });
  }
  return [...groups.values()];
}

export function sizeSummary(proof) {
  const articles = proof.snapshot?.articles || [];
  return { articles, total: articles.reduce((sum, row) => sum + row.quantity, 0) };
}
