import test from "node:test";
import assert from "node:assert/strict";
import { copyPersonalization, personalizationFileName, personalizationLabel } from "./personalization.js";
import { summarizeCase, snapshotPersonalization } from "./artwork-status.js";
import { noteAddedMarking, reopenProduction } from "./artwork-production.server.js";

const source = { id: "marking-chest001", productTitle: "Polo", type: "Broderie", location: "Poitrine gauche", quantity: 12,
  dimensions: "80 mm", color: "Navy", customText: "Yacht", logoUrl: "https://example.test/logo.ai", logoMimeType: "application/illustrator", logoFileName: "logo.ai",
  proofs: [{ status: "approuve", token: "private" }], status: "termine" };
test("duplicate copies editable specs and logo but excludes identity, BATs and approvals", () => {
  const copy = copyPersonalization(source, { quantity: 20 }, { sameItem: true });
  assert.equal(copy.quantity, 12);
  for (const key of ["type", "dimensions", "color", "location", "customText", "logoUrl", "logoMimeType", "logoFileName"]) assert.equal(copy[key], source[key]);
  for (const key of ["id", "proofs", "status", "token", "lineItemId"]) assert.equal(key in copy, false);
  assert.equal(copyPersonalization(source, { quantity: 8 }, { sameItem: true }).quantity, 8);
  assert.equal(copyPersonalization(source, { quantity: 20 }).quantity, 20);
  assert.equal(copyPersonalization({ ...source, logoUrl: null }, { quantity: 20 }, { sameItem: true }).location, source.location);
});
test("labels distinguish identical markings and frozen versions, including English client output", () => {
  assert.notEqual(personalizationLabel(source), personalizationLabel({ ...source, id: "marking-chest002" }));
  const snapshot = snapshotPersonalization(source);
  assert.equal(personalizationLabel(snapshot), personalizationLabel(source));
  assert.match(personalizationLabel(snapshot, { english: true }), /Polo · Embroidery · Left chest/);
  assert.equal(personalizationLabel({ productTitle: "Legacy Polo" }), "Legacy Polo");
});
test("two markings on one article require independent BAT approval without doubling articles", () => {
  const items = [{ lineItemId: "line", requirement: "required", quantity: 20 }];
  const p = { ...source, lineItemId: "line", proofs: [{ status: "approuve", isCurrent: true }] };
  const copy = { ...copyPersonalization(p, items[0], { sameItem: true }), id: "second", lineItemId: "line", proofs: [] };
  assert.equal(summarizeCase(items, [p]).status, "valide");
  assert.equal(summarizeCase(items, [p, copy]).status, "a_personnaliser");
  copy.proofs = [{ status: "en_attente", isCurrent: true }];
  assert.equal(summarizeCase(items, [p, copy]).status, "a_envoyer");
  copy.proofs[0].status = "modification_demandee";
  assert.equal(summarizeCase(items, [p, copy]).status, "a_corriger");
  copy.proofs[0].status = "approuve";
  assert.equal(summarizeCase(items, [p, copy]).status, "valide");
  assert.equal(summarizeCase(items, [p, copy]).required, 1);
  assert.equal(items[0].quantity, 20);
  assert.equal(p.proofs[0].status, "approuve");
});
test("revising a completed/transmitted marking reopens only its card and keeps transmission history", async () => {
  const writes = [], events = [];
  const card = { id: "card", status: "termine", archivedAt: new Date(), lastSentAt: new Date(), lastSentTo: "partner@example.test" };
  const db = { kanbanCard: {
    findUnique: async ({ where }) => { assert.equal(where.personalizationId, source.id); return card; },
    update: async (args) => writes.push(args),
  }, artworkEvent: { create: async ({ data }) => events.push(data) } };
  await reopenProduction(db, source, "case");
  assert.deepEqual(writes, [{ where: { id: "card" }, data: { status: "a_faire", archivedAt: null } }]);
  assert.match(events[0].message, /termine.*partner@example.test/);
  assert.equal(card.lastSentTo, "partner@example.test");
});
test("new markings warn when production was already started without resetting unrelated cards", async () => {
  const events = [];
  const db = { kanbanCard: { findFirst: async ({ where }) => {
    assert.equal(where.shop, "shop"); assert.equal(where.draftOrderId, "draft"); return { id: "existing" };
  } }, artworkEvent: { create: async ({ data }) => events.push(data) } };
  await noteAddedMarking(db, { ...source, shop: "shop", draftOrderId: "draft" }, "case");
  assert.equal(events.length, 1);
  assert.match(events[0].message, /Marquage ajouté après/);
});

test("download names identify the marking while preserving file format", () => {
  const name = personalizationFileName(source, "logo/production.ai");
  assert.match(name, /chest001.*logo_production\.ai$/);
  assert.notEqual(name, personalizationFileName({ ...source, id: "marking-back0001" }, "logo/production.ai"));
});
