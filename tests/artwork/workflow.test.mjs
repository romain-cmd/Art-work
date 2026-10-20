import test from "node:test";
import assert from "node:assert/strict";
import { fixtureServer } from "./fixture.mjs";
import { builderFingerprint } from "../../app/lib/artwork-workspace.js";

const env = await fixtureServer();
test.after(() => env.server.close());
const request = (data) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(data)) { if (Array.isArray(value)) value.forEach((v) => body.append(key, v)); else body.set(key, value); }
  return new Request("http://localhost/app/personnalisation", { method: "POST", body });
};
const save = (extra = {}) => env.routes.artwork.action({ request: request({ intent: "save-personalization", caseId: "case", lineItemId: "line", reuseId: "marking-chest001", duplicateSourceId: "marking-chest001", type: "Impression", quantity: "12", dimensions: "200 mm", color: "White", location: "Dos", customText: "Example Yacht", ...extra }) });

function builderData(extra = {}) {
  const { state } = env.fixture;
  const selectedItems = state.artworkItem.map((i) => i.id);
  return { intent: "prepare-artwork", caseId: "case", selectedItems: JSON.stringify(selectedItems),
    preparationFingerprint: builderFingerprint({ items: state.artworkItem, personalizations: state.personalization.map((p) => ({ ...p, proofs: state.proof.filter((pr) => (pr._markingIds || [pr.personalizationId]).includes(p.id)) })) }, selectedItems),
    existingIds: "[]", markings: JSON.stringify([{ key: "first", type: "Broderie", location: "Poitrine gauche", dimensions: "80 × 35 mm", quantities: Object.fromEntries(state.artworkItem.map((i) => [i.id, i.quantity])) }]),
    proofImages: new File(["fixture"], "common.png", { type: "image/png" }), ...extra };
}
function freshBuilder() {
  env.reset(); const { state } = env.fixture;
  state.personalization = []; state.proof = []; state.kanbanCard = [];
  state.artworkItem.push({ ...state.artworkItem[0], id: "large", lineItemId: "line-L", variantId: "variant-L", variantTitle: "Navy / L", sizeLabel: "L", quantity: 30, requirement: "pending" });
}

test("guided preparation saves two markings across sizes atomically with separate garment and marking totals", async () => {
  freshBuilder(); const data = builderData();
  const rows = JSON.parse(data.markings); rows.push({ key: "second", type: "Impression", location: "Dos", quantities: { article: 12, large: 15 } }); data.markings = JSON.stringify(rows);
  assert.equal((await env.routes.artwork.action({ request: request(data) })).success, true);
  const { state } = env.fixture;
  assert.equal(state.proof.length, 1); assert.equal(state.personalization.length, 4); assert.equal(state.kanbanCard.length, 4);
  assert.ok(state.artworkItem.every((i) => i.requirement === "required"));
  assert.equal(state.proof[0].snapshot.articles.reduce((n, i) => n + i.quantity, 0), 50);
  assert.deepEqual(state.personalization.filter((p) => p.type === "Impression").map((p) => p.quantity), [12, 15]);
  assert.equal(env.fixture.emails.length, 0, "preparing is separate from sending");
});

test("guided preparation rejects stale Shopify data, foreign products, invalid quantities and unconfirmed colours", async () => {
  for (const scenario of ["stale", "product", "quantity", "colour"]) {
    freshBuilder();
    if (scenario === "product") env.fixture.state.artworkItem[1].productId = "foreign";
    if (scenario === "colour") env.fixture.state.artworkItem[1].colorLabel = "White";
    const data = builderData();
    if (scenario === "stale") data.preparationFingerprint = "old";
    if (scenario === "quantity") { const rows = JSON.parse(data.markings); rows[0].quantities.large = 31; data.markings = JSON.stringify(rows); }
    assert.equal((await env.routes.artwork.action({ request: request(data) })).success, false, scenario);
    assert.equal(env.fixture.state.proof.length, 0); assert.equal(env.fixture.state.personalization.length, 0);
  }
  freshBuilder(); env.fixture.state.artworkItem[1].colorLabel = "White";
  assert.equal((await env.routes.artwork.action({ request: request(builderData({ confirmColors: "yes" })) })).success, true);
});

