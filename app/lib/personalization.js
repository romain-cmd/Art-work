const TECHNIQUES = { Broderie: "Embroidery", Impression: "Print", Gravure: "Engraving", "Sérigraphie": "Screen printing" };
const PLACEMENTS = { "Poitrine gauche": "Left chest", "Poitrine droite": "Right chest", Manche: "Sleeve", Dos: "Back", Autre: "Other" };

// The reference also distinguishes two markings with the same technique/placement.
export function personalizationLabel(p, { english = false, product = true } = {}) {
  const id = p.personalizationId || p.id;
  return [product && p.productTitle, english ? TECHNIQUES[p.type] || p.type : p.type,
    english ? PLACEMENTS[p.location] || p.location : p.location,
    id && `#${id.slice(-8)}`].filter(Boolean).join(" · ");
}

export function personalizationFileName(p, name) {
  return `${personalizationLabel(p)} - ${name}`.replace(/[/\\<>:"|?*\r\n]/g, "_");
}

// Copy specifications only. Never copy proof tokens, approvals or production state.
export function copyPersonalization(source, item, { sameItem = false } = {}) {
  const fields = ["type", "size", "dimensions", "color", "location", "customText", "logoUrl", "logoMimeType", "logoFileName"];
  return { ...Object.fromEntries(fields.map((key) => [key, source[key] ?? null])),
    quantity: sameItem ? Math.min(source.quantity, item.quantity) : item.quantity };
}
