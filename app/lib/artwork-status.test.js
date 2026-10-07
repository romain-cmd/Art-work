import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCase, isPersonalizationApproved, snapshotPersonalization, fileExtension, acceptsBat } from "./artwork-status.js";
const item = (id, requirement = "required") => ({ lineItemId: id, requirement, isActive: true });
const proof = (status = "approuve", extra = {}) => ({ status, isCurrent: true, ...extra });
const personalization = (id, proofs) => ({ lineItemId: id, isActive: true, proofs });
test("one approved article cannot hide a required article without a personalization", () => {
  assert.equal(summarizeCase([item("a"), item("b")], [personalization("a", [proof()])]).status, "a_personnaliser");
});
test("a personalization without BAT blocks the dossier even when other BATs are approved", () => {
  assert.equal(summarizeCase([item("a")], [personalization("a", [proof()]), personalization("a", [])]).status, "a_personnaliser");
});
test("articles without BAT do not block approved required articles", () => {
  const summary = summarizeCase([item("a"), item("b", "none")], [personalization("a", [proof()]), personalization("b", [proof("modification_demandee")])]);
  assert.equal(summary.status, "valide"); assert.equal(summary.total, 1);
});
test("new Shopify lines must be qualified before all-approved status", () => {
  assert.equal(summarizeCase([item("a"), item("b", "pending")], [personalization("a", [proof()])]).status, "a_personnaliser");
});
test("old versions cannot keep a dossier approved or in correction", () => {
  const ps = [personalization("a", [proof("modification_demandee", { isCurrent: false }), proof("en_attente")])];
  assert.equal(summarizeCase([item("a")], ps).status, "a_envoyer");
  assert.equal(isPersonalizationApproved(ps[0]), false);
});
test("sending and reminding use distinct states", () => {
  assert.equal(summarizeCase([item("a")], [personalization("a", [proof("en_attente", { envoyeLe: new Date() })])]).status, "en_attente_reponse");
});
test("production requires every current view to be approved", () => {
  assert.equal(isPersonalizationApproved(personalization("a", [proof(), proof("en_attente")])), false);
  assert.equal(isPersonalizationApproved(personalization("a", [proof(), proof("approuve", { isCurrent: false })])), true);
  assert.equal(isPersonalizationApproved(personalization("a", [])), false);
});
test("all explicitly excluded articles form a no-BAT dossier", () => {
  assert.equal(summarizeCase([item("a", "none")], []).status, "sans_bat");
});
test("snapshot keeps previous specifications when the personalization changes", () => {
  const p = { productTitle: "Polo", quantity: 24, dimensions: "80 mm", color: "Navy" }; const frozen = snapshotPersonalization(p); p.quantity = 30;
  assert.equal(frozen.quantity, 24); assert.equal(frozen.dimensions, "80 mm");
});
test("BAT formats are viewable and file extensions preserve source format", () => {
  assert.equal(acceptsBat({ type: "application/postscript", size: 100 }), false);
  assert.equal(acceptsBat({ type: "application/pdf", size: 1024 }), true);
  assert.equal(acceptsBat({ type: "image/png", size: 21 * 1024 * 1024 }), false);
  assert.equal(fileExtension("application/pdf"), ".pdf"); assert.equal(fileExtension(null, "https://cdn.shopify.com/logo.ai?v=1"), ".ai");
});
