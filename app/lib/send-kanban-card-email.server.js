import { renderArtworkSummary } from "./artwork-summary-pdf.server.js";
import { personalizationFileName, personalizationLabel } from "./personalization";
import { currentProofs, artworkMarkings, fileExtension, isPersonalizationApproved } from "./artwork-status";
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
  const vars = { orderName, productTitle: personalizationLabel(item) };
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
    ["Variante / taille du vêtement", item.variantTitle],
    ["Référence article", item.sku],
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
    attachments.push({ filename: personalizationFileName(item, item.logoFileName || `logo${fileExtension(item.logoMimeType, item.logoUrl)}`), path: item.logoUrl });
  }
  for (const proof of approvedProofs) {
    attachments.push({ filename: personalizationFileName(item, proof.fileName || `BAT-V${proof.version}${fileExtension(proof.mimeType, proof.imageUrl)}`), path: proof.imageUrl });
    attachments.push({ filename: `artwork-${proof.id.slice(-8)}-V${proof.version}-sizes.pdf`, content: (await renderArtworkSummary(proof)).toString("base64") });
  }

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>Détails de production — ${escapeHtml(orderName)}</h2>
      <h3 style="margin:0 0 8px;">${escapeHtml(personalizationLabel(item))}</h3>
      ${message ? `<p>${escapeHtml(message)}</p>` : ""}
      ${specRows}
      ${approvedProofs.some((proof) => artworkMarkings(proof, [item]).length > 1) ? '<p><strong>Artwork commun :</strong> le fichier peut présenter plusieurs marquages. Votre travail porte uniquement sur la variante, la technique et les caractéristiques indiquées ci-dessus.</p>' : ""}
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
