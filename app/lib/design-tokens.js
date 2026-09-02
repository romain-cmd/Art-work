// Palette partagée entre les pages admin (Personnalisation, Kanban) pour
// donner un repère visuel couleur cohérent — comme les étiquettes de
// couleur dans Trello — puisque les composants Polaris (s-badge, s-box)
// ne permettent pas de couleurs arbitraires.
export const TYPE_COLORS = {
  Broderie: "#2563EB",
  Impression: "#7C3AED",
  Gravure: "#EA580C",
  Sérigraphie: "#059669",
};

export const ORDER_STATUS_COLORS = {
  a_personnaliser: "#D97706",
  a_envoyer: "#2563EB",
  en_attente_reponse: "#64748B",
  a_corriger: "#DC2626",
  valide: "#059669",
};

export function colorForType(type) {
  return TYPE_COLORS[type] || "#94A3B8";
}