test("templates are shop scoped and retain only specifications; dossier assignment is editable", async () => {
  env.reset(); env.fixture.state.personalization[0].logoUrl = "https://example.test/logo.pdf";
  assert.equal((await env.routes.artwork.action({ request: request({ intent: "save-template", caseId: "case", personalizationId: "marking-chest001", templateName: "Broderie yacht" }) })).success, true);
  const template = env.fixture.state.artworkTemplate[0];
  assert.equal(template.specs.logoUrl, "https://example.test/logo.pdf"); assert.equal(template.specs.quantity, undefined); assert.equal(template.specs.proofs, undefined);
  assert.equal((await env.routes.artwork.action({ request: request({ intent: "assign-case", caseId: "case", responsibleName: "Romain" }) })).success, true);
  assert.equal(env.fixture.state.artworkCase[0].responsibleName, "Romain");
  env.fixture.state.personalization = []; env.fixture.state.proof = []; env.fixture.state.kanbanCard = [];
  const data = builderData(); const rows = JSON.parse(data.markings); rows[0].templateId = template.id; data.markings = JSON.stringify(rows);
  assert.equal((await env.routes.artwork.action({ request: request(data) })).success, true);
  assert.equal(env.fixture.state.personalization[0].logoUrl, "https://example.test/logo.pdf");
  template.shop = "other-shop";
  assert.equal((await env.routes.artwork.action({ request: request({ intent: "delete-template", caseId: "case", templateId: template.id }) })).success, false);
});

test("client corrections identify a marking and optionally a bounded point in the artwork", async () => {
  env.reset(); const proof = env.fixture.state.proof[0]; proof.status = "en_attente";
  const reply = { token: proof.token, decision: "modification_demandee", commentaireClient: "Make this smaller", changeTarget: "0", pointX: "25", pointY: "40" };
  assert.ok((await env.routes.review.action({ request: request({ ...reply, changeTarget: "999" }) })).error);
  assert.ok((await env.routes.review.action({ request: request({ ...reply, pointX: "101" }) })).error);
  assert.equal(proof.status, "en_attente");
  assert.equal((await env.routes.review.action({ request: request(reply) })).success, true);
  assert.match(proof.commentaireClient, /Point 1 \(25% from left, 40% from top\): Embroidery · Left chest/);
});

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
  const upload = await env.routes.artwork.action({ request: request({ intent: "add-article-proofs", itemId: "article", markingId: added.id, caseId: "case", proofImages: new File(["fixture"], "back.png", { type: "image/png" }) }) });
  assert.equal(upload.success, true);
  const proof = state.proof.find((p) => p.personalizationId === added.id);
  const sent = await env.routes.artwork.action({ request: request({ intent: "send-for-validation", caseId: "case", customerEmail: "client@example.test", sendMode: "new", proofIds: proof.id }) });
  assert.equal(sent.success, true);
  assert.equal(env.fixture.emails.length, 1);
  assert.match(env.fixture.emails[0].html, /Polo · 1 marking/);
  assert.equal((await env.routes.review.action({ request: request({ token: proof.token, decision: "approuve" }) })).success, true);
  rows = (await env.routes.production.loader({ request: new Request("http://localhost/app/kanban") })).rows;
  assert.ok(rows.every((row) => !row.blocked));
  const partnerSend = await env.routes.production.action({ request: request({ cardId: card.id, intent: "email-card", partnerEmail: "printer@example.test" }) });
  assert.equal(partnerSend.success, true);
  const email = env.fixture.emails.at(-1);
  assert.match(email.html, /Impression · Dos/);
  assert.match(email.attachments[0].filename, /Impression · Dos.*back\.png$/);
  assert.equal(email.attachments.length, 2, "only this marking's current approved BAT and its size summary are sent");
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

