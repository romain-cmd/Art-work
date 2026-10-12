import PdfPrinter from 'pdfmake';
import fontBundle from 'pdfmake/build/vfs_fonts.js';
import { signatureSvg } from './delivery-core.server.js';
const vfs = fontBundle.pdfMake?.vfs || fontBundle;
const font = name => Buffer.from(vfs[name], 'base64');
const printer = new PdfPrinter({ Roboto: { normal: font('Roboto-Regular.ttf'), bold: font('Roboto-Medium.ttf'), italics: font('Roboto-Italic.ttf'), bolditalics: font('Roboto-MediumItalic.ttf') } });
export async function renderDeliveryPdf(snapshot, receipt, proofHash) {
  const muted = '#5d6b7b', navy = '#102b46';
  const rows = snapshot.items.map(i => [
    { stack: [{ text: i.title, bold: true }, { text: [i.variantTitle, i.sku && `SKU: ${i.sku}`].filter(Boolean).join(' | '), color: muted, fontSize: 9 }] },
    { text: String(i.ordered), alignment: 'right' }, { text: String(i.alreadySigned), alignment: 'right' },
    { text: String(i.quantity), alignment: 'right', bold: true },
  ]);
  const definition = {
    pageSize: 'A4', pageMargins: [40, 42, 40, 48], defaultStyle: { font: 'Roboto', fontSize: 10, color: navy, lineHeight: 1.2 },
    info: { title: `${snapshot.documentNumber} - Signed delivery note`, author: 'Marina Yacht Wear', subject: `Order ${snapshot.orderName}` },
    footer: (page, pages) => ({ columns: [{ text: `${snapshot.documentNumber} | Order ${snapshot.orderName}`, color: muted }, { text: `Page ${page} of ${pages}`, alignment: 'right', color: muted }], margin: [40, 14, 40, 0], fontSize: 8 }),
    content: [
      { text: 'MARINA YACHT WEAR', fontSize: 19, bold: true },
      { text: 'Elegance & performance at sea', color: muted, fontSize: 9, margin: [0, 3, 0, 22] },
      { columns: [{ text: 'SIGNED DELIVERY NOTE', fontSize: 15, bold: true }, { text: snapshot.documentNumber, alignment: 'right', bold: true }], margin: [0, 0, 0, 16] },
      { columns: [
        { width: '*', stack: [{ text: 'DELIVER TO', color: muted, fontSize: 8 }, { text: snapshot.yachtName || snapshot.customerName, bold: true, margin: [0, 4, 0, 4] }, ...snapshot.address.map(t => ({ text: t }))] },
        { width: 190, stack: [{ text: `Order: ${snapshot.orderName}`, bold: true }, { text: `Representative: ${snapshot.representative.name}`, margin: [0, 4, 0, 0] }, { text: `Packages: ${snapshot.packages || 'Not specified'}` }, { text: `Prepared: ${snapshot.createdAt.slice(0, 10)}` }, { text: `Received: ${receipt.signedAt.replace('T', ' ').replace('Z', ' UTC')}` }] },
      ], columnGap: 24, margin: [0, 0, 0, 20] },
      { table: { headerRows: 1, widths: ['*', 53, 60, 58], body: [[
        { text: 'ITEM / VARIANT', bold: true }, { text: 'Ordered', alignment: 'right', bold: true }, { text: 'Previously signed', alignment: 'right', bold: true }, { text: 'Delivered now', alignment: 'right', bold: true },
      ], ...rows] }, layout: { fillColor: row => row === 0 ? '#edf2f6' : null, hLineWidth: () => 0.4, vLineWidth: () => 0, hLineColor: () => '#d9e0e7', paddingTop: () => 8, paddingBottom: () => 8, paddingLeft: () => 7, paddingRight: () => 7 } },
      { text: `Total delivered on this note: ${snapshot.totalQuantity} units`, bold: true, alignment: 'right', margin: [0, 12, 0, 5] },
      { text: 'Previously signed quantities refer only to delivery notes recorded in this application. No prices are shown.', color: muted, fontSize: 8, margin: [0, 0, 0, 16] },
      ...(snapshot.instructions ? [{ text: 'DELIVERY INSTRUCTIONS', bold: true, fontSize: 9 }, { text: snapshot.instructions, margin: [0, 4, 0, 14] }] : []),
      { text: 'RECEIPT AND RESERVATIONS', fontSize: 11, bold: true, margin: [0, 4, 0, 6] },
      { text: `Received by: ${receipt.name} | Role: ${receipt.role}`, margin: [0, 0, 0, 6] },
      { text: receipt.reservations || 'No reservations recorded.', margin: [0, 0, 0, 10] },
      { unbreakable: true, stack: [
        { text: receipt.statement, margin: [0, 0, 0, 5] },
        { svg: signatureSvg(receipt.strokes), width: 260, height: 97.5 },
        { text: `Signed on the representative's device. Recorded by the server at ${receipt.signedAt}.`, fontSize: 8, color: muted },
      ] },
      { text: 'Evidence SHA-256', bold: true, fontSize: 8, margin: [0, 16, 0, 3] },
      { text: proofHash.match(/.{1,32}/g).join('\n'), fontSize: 7, color: muted },
      { text: 'This document records receipt of the listed goods. It does not confirm payment or waive the reservations stated above.', fontSize: 8, color: muted, margin: [0, 10, 0, 0] },
    ],
  };
  return new Promise((resolve, reject) => {
    const document = printer.createPdfKitDocument(definition);
    const chunks = [];
    document.on('data', chunk => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.end();
  });
}
