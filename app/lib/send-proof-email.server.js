import { Resend } from "resend";
import { applyPlaceholders } from "./email-template.server";
import { getFromAddress } from "./email-from.server";
import {
  DEFAULT_CLIENT_EMAIL_SUBJECT,
  DEFAULT_CLIENT_EMAIL_MESSAGE,
} from "./email-defaults";

const resend = new Resend(process.env.RESEND_API_KEY);

// Envoie un seul email au client regroupant tous les proofs en attente
// d'une commande. Le lien pointe vers la page publique de validation,
// avec les tokens de chaque proof dans l'URL (voir proof-review.jsx).
// subjectTemplate/messageTemplate viennent de ShopSettings (Réglages) et
// retombent sur le texte par défaut ci-dessus quand ils sont vides.
export async function sendProofValidationEmail({
  to,
  orderName,
  items,
  reviewUrl,
  subjectTemplate,
  messageTemplate,
}) {
  const vars = { orderName };
  const subject = applyPlaceholders(
    subjectTemplate || DEFAULT_CLIENT_EMAIL_SUBJECT,
    vars
  );
  const message = applyPlaceholders(
    messageTemplate || DEFAULT_CLIENT_EMAIL_MESSAGE,
    vars
  );

  const itemsList = items
    .map((title) => `<li>${escapeHtml(title)}</li>`)
    .join("");

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>Your designs are ready for review</h2>
      <p>Hello,</p>
      <p>${escapeHtml(message)}</p>
      <ul>${itemsList}</ul>
      <p style="text-align: center; margin: 24px 0;">
        <a
          href="${reviewUrl}"
          style="background:#1a1a1a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;"
        >
          Review my designs
        </a>
      </p>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: getFromAddress(),
    to: [to],
    subject,
    html,
  });

  if (error) {
    throw new Error(error.message || "Failed to send the email.");
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