test("one shared artwork: one email entry, both markings, one approval, replacement and deletion", async () => {
  env.reset();
  assert.equal((await save()).success, true);
  const ids = env.fixture.state.personalization.map((p) => p.id);
  const link = await env.routes.artwork.action({ request: request({ intent: "link-proof", caseId: "case", itemId: "article", proofId: "proof-chest", markingId: ids }) });
  assert.equal(link.success, true);
  let proof = env.fixture.state.proof.find((p) => p.isCurrent);
  assert.equal(proof.version, 2);
  assert.equal(proof.snapshot.personalizations.length, 2);
  const loaded = await env.routes.artwork.loader({ request: new Request("http://localhost/app/personnalisation?case=case") });
  const dossier = loaded.selected;
  assert.equal(loaded.cases[0].summary.total, 1, "a shared artwork is counted once");
  assert.ok(dossier.personalizations.every((p) => p.proofs.some((pr) => pr.id === proof.id)));
  const send = () => env.routes.artwork.action({ request: request({ intent: "send-for-validation", caseId: "case", customerEmail: "client@example.test", sendMode: "new", proofIds: proof.id }) });
  assert.equal((await send()).success, true);
  assert.equal((env.fixture.emails[0].html.match(/<li>/g) || []).length, 1);
  const review = await env.routes.review.loader({ request: new Request(`http://localhost/proof-review?tokens=${proof.token}`) });
  assert.equal(review.proofs.length, 1);
  assert.equal(review.proofs[0].markings.length, 2);
  assert.equal((await env.routes.review.action({ request: request({ token: proof.token, decision: "modification_demandee", commentaireClient: "Make back print smaller" }) })).success, true);
  let rows = (await env.routes.production.loader({ request: new Request("http://localhost/app/kanban") })).rows;
  assert.ok(rows.every((row) => row.blocked));
  const oldToken = proof.token;
  assert.equal((await env.routes.artwork.action({ request: request({ intent: "revise-proof", caseId: "case", itemId: "article", proofId: proof.id, markingId: ids, proofImages: new File(["new"], "common.png", { type: "image/png" }) }) })).success, true);
  proof = env.fixture.state.proof.find((p) => p.isCurrent);
  assert.equal(proof.version, 3);
  assert.equal(proof.envoyeLe, null);
  assert.equal((await send()).success, true);
  assert.equal((await env.routes.review.action({ request: request({ token: proof.token, decision: "approuve" }) })).success, true);
  rows = (await env.routes.production.loader({ request: new Request("http://localhost/app/kanban") })).rows;
  assert.ok(rows.every((row) => !row.blocked));
  assert.match((await env.routes.review.action({ request: request({ token: oldToken, decision: "approuve" }) })).error, /no longer/);
  assert.equal((await env.routes.artwork.action({ request: request({ intent: "delete-proof", caseId: "case", itemId: "article", proofId: proof.id }) })).success, true);
  assert.ok(proof.deletedAt);
  assert.equal((await env.routes.review.loader({ request: new Request(`http://localhost/proof-review?tokens=${proof.token}`) })).proofs.length, 0);
  assert.match((await env.routes.review.action({ request: request({ token: proof.token, decision: "approuve" }) })).error, /no longer/);
  assert.ok((await env.routes.production.loader({ request: new Request("http://localhost/app/kanban") })).rows.every((row) => row.blocked));
});

test("changing one marking or Shopify quantities revises the shared artwork exactly once", async () => {
  env.reset();
  await save();
  const ids = env.fixture.state.personalization.map((p) => p.id);
  await env.routes.artwork.action({ request: request({ intent: "link-proof", caseId: "case", itemId: "article", proofId: "proof-chest", markingId: ids }) });
  const shared = env.fixture.state.proof.find((p) => p.isCurrent);
  assert.equal((await save({ personalizationId: ids[1], reuseId: "", duplicateSourceId: "", color: "Red" })).success, true);
  let current = env.fixture.state.proof.filter((p) => p.isCurrent);
  assert.equal(current.length, 1);
  assert.equal(current[0].version, shared.version + 1);
  assert.equal(current[0].snapshot.personalizations.find((p) => p.personalizationId === ids[1]).color, "Red");
  const version = current[0].version;
  env.fixture.state.artworkItem[0].quantity = 30;
  await env.routes.artwork.loader({ request: new Request("http://localhost/app/personnalisation?case=case") });
  current = env.fixture.state.proof.filter((p) => p.isCurrent);
  assert.equal(current.length, 1);
  assert.equal(current[0].version, version + 1);
  assert.ok(current[0].snapshot.personalizations.every((p) => p.quantity === 30));
});

test("shared artwork rejects foreign markings, empty selection, stale edits and oversized files", async () => {
  env.reset();
  for (const markingId of [[], ["foreign"], ["marking-chest001", "foreign"]]) {
    const result = await env.routes.artwork.action({ request: request({ intent: "link-proof", caseId: "case", itemId: "article", proofId: "proof-chest", markingId }) });
    assert.equal(result.success, false);
    assert.equal(env.fixture.state.proof.length, 1);
  }
  const oversized = await env.routes.artwork.action({ request: request({ intent: "add-article-proofs", caseId: "case", itemId: "article", markingId: "marking-chest001", proofImages: new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }) }) });
  assert.equal(oversized.success, false);
  assert.equal((await env.routes.artwork.action({ request: request({ intent: "delete-proof", caseId: "case", itemId: "article", proofId: "proof-chest" }) })).success, true);
  assert.equal((await env.routes.artwork.action({ request: request({ intent: "link-proof", caseId: "case", itemId: "article", proofId: "proof-chest", markingId: "marking-chest001" }) })).success, false);
});

