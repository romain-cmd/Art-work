// Adresse + nom d'expéditeur commun à tous les emails envoyés par l'app.
// Le nom affiché dans les boîtes de réception (au lieu du seul "contact")
// est fixé ici plutôt que dans Réglages : il identifie la boutique, pas un
// contenu à personnaliser par commande.
export function getFromAddress() {
  const email = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
  return `Marina Yacht Wear <${email}>`;
}
