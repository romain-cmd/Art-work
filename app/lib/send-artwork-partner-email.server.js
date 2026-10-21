import { Resend } from "resend";
import { getFromAddress } from "./email-from.server.js";
import { applyPlaceholders } from "./email-template.js";
import { DEFAULT_PARTNER_EMAIL_MESSAGE, DEFAULT_PARTNER_EMAIL_SUBJECT } from "./email-defaults.js";
import { renderArtworkSummary } from "./artwork-summary-pdf.server.js";
import { artworkSummary, sizeSummary } from "./artwork-groups.js";
import { fileExtension } from "./artwork-status.js";
import { personalizationFileName, personalizationLabel } from "./personalization.js";

const resend = new Resend(process.env.RESEND_API_KEY);
const escape = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export async function sendArtworkPartnerEmail({ to, orderName, proof, markings, items, subjectTemplate, messageTemplate }) {
  if (!proof.isCurrent || proof.deletedAt || proof.status !== "approuve" || !markings.length) throw new Error("Seul un BAT actuel validé peut être transmis.");
  const scope = { snapshot: { personalizations: markings } };
  const grouped = artworkSummary(scope);
  const productTitle = grouped.map((p) => personalizationLabel(p)).join(" / ");
  const variables = { orderName, productTitle };
  const attachments = [{ filename: `BAT-${proof.id.slice(-8)}-V${proof.version}${fileExtension(proof.mimeType, proof.imageUrl)}`, path: proof.imageUrl },
    { filename: `artwork-${proof.id.slice(-8)}-V${proof.version}-sizes.pdf`, content: (await renderArtworkSummary(proof)).toString("base64") }];
  const logos = new Set();
  for (const p of markings) if (p.logoUrl && !logos.has(p.logoUrl)) {
    logos.add(p.logoUrl);
    attachments.push({ filename: personalizationFileName(p, p.logoFileName || `logo${fileExtension(p.logoMimeType, p.logoUrl)}`), path: p.logoUrl });
  }
  const details = grouped.map((p) => {
    const members = markings.filter((m) => ["type", "location", "dimensions", "color", "customText", "logoUrl"].every((k) => (m[k] || "") === (p[k] || "")));
    return `<section><h3>${escape(personalizationLabel(p))}</h3>${[["Quantité de ce marquage", p.quantity], ["Emplacement", p.location], ["Dimensions", p.dimensions || p.size], ["Couleur", p.color], ["Texte", p.customText]].filter(([, v]) => v != null && v !== "").map(([k, v]) => `<p><strong>${k} :</strong> ${escape(v)}</p>`).join("")}<ul>${members.map((m) => { const item = items.find((i) => i.lineItemId === m.lineItemId); return `<li>${escape(item?.variantTitle || item?.sizeLabel || m.productTitle)}${item?.sku ? ` · ${escape(item.sku)}` : ""} : ${m.quantity} pièce(s) à personnaliser</li>`; }).join("")}</ul></section>`;
  }).join("");
  const message = applyPlaceholders(messageTemplate || DEFAULT_PARTNER_EMAIL_MESSAGE, variables);
  const html = `<div style="font-family:sans-serif;max-width:640px;margin:auto"><h2>Détails de production — ${escape(orderName)}</h2><p><strong>BAT V${proof.version} validé par le client</strong></p>${message ? `<p>${escape(message)}</p>` : ""}<p>Votre intervention porte uniquement sur les marquages et quantités ci-dessous. Le fichier commun et son récapitulatif peuvent également présenter d’autres marquages confiés à d’autres prestataires.</p>${details}<p>Total vêtements du BAT commun : ${sizeSummary(proof).total || "voir fichier"}. Les quantités à personnaliser sont précisées séparément pour chaque marquage ci-dessus.</p><p>Pièces jointes : artwork validé, récapitulatif des tailles et logos sources sélectionnés.</p></div>`;
  const { error } = await resend.emails.send({ from: getFromAddress(), to: [to], subject: applyPlaceholders(subjectTemplate || DEFAULT_PARTNER_EMAIL_SUBJECT, variables), html, attachments });
  if (error) throw new Error(error.message || "Échec de l’envoi au prestataire.");
}
