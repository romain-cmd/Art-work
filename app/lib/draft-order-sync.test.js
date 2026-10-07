/* eslint-env node */
import test from "node:test";
import assert from "node:assert/strict";
import { fetchDraftLineItems, planPersonalizationSync, syncDraftPersonalizations } from "./draft-order-sync.server.js";

const item = (id, variantId = "v1", quantity = 3, title = "Polo") =>
  ({ id, title, quantity, custom: false, variant: { id: variantId } });
const personalization = (overrides = {}) => ({
  id: "p1", lineItemId: "old", variantId: "v1", productTitle: "Polo",
  quantity: 3, sourceQuantity: 3, isActive: true, ...overrides,
});

test("quantity and title follow Shopify without modifying BATs, logos or placement", () => {
  const [update] = planPersonalizationSync([personalization({ proofs: [{ id: "bat1" }], logoUrl: "logo", location: "Dos" })],
    [item("old", "v1", 7, "Technical Polo")]);
  assert.equal(update.data.quantity, 7);
  assert.equal(update.data.productTitle, "Technical Polo");
  assert.equal(update.data.isActive, true);
  assert.equal("proofs" in update.data, false);
  assert.equal("logoUrl" in update.data, false);
  assert.equal("location" in update.data, false);
});

test("regenerated IDs retain every personalization for the same variant", () => {
  const updates = planPersonalizationSync([personalization(), personalization({ id: "p2", type: "Impression" })], [item("new")]);
  assert.equal(updates.length, 2);
  assert.ok(updates.every((u) => u.data.lineItemId === "new" && u.data.isActive));
});

test("removed and replaced variants are archived without deleting their BATs", () => {
  assert.deepEqual(planPersonalizationSync([personalization()], []), [{ id: "p1", data: { isActive: false } }]);
  assert.deepEqual(planPersonalizationSync([personalization()], [item("old", "v2")]), [{ id: "p1", data: { isActive: false } }]);
});

test("duplicate variants never receive a BAT through an ambiguous remap", () => {
  const updates = planPersonalizationSync([personalization(), personalization({ id: "p2", lineItemId: "other" })],
    [item("new1"), item("new2")]);
  assert.ok(updates.every((u) => u.data.isActive === false));
});

test("exact matches take priority over variant fallback", () => {
  const updates = planPersonalizationSync([personalization(), personalization({ id: "p2", lineItemId: "other" })],
    [item("old"), item("new")]);
  assert.deepEqual(updates, [{ id: "p2", data: { lineItemId: "new", variantId: "v1", productTitle: "Polo", sourceQuantity: 3, quantity: 3, isActive: true } }]);
});

test("legacy records remap only when the title identifies one line", () => {
  const legacy = personalization({ variantId: null, sourceQuantity: null });
  assert.equal(planPersonalizationSync([legacy], [item("new")])[0].data.lineItemId, "new");
  assert.equal(planPersonalizationSync([legacy], [item("new1"), item("new2", "v2")])[0].data.isActive, false);
});

test("an archived BAT is not assigned to a newly added product", () => {
  assert.deepEqual(planPersonalizationSync([personalization({ isActive: false })], [item("new")]), []);
});

test("repeated saves are idempotent and preserve manually chosen quantities until a source change", () => {
  const p = personalization({ quantity: 2 });
  assert.deepEqual(planPersonalizationSync([p], [item("old")]), []);
  assert.equal(planPersonalizationSync([p], [item("old", "v1", 5)])[0].data.quantity, 5);
});

test("new products appear without inheriting an existing personalization", () => {
  assert.deepEqual(planPersonalizationSync([personalization()], [item("old"), item("new", "v2")]), []);
});

test("pagination includes products after the first page and excludes custom fees", async () => {
  const variables = [];
  const admin = { graphql: async (_query, options) => {
    variables.push(options.variables);
    return { json: async () => ({ data: { draftOrder: { lineItems: {
      edges: [{ node: item("second", "v2") }, { node: { ...item("fee"), custom: true } }],
      pageInfo: { hasNextPage: false, endCursor: "end" },
    } } } }) };
  } };
  const edges = await fetchDraftLineItems(admin, "draft", {
    edges: [{ node: item("first") }], pageInfo: { hasNextPage: true, endCursor: "cursor" },
  });
  assert.deepEqual(edges.map(({ node }) => node.id), ["first", "second"]);
  assert.deepEqual(variables, [{ id: "draft", after: "cursor" }]);
});

test("API failures never become an empty list that could archive every BAT", async () => {
  const admin = { graphql: async () => ({ json: async () => ({ errors: [{ message: "Throttled" }] }) }) };
  await assert.rejects(fetchDraftLineItems(admin, "draft"));
});

test("database reconciliation scopes records to the shop and draft and updates transactionally", async () => {
  const calls = [];
  const tx = { personalization: {
    findMany: async (args) => { calls.push(args); return [personalization()]; },
    update: async (args) => { calls.push(args); },
  } };
  await syncDraftPersonalizations({ $transaction: (fn) => fn(tx) }, "myw", "draft", [item("new")]);
  assert.deepEqual(calls[0], { where: { shop: "myw", draftOrderId: "draft" } });
  assert.equal(calls[1].where.id, "p1");
  assert.equal(calls[1].data.lineItemId, "new");
});
