/* eslint-env node, es2020 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createArtwork } from "../../app/lib/shared-artwork.server.js";

test("workspace migration persists shop templates and optional dossier owners without affecting proofs", { skip: process.env.DELIVERY_TEST_DATABASE !== "1" }, async () => {
  const { PrismaClient } = await import("@prisma/client"); const db = new PrismaClient(); const shop = `workspace-test-${randomUUID()}`;
  try {
    const dossier = await db.artworkCase.create({ data: { shop, draftOrderId: "draft", name: "D1" } });
    assert.equal(dossier.responsibleName, null);
    await db.artworkCase.update({ where: { id: dossier.id }, data: { responsibleName: "Romain" } });
    const template = await db.artworkTemplate.create({ data: { shop, name: "Broderie yacht", specs: { type: "Broderie", dimensions: "80 × 35 mm", logoUrl: "https://example.test/logo.pdf" } } });
    assert.equal((await db.artworkCase.findUnique({ where: { id: dossier.id } })).responsibleName, "Romain");
    assert.equal((await db.artworkTemplate.findFirst({ where: { shop } })).specs.logoUrl, "https://example.test/logo.pdf");
    assert.equal(await db.artworkTemplate.count({ where: { shop: `${shop}-other` } }), 0);
    await db.artworkTemplate.delete({ where: { id: template.id } });
    assert.equal(await db.artworkCase.count({ where: { shop } }), 1);
  } finally { await db.artworkTemplate.deleteMany({ where: { shop } }); await db.artworkCase.deleteMany({ where: { shop } }); await db.$disconnect(); }
});

test("shared artwork migration preserves old tokens, responses and ownership", { skip: process.env.DELIVERY_TEST_DATABASE !== "1" }, async () => {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  const schema = `artwork_${randomUUID().replaceAll("-", "")}`;
  const rollback = new Error("intentional test rollback");
  try {
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe('CREATE TABLE "Personalization" ("id" TEXT PRIMARY KEY)');
      await tx.$executeRawUnsafe('CREATE TABLE "ArtworkItem" ("id" TEXT PRIMARY KEY)');
      await tx.$executeRawUnsafe('CREATE TABLE "Proof" ("id" TEXT PRIMARY KEY, "personalizationId" TEXT NOT NULL, "token" TEXT NOT NULL, "status" TEXT NOT NULL)');
      await tx.$executeRawUnsafe(`INSERT INTO "Personalization" VALUES ('legacy')`);
      await tx.$executeRawUnsafe(`INSERT INTO "Proof" VALUES ('proof', 'legacy', 'existing-token', 'approuve')`);
      const sql = await readFile(new URL("../../prisma/migrations/20261020160000_shared_artwork/migration.sql", import.meta.url), "utf8");
      const protectedSql = sql.replace(/\$\$[\s\S]*?\$\$/g, (body) => body.replaceAll(";", "__BODY_SEMICOLON__"));
      for (const statement of protectedSql.split(";").map((s) => s.replaceAll("__BODY_SEMICOLON__", ";").trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
      assert.deepEqual(await tx.$queryRawUnsafe('SELECT "A", "B" FROM "_ProofMarkings"'), [{ A: "legacy", B: "proof" }]);
      assert.deepEqual(await tx.$queryRawUnsafe('SELECT "token", "status", "deletedAt" FROM "Proof"'), [{ token: "existing-token", status: "approuve", deletedAt: null }]);
      await tx.$executeRawUnsafe(`INSERT INTO "Proof" ("id", "personalizationId", "token", "status") VALUES ('late-proof', 'legacy', 'late-token', 'en_attente')`);
      assert.equal((await tx.$queryRawUnsafe(`SELECT * FROM "_ProofMarkings" WHERE "B" = 'late-proof'`)).length, 1, "older app inserts during rollout retain their association");
      throw rollback;
    }), (error) => error === rollback);
  } finally { await db.$disconnect(); }
});

test("Prisma shares one proof across two markings and preserves the old approval on replacement", { skip: process.env.DELIVERY_TEST_DATABASE !== "1" }, async () => {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  const shop = `artwork-test-${randomUUID()}`;
  try {
    await db.artworkItem.create({ data: { shop, draftOrderId: "draft", lineItemId: "line", title: "Polo", quantity: 20, requirement: "required", productId: "product", sizeLabel: "M", colorLabel: "Navy" } });
    const markings = [];
    for (const type of ["Broderie", "Impression"]) markings.push(await db.personalization.create({ data: { shop, draftOrderId: "draft", lineItemId: "line", productTitle: "Polo", type, quantity: 20 } }));
    await db.artworkItem.create({ data: { shop, draftOrderId: "draft", lineItemId: "line-L", title: "Polo", quantity: 10, requirement: "required", productId: "product", sizeLabel: "L", colorLabel: "Navy" } });
    for (const type of ["Broderie", "Impression"]) markings.push(await db.personalization.create({ data: { shop, draftOrderId: "draft", lineItemId: "line-L", productTitle: "Polo", type, quantity: 10 } }));
    const proof = await db.$transaction((tx) => createArtwork(tx, markings, { imageUrl: "https://example.test/common.pdf", mimeType: "application/pdf", fileName: "common.pdf" }));
    const linked = await db.personalization.findMany({ where: { shop }, include: { proofs: true } });
    assert.ok(linked.every((p) => p.proofs.length === 1 && p.proofs[0].id === proof.id));
    await db.proof.update({ where: { id: proof.id }, data: { status: "approuve" } });
    const approved = await db.proof.findUnique({ where: { id: proof.id } });
    const next = await db.$transaction((tx) => createArtwork(tx, markings, { ...approved, imageUrl: "https://example.test/revised.pdf" }, approved));
    assert.equal(next.status, "en_attente");
    assert.equal(next.version, 2);
    assert.equal(next.snapshot.articles.length, 2);
    assert.equal(next.snapshot.articles.reduce((sum, i) => sum + i.quantity, 0), 30);
    assert.notEqual(next.token, approved.token);
    assert.equal(next.snapshot.personalizations.length, 4);
    assert.equal((await db.proof.findUnique({ where: { id: proof.id } })).status, "approuve");
    await db.proof.update({ where: { id: next.id }, data: { deletedAt: new Date(), isCurrent: false } });
    assert.equal(await db.proof.count({ where: { isCurrent: true, personalizations: { some: { shop } } } }), 0);
  } finally {
    await db.proof.deleteMany({ where: { personalization: { shop } } });
    await db.personalization.deleteMany({ where: { shop } });
    await db.artworkItem.deleteMany({ where: { shop } });
    await db.$disconnect();
  }
});
