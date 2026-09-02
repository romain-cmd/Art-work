import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// Envoie un seul email au client regroupant tous les proofs en attente
// d'une commande. Le lien pointe vers la page publique de validation,
// avec les tokens de chaque proof dans l'URL (voir proof-review.jsx).
export async function sendProofValidationEmail({ to, orderName, items, reviewUrl }) {
  const itemsList = items
    .map((title) => `<li>${escapeHtml(title)}</li>`)
    .join("");

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>Your designs are ready for review</h2>
      <p>Hello,</p>
      <p>
        We've prepared the personalization designs for your order
        <strong>${escapeHtml(orderName)}</strong>:
      </p>
      <ul>${itemsList}</ul>
      <p>
        Please click the link below to approve each design or request
        changes.
      </p>
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
    from: process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev",
    to: [to],
    subject: `Your designs are ready for review — ${orderName}`,
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