test("two embroideries can share a single artwork without becoming one marking", async () => {
  env.reset();
  await save({ type: "Broderie", location: "Dos" });
  const markings = env.fixture.state.personalization;
  const result = await env.routes.artwork.action({ request: request({ intent: "link-proof", caseId: "case", itemId: "article", proofId: "proof-chest", markingId: markings.map((p) => p.id) }) });
  assert.equal(result.success, true);
  const artwork = env.fixture.state.proof.find((p) => p.isCurrent);
  assert.deepEqual(artwork.snapshot.personalizations.map((p) => p.type), ["Broderie", "Broderie"]);
  assert.deepEqual(artwork.snapshot.personalizations.map((p) => p.location), ["Poitrine gauche", "Dos"]);
});

test("group sizes: copy identical markings, snapshot quantities once and attach one PDF", async () => {
  env.reset(); await save();
  const { state } = env.fixture;
  state.artworkItem.push({ ...state.artworkItem[0], id: "large", lineItemId: "line-L", variantId: "variant-L", variantTitle: "Navy / L", sizeLabel: "L", quantity: 30, requirement: "pending" });
  const linked = await env.routes.artwork.action({ request: request({ intent: "link-proof", caseId: "case", itemId: "article", proofId: "proof-chest", markingId: state.personalization.map((p) => p.id), groupItemId: "large" }) });
  assert.equal(linked.success, true);
  assert.equal(state.artworkItem[1].requirement, "required");
  assert.equal(state.personalization.filter((p) => p.lineItemId === "line-L").length, 2);
  let proof = state.proof.find((p) => p.isCurrent);
  assert.equal(proof.snapshot.articles.length, 2);
  assert.equal(proof.snapshot.articles.reduce((sum, i) => sum + i.quantity, 0), 50);
  assert.equal(state.kanbanCard.length, 4);
  const sent = await env.routes.artwork.action({ request: request({ intent: "send-for-validation", caseId: "case", customerEmail: "client@example.test", sendMode: "new", proofIds: proof.id }) });
  assert.equal(sent.success, true);
  assert.equal(env.fixture.emails[0].attachments.length, 1);
  assert.ok(env.fixture.emails[0].attachments[0].filename.endsWith("-sizes.pdf"));
  const reviewed = await env.routes.review.loader({ request: new Request(`http://localhost/proof-review?tokens=${proof.token}`) });
  assert.equal(reviewed.proofs.length, 1);
  assert.equal(reviewed.proofs[0].markings.length, 2, "identical markings are summarized across sizes");
  assert.equal(reviewed.proofs[0].sizes.total, 50);
  assert.equal((await env.routes.review.action({ request: request({ token: proof.token, decision: "approuve" }) })).success, true);
  state.artworkItem[1].quantity = 40;
  await env.routes.artwork.loader({ request: new Request("http://localhost/app/personnalisation?case=case") });
  const next = state.proof.find((p) => p.isCurrent);
  assert.notEqual(next.id, proof.id);
  assert.equal(next.version, proof.version + 1);
  assert.equal(next.snapshot.articles.reduce((sum, i) => sum + i.quantity, 0), 60);
  assert.equal(proof.snapshot.articles.reduce((sum, i) => sum + i.quantity, 0), 50, "old summary is frozen");
});

test("group sizes rejects another product or a differently prepared design transactionally", async () => {
  for (const foreignProduct of [true, false]) {
    env.reset();
    const { state } = env.fixture;
    state.artworkItem.push({ ...state.artworkItem[0], id: "other", lineItemId: "other-line", productId: foreignProduct ? "another-product" : "product", variantId: "other-variant", sizeLabel: "L" });
    if (!foreignProduct) state.personalization.push({ ...state.personalization[0], id: "different", lineItemId: "other-line", variantId: "other-variant", type: "Impression" });
    const before = state.proof.length;
    const result = await env.routes.artwork.action({ request: request({ intent: "link-proof", caseId: "case", itemId: "article", proofId: "proof-chest", markingId: "marking-chest001", groupItemId: "other" }) });
    assert.equal(result.success, false);
    assert.equal(env.fixture.state.proof.length, before);
    assert.equal(env.fixture.state.proof[0].isCurrent, true);
  }
});
