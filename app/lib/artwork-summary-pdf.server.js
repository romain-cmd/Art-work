import { personalizationLabel } from "./personalization.js";
import PdfPrinter from "pdfmake";
import fontBundle from "pdfmake/build/vfs_fonts.js";
import { artworkSummary, sizeSummary } from "./artwork-groups.js";

const vfs = fontBundle.pdfMake?.vfs || fontBundle;
const font = (name) => Buffer.from(vfs[name], "base64");
const printer = new PdfPrinter({ Roboto: {
  normal: font("Roboto-Regular.ttf"), bold: font("Roboto-Medium.ttf"),
  italics: font("Roboto-Italic.ttf"), bolditalics: font("Roboto-MediumItalic.ttf"),
} });

export async function renderArtworkSummary(proof) {
  const { articles, total } = sizeSummary(proof);
  const markings = artworkSummary(proof);
  const ref = `Artwork ${proof.id.slice(-8)} - V${proof.version}`;
  const definition = { pageSize: "A4", pageMargins: [40, 44, 40, 48],
    defaultStyle: { font: "Roboto", fontSize: 10, color: "#172b42", lineHeight: 1.2 },
    info: { title: `${ref} - Sizes and markings`, author: "Marina Yacht Wear" },
    footer: (page, pages) => ({ text: `${ref} | Page ${page} / ${pages}`, fontSize: 8, color: "#526277", margin: [40, 16, 40, 0] }),
    content: [
      { text: "MARINA YACHT WEAR", bold: true, fontSize: 19 },
      { text: "ARTWORK - SIZES & MARKINGS", color: "#526277", margin: [0, 6, 0, 20] },
      { text: ref, bold: true, fontSize: 13 },
      { text: proof.fileName || "Artwork", margin: [0, 4, 0, 12] },
      { text: "This summary belongs to the artwork version above. Approval covers its listed sizes and markings. A revised version requires a new approval.", fontSize: 9, color: "#526277", margin: [0, 0, 0, 16] },
      { text: articles[0]?.title || proof.snapshot?.productTitle || "Product", bold: true, fontSize: 15, margin: [0, 0, 0, 12] },
      ...(articles.length ? [{ table: { headerRows: 1, dontBreakRows: true, widths: ["*", "*", 90, 45], body: [
        [{ text: "Colour / variant", bold: true }, { text: "Size", bold: true }, { text: "SKU", bold: true }, { text: "Articles", bold: true }],
        ...articles.map((i) => [i.colorLabel || i.variantTitle || "-", i.sizeLabel || i.variantTitle || "-", i.sku || "-", { text: String(i.quantity), alignment: "right" }]),
        [{ text: "TOTAL ARTICLES", bold: true, colSpan: 3 }, {}, {}, { text: String(total), bold: true, alignment: "right" }],
      ] }, layout: "lightHorizontalLines", margin: [0, 0, 0, 18] }] : [{ text: "Size breakdown was not recorded for this historical artwork. Refer to the original file.", margin: [0, 0, 0, 18] }]),
      { text: "Article quantities are counted once per Shopify line, regardless of the number of markings. Marking quantities below may cover only part of these articles.", fontSize: 9, color: "#526277", margin: [0, 0, 0, 18] },
      { text: "MARKINGS SHOWN IN THIS ARTWORK", bold: true, fontSize: 12, margin: [0, 0, 0, 10] },
      ...markings.map((p) => ({ unbreakable: false, stack: [
        { text: personalizationLabel(p, { english: true, product: false }), bold: true },
        { text: [`Marking quantity: ${p.quantity}`, p.dimensions && `Dimensions: ${p.dimensions}`, p.color && `Colour: ${p.color}`, p.customText && `Text: ${p.customText}`].filter(Boolean).join(" | "), margin: [0, 4, 0, 12] },
      ] })),

    ] };
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = printer.createPdfKitDocument(definition);
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.end();
  });
}

export async function summaryResponse(db, { token, id, shop }) {
  if ((!shop && !token) || (shop && !id)) throw new Response("Not found", { status: 404 });
  const proof = await db.proof.findFirst({ where: { ...(shop ? { id, personalization: { shop } } : { token }), deletedAt: null }, include: { personalization: true } });
  if (!proof || (!shop && !proof.envoyeLe && proof.status === "en_attente")) throw new Response("Not found", { status: 404 });
  const dossier = await db.artworkCase.findUnique({ where: { shop_draftOrderId: { shop: proof.personalization.shop, draftOrderId: proof.personalization.draftOrderId } } });
  if (!dossier || dossier.archivedAt) throw new Response("Not found", { status: 404 });
  return new Response(await renderArtworkSummary(proof), { headers: {
    "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="artwork-${proof.id.slice(-8)}-V${proof.version}-sizes.pdf"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  } });
}
