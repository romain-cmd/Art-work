// Textes par défaut des emails, personnalisables depuis Réglages
// (ShopSettings.clientEmail*/partnerEmail*). Fichier non-.server car ces
// constantes sont aussi utilisées côté client (placeholders des champs
// dans app.reglages.jsx) — seules les fonctions d'envoi elles-mêmes
// restent dans les fichiers *.server.js.
export const DEFAULT_CLIENT_EMAIL_SUBJECT =
  "Your designs are ready for review — {{orderName}}";
export const DEFAULT_CLIENT_EMAIL_MESSAGE =
  "We've prepared the personalization designs for your order {{orderName}}. Please click the link below to approve each design or request changes.";

export const DEFAULT_PARTNER_EMAIL_SUBJECT =
  "Détails de production — {{orderName}} — {{productTitle}}";
export const DEFAULT_PARTNER_EMAIL_MESSAGE = "";
