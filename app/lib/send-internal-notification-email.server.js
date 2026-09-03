import { Resend } from "resend";
import { getFromAddress } from "./email-from.server";

const resend = new Resend(process.env.RESEND_API_KEY);

// Alerte interne envoyée à l'équipe dès qu'un client répond à une proof
// (approuvée ou modification demandée), pour ne pas avoir à surveiller
// la page Personnalisation en continu.
export async function sendInternalNotificationEmail({
  to,
  productTitle,
  decision,
  comment,
  adminUrl,
}) {
  const isApproved = decision === "approuve";
  const statusLabel = isApproved ? "Approuvé ✅" : "Modification demandée ⚠️";

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>${statusLabel}</h2>
      <p><strong>Produit :</strong> ${escapeHtml(productTitle)}</p>
      ${
        comment
          ? `<p><strong>Commentaire du client :</strong> « ${escapeHtml(comment)} »</p>`
          : ""
      }
      ${
        adminUrl
          ? `<p><a href="${adminUrl}">Voir dans l'app</a></p>`
          : ""
      }
    </div>
  `;

  const { error } = await resend.emails.send({
    from: getFromAddress(),
    to: [to],
    subject: `${statusLabel} — ${productTitle}`,
    html,
  });

  if (error) {
    throw new Error(error.message || "Échec de l'envoi de la notification.");
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
