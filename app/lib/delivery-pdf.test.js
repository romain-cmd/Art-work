import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  makeSnapshot,
  normalizeOrder,
  digest,
  RECEIPT_STATEMENT,
} from "./delivery-core.server.js";
import { renderDeliveryPdf } from "./delivery-pdf.server.js";
import { rawOrder, strokes } from "../../tests/deliveries/fixtures.mjs";
test("multipage delivery PDF wraps long product descriptions and reservations", async () => {
  const raw = rawOrder("900");
  const order = normalizeOrder(raw);
  const snapshot = makeSnapshot(
    order,
    [],
    {
      quantities: { [order.items[0].id]: 3 },
      instructions: "TEST ONLY. This document uses fictional data.",
      packages: 2,
    },
    { id: "test", name: "Example Representative" },
    900,
    new Date("2026-10-12T12:00:00Z"),
  );
  snapshot.items = Array.from({ length: 45 }, (_, i) => ({
    ...snapshot.items[0],
    lineItemId: `test-${i}`,
    title: `TEST ${i + 1}: Technical Polo with a deliberately long product description to verify line wrapping and page breaks`,
    variantTitle: "White / Medium",
    sku: `TEST-SKU-${i + 1}`,
  }));
  snapshot.totalQuantity = 135;
  const receipt = {
    name: "Demo Recipient",
    role: "Chief Stewardess",
    signedAt: "2026-10-12T12:30:00Z",
    reservations: "TEST ONLY. ".repeat(40),
    statement: RECEIPT_STATEMENT,
    strokes,
  };
  const pdf = await renderDeliveryPdf(
    snapshot,
    receipt,
    digest({ snapshot, receipt }),
  );
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 10000 && pdf.length < 5000000);
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/delivery-multipage-example.pdf", pdf);
});
