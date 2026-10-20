/* eslint-env node, es2020 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { artworkSummary, sizeSummary, variantDetails } from "./artwork-groups.js";
import { renderArtworkSummary } from "./artwork-summary-pdf.server.js";

test("Shopify option names separate garment size from garment colour", () => {
  assert.deepEqual(variantDetails({ product: { id: "p" }, selectedOptions: [{ name: "Taille", value: "M" }, { name: "Couleur", value: "Marine" }] }), { productId: "p", sizeLabel: "M", colorLabel: "Marine" });
  assert.deepEqual(variantDetails(null), { productId: null, sizeLabel: null, colorLabel: null });
});
test("article quantities are counted once while marking quantities remain independent", () => {
  const p = { type: "Broderie", location: "Dos", dimensions: "80 mm" };
  const proof = { snapshot: { articles: [{ quantity: 5 }, { quantity: 10 }], personalizations: [{ ...p, quantity: 5 }, { ...p, quantity: 10 }, { ...p, type: "Impression", quantity: 15 }] } };
  assert.equal(sizeSummary(proof).total, 15);
  assert.equal(artworkSummary(proof).length, 2);
  assert.ok(artworkSummary(proof).every((p) => p.quantity === 15));
});
test("size summary PDF handles long references, many variants and markings", async () => {
  const proof = { id: "example-common-artwork", version: 4, fileName: "common-artwork.pdf", snapshot: {
    articles: Array.from({ length: 65 }, (_, i) => ({ lineItemId: `line-${i}`, title: "Example technical polo", sizeLabel: `Size ${i + 1}`, colorLabel: "Navy blue - technical fabric", sku: `EXAMPLE-LONG-REFERENCE-${i}-WITH-EXTRA-CHARACTERS`, quantity: 2 })),
    personalizations: [{ type: "Broderie", location: "Poitrine gauche", quantity: 130, dimensions: "80 x 40 mm", color: "White", customText: "Example Yacht" }, { type: "Impression", location: "Dos", quantity: 130, dimensions: "200 x 150 mm", color: "White" }],
  } };
  const pdf = await renderArtworkSummary(proof);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 10000 && pdf.length < 2000000);
  await mkdir("test-results/artwork", { recursive: true });
  await writeFile("test-results/artwork/size-summary-multipage.pdf", pdf);
});
