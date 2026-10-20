import test from "node:test";
import assert from "node:assert/strict";
import { fixtureServer } from "./fixture.mjs";

const env = await fixtureServer();
test.after(() => env.server.close());
const request = (data) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(data)) body.set(key, value);
  return new Request("http://localhost/app/personnalisation", { method: "POST", body });
};
const save = (extra = {}) => env.routes.artwork.action({ request: request({ intent: "save-personalization", caseId: "case", lineItemId: "line", reuseId: "marking-chest001", duplicateSourceId: "marking-chest001", type: "Impression", quantity: "12", dimensions: "200 mm", color: "White", location: "Dos", customText: "Example Yacht", ...extra }) });

test("actual route actions: duplicate, validate, produce, revise independently", async () => {
  env.reset();
  const { state } = env.fixture;
  const original = structuredClone(state.proof[0]);
  assert.equal((await save()).success, true);
  assert.equal(state.artworkItem.length, 1);
  assert.equal(state.artworkItem[0].quantity, 20);
  assert.equal(state.personalization.length, 2);
  const added = state.personalization[1];
  assert.equal(added.lineItemId, state.personalization[0].lineItemId);
  assert.equal(added.quantity, 12);
  assert.equal(added.location, "Dos");
  assert.equal(state.proof.length, 1, "approvals/BATs are never copied");
  assert.equal(state.kanbanCard.length, 2);
  const card = state.kanbanCard.find((c) => c.personalizationId === added.id);
  assert.equal(card.status, "a_faire");
  assert.ok(state.artworkEvent.some((e) => /Marquage ajouté après/.test(e.message)));
  let rows = (await env.routes.production.loader({ request: new Request("http://localhost/app/kanban") })).rows;
  assert.ok(rows.every((row) => row.blocked));
  const move = (status) => env.routes.production.action({ request: request({ cardId: card.id, intent: "move-card", status }) });
  assert.match((await move("en_cours")).error, /bloquée/);
  const upload = await env.routes.artwork.action({ request: request({ intent: "add-proofs", caseId: "case", personalizationId: added.id, proofImages: new File(["fixture"], "back.png", { type: "image/png" }) }) });
  assert.equal(upload.success, true);
  const proof = state.proof.find((p) => p.personalizationId === added.id);
  const sent = await env.routes.artwork.action({ request: request({ intent: "send-for-validation", caseId: "case", customerEmail: "client@example.test", sendMode: "new", proofIds: proof.id }) });
  assert.equal(sent.success, true);
  assert.equal(env.fixture.emails.length, 1);
  assert.match(env.fixture.emails[0].html, /Print · Back/);
  assert.equal((await env.routes.review.action({ request: request({ token: proof.token, decision: "approuve" }) })).success, true);
  rows = (await env.routes.production.loader({ request: new Request("http://localhost/app/kanban") })).rows;
  assert.ok(rows.every((row) => !row.blocked));
  const partnerSend = await env.routes.production.action({ request: request({ cardId: card.id, intent: "email-card", partnerEmail: "printer@example.test" }) });
  assert.equal(partnerSend.success, true);
  const email = env.fixture.emails.at(-1);
  assert.match(email.html, /Impression · Dos/);
  assert.match(email.attachments[0].filename, /Impression · Dos.*back\.png$/);
  assert.equal(email.attachments.length, 1, "only this marking's current approved BAT is sent");
  assert.equal((await move("en_cours")).success, true);
  assert.equal((await move("termine")).success, true);
  const updated = await save({ personalizationId: added.id, reuseId: "", duplicateSourceId: "", color: "Red" });
  assert.equal(updated.success, true);
  assert.equal(card.status, "a_faire");
  assert.equal(proof.isCurrent, false);
  assert.equal(state.proof.filter((p) => p.personalizationId === added.id && p.isCurrent)[0].status, "en_attente");
  assert.deepEqual(state.proof.find((p) => p.id === original.id), original, "the original marking keeps its approval");
  assert.match((await env.routes.review.action({ request: request({ token: proof.token, decision: "approuve" }) })).error, /no longer/);
  assert.equal(state.kanbanCard.find((c) => c.id === "card-chest").status, "en_cours");
});

test("server rejects foreign sources, wrong articles, invalid quantities and archived dossiers", async () => {
  for (const extra of [{ reuseId: "foreign" }, { lineItemId: "foreign" }, { quantity: "21" }, { quantity: "0" }, { quantity: "1.5" }]) {
    env.reset();
    assert.equal((await save(extra)).success, false);
    assert.equal(env.fixture.state.personalization.length, 1);
  }
  env.reset();
  env.fixture.state.personalization[0].shop = "other-shop";
  assert.equal((await save()).success, false);
  env.reset();
  env.fixture.state.artworkCase[0].archivedAt = new Date();
  assert.equal((await save()).success, false);
});

test("Shopify reconciliation updates every marking and reopens only affected production", async () => {
  env.reset();
  assert.equal((await save()).success, true);
  env.fixture.state.artworkItem[0].quantity = 30;
  const result = await env.routes.artwork.loader({ request: new Request("http://localhost/app/personnalisation?case=case") });
  assert.ok(result.selected.personalizations.every((p) => p.quantity === 30 && p.sourceQuantity === 30));
  assert.equal(env.fixture.state.kanbanCard[0].status, "a_faire");
  assert.equal(env.fixture.state.proof[0].isCurrent, false);
});

test("same-article duplication retains a source logo without copying proofs", async () => {
  env.reset();
  Object.assign(env.fixture.state.personalization[0], { logoUrl: "https://example.test/logo.ai", logoMimeType: "application/illustrator", logoFileName: "logo.ai" });
  assert.equal((await save()).success, true);
  const p = env.fixture.state.personalization[1];
  assert.equal(p.logoUrl, "https://example.test/logo.ai");
  assert.equal(p.logoFileName, "logo.ai");
  assert.equal(p.logoMimeType, "application/illustrator");
  assert.equal(env.fixture.state.proof.length, 1);
});
