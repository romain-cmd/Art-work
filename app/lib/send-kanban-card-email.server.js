import { currentProofs, fileExtension, isPersonalizationApproved } from "./artwork-status";
import { Resend } from "resend";
import { applyPlaceholders } from "./email-template.server";
import { getFromAddress } from "./email-from.server";
import {
  DEFAULT_PARTNER_EMAIL_SUBJECT,
  DEFAULT_PARTNER_EMAIL_MESSAGE,
} from "./email-defaults";

const resend = new Resend(process.env.RESEND_API_KEY);

// Envoie à un partenaire externe (ex: brodeur, sérigraphe sous-traitant)
// toutes les informations d'UNE personnalisation : specs, logo et proof
// approuvée, en pièces jointes (Resend télécharge directement les fichiers
// depuis leur URL Shopify via le paramètre "path").
// subjectTemplate/messageTemplate viennent de ShopSettings (Réglages) et
// retombent sur le texte par défaut ci-dessus quand ils sont vides.
export async function sendKanbanCardEmail({
  to,
  orderName,
  item,
  subjectTemplate,
  messageTemplate,
}) {
  const vars = { orderName, productTitle: item.productTitle };
  const subject = applyPlaceholders(
    subjectTemplate || DEFAULT_PARTNER_EMAIL_SUBJECT,
    vars
  );
  const message = applyPlaceholders(
    messageTemplate || DEFAULT_PARTNER_EMAIL_MESSAGE,
    vars
  );

  if (!isPersonalizationApproved(item)) throw new Error("Les BAT actuels doivent tous être validés avant transmission.");
  const approvedProofs = currentProofs(item);
  const approvedProof = approvedProofs[0];

  const specRows = [
    ["Type", item.type],
    ["Quantité", item.quantity],
    ["Dimensions du marquage", item.dimensions],
    ["Ancienne information taille", item.size],
    ["Couleur du marquage", item.color],
    ["Emplacement", item.location],
    ["Texte personnalisé", item.customText],
  ]
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(
      ([label, value]) =>
        `<p style="margin:2px 0;"><strong>${label}:</strong> ${escapeHtml(value)}</p>`
    )
    .join("");

  const attachments = [];
  if (item.logoUrl) {
    attachments.push({ filename: item.logoFileName || `logo-${item.productTitle}${fileExtension(item.logoMimeType, item.logoUrl)}`, path: item.logoUrl });
  }
  for (const proof of approvedProofs) {
    attachments.push({ filename: proof.fileName || `BAT-${item.productTitle}-V${proof.version}${fileExtension(proof.mimeType, proof.imageUrl)}`, path: proof.imageUrl });
  }

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>Détails de production — ${escapeHtml(orderName)}</h2>
      <h3 style="margin:0 0 8px;">${escapeHtml(item.productTitle)}</h3>
      ${message ? `<p>${escapeHtml(message)}</p>` : ""}
      ${specRows}
      <p style="margin-top:16px;color:#555;">
        Le logo${approvedProof ? " et la BAT validé sont" : " est"} en
        pièce jointe de cet email.
      </p>
      ${
        !approvedProof
          ? '<p style="color:#c62828;">Aucune BAT validé pour le moment.</p>'
          : ""
      }
    </div>
  `;

  const { error } = await resend.emails.send({
    from: getFromAddress(),
    to: [to],
    subject,
    html,
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  if (error) {
    throw new Error(error.message || "Échec de l'envoi de l'email.");
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
