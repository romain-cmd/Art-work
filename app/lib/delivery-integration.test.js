import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createRepresentative,
  mobileLogin,
  mobileSession,
  updateRepresentative,
} from "./delivery-access.server.js";
import {
  createDeliveryNote,
  deliveryDocument,
  signDeliveryNote,
  voidDeliveryNote,
} from "./delivery-notes.server.js";
import { sendDeliveryEmail } from "./delivery-email.server.js";
import {
  adminFor,
  inputFor,
  rawOrder,
  signatureInput,
} from "../../tests/deliveries/fixtures.mjs";
test(
  "delivery database, PDF and email integration",
  { skip: process.env.DELIVERY_TEST_DATABASE !== "1" },
  async (t) => {
    const { PrismaClient } = await import("@prisma/client");
    const db = new PrismaClient();
    const shop = `delivery-test-${randomUUID()}.myshopify.com`;
    const credentials = await createRepresentative(db, shop, {
      name: "Example Representative",
      email: "rep@example.test",
    });
    const access = new URL(credentials.link).searchParams.get("access");
    const cookie = await mobileLogin(db, access, credentials.pin);
    const session = await mobileSession(
      db,
      new Request("https://example.test/delivery", {
        headers: { Cookie: cookie.split(";")[0] },
      }),
    );
    let index = 200;
    const prepare = async (quantity) => {
      const raw = rawOrder(String(index++));
      const admin = adminFor(raw),
        input = inputFor(raw, { id: credentials.id }, quantity);
      const note = await createDeliveryNote(
        db,
        admin,
        shop,
        "Test operator",
        input,
      );
      return { raw, admin, input, note };
    };
    try {
      await t.test(
        "creation is idempotent and cancellation releases reserved quantities",
        async () => {
          const f = await prepare(3);
          const again = await createDeliveryNote(
            db,
            f.admin,
            shop,
            "Test operator",
            f.input,
          );
          assert.equal(again.id, f.note.id);
          await assert.rejects(
            createDeliveryNote(db, f.admin, shop, "Test operator", {
              ...f.input,
              packages: 3,
            }),
            (e) => e.status === 409,
          );
          await voidDeliveryNote(
            db,
            shop,
            f.note.id,
            "Test operator",
            "Test replacement",
          );
          const next = await createDeliveryNote(
            db,
            f.admin,
            shop,
            "Test operator",
            inputFor(f.raw, { id: credentials.id }, 10),
          );
          assert.equal(next.snapshot.totalQuantity, 10);
        },
      );
      await t.test(
        "concurrent allocation cannot exceed ordered quantities",
        async () => {
          const raw = rawOrder(String(index++), 5),
            admin = adminFor(raw);
          const results = await Promise.allSettled(
            [1, 2].map(() =>
              createDeliveryNote(
                db,
                admin,
                shop,
                "Test operator",
                inputFor(raw, { id: credentials.id }, 3),
              ),
            ),
          );
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(
            results.filter((r) => r.status === "rejected").length,
            1,
          );
        },
      );
      await t.test(
        "Shopify changes and missing agreement prevent signing",
        async () => {
          const f = await prepare(3);
          await assert.rejects(
            signDeliveryNote(
              db,
              f.admin,
              session,
              f.note.id,
              signatureInput(f.note, { agreed: null }),
            ),
            (e) => e.status === 400,
          );
          f.raw.lineItems.nodes[0].currentQuantity = 8;
          await assert.rejects(
            signDeliveryNote(
              db,
              f.admin,
              session,
              f.note.id,
              signatureInput(f.note),
            ),
            (e) => e.status === 409,
          );
          assert.equal(
            (await db.deliveryNote.findUnique({ where: { id: f.note.id } }))
              .status,
            "READY",
          );
          assert.equal(
            await db.deliveryDocument.count({ where: { noteId: f.note.id } }),
            0,
          );
        },
      );
      await t.test(
        "signature and PDF commit once, remain immutable and are private",
        async () => {
          const f = await prepare(3),
            input = signatureInput(f.note);
          const results = await Promise.all([
            signDeliveryNote(db, f.admin, session, f.note.id, input),
            signDeliveryNote(db, f.admin, session, f.note.id, input),
          ]);
          assert.equal(results[0].proofHash, results[1].proofHash);
          assert.equal(
            await db.deliveryDocument.count({ where: { noteId: f.note.id } }),
            1,
          );
          const file = await deliveryDocument(
            db,
            shop,
            f.note.id,
            credentials.id,
          );
          assert.ok(file.pdf.subarray(0, 5).toString() === "%PDF-");
          assert.ok(file.pdf.length > 1000);
          await assert.rejects(
            deliveryDocument(db, "another-shop.myshopify.com", f.note.id),
            (e) => e.status === 404,
          );
          await assert.rejects(
            deliveryDocument(db, shop, f.note.id, "another-representative"),
            (e) => e.status === 404,
          );
          await assert.rejects(
            db.deliveryNote.update({
              where: { id: f.note.id },
              data: { snapshot: {} },
            }),
          );
          await assert.rejects(
            db.deliveryDocument.update({
              where: { noteId: f.note.id },
              data: { pdf: Buffer.from("changed") },
            }),
          );
          await assert.rejects(
            db.deliveryNote.delete({ where: { id: f.note.id } }),
          );
          await assert.rejects(
            voidDeliveryNote(
              db,
              shop,
              f.note.id,
              "Test operator",
              "Must be refused",
            ),
            (e) => e.status === 409,
          );
          await mkdir("test-results", { recursive: true });
          await writeFile("test-results/delivery-example.pdf", file.pdf);
        },
      );
      await t.test(
        "email failure never removes the signature and retry uses a stable idempotency key",
        async () => {
          const f = await prepare(2);
          await signDeliveryNote(
            db,
            f.admin,
            session,
            f.note.id,
            signatureInput(f.note),
          );
          const keys = [];
          await sendDeliveryEmail(
            db,
            shop,
            f.note.id,
            async (_payload, options) => {
              keys.push(options.idempotencyKey);
              throw new Error("Simulated provider timeout");
            },
          );
          assert.equal(
            (await db.deliveryNote.findUnique({ where: { id: f.note.id } }))
              .emailState,
            "FAILED",
          );
          assert.equal(
            (await db.deliveryNote.findUnique({ where: { id: f.note.id } }))
              .status,
            "SIGNED",
          );
          let sends = 0;
          const send = async (payload, options) => {
            sends++;
            keys.push(options.idempotencyKey);
            assert.equal(payload.to[0], "recipient@example.test");
            assert.ok(Buffer.isBuffer(payload.attachments[0].content));
            return "test-provider-id";
          };
          await Promise.all([
            sendDeliveryEmail(db, shop, f.note.id, send),
            sendDeliveryEmail(db, shop, f.note.id, send),
          ]);
          assert.equal(sends, 1);
          assert.equal(keys[0], keys[1]);
          assert.equal(
            (await db.deliveryNote.findUnique({ where: { id: f.note.id } }))
              .emailState,
            "SENT",
          );
        },
      );
      await t.test(
        "expired idempotency windows require manual provider review",
        async () => {
          const f = await prepare(1);
          await signDeliveryNote(
            db,
            f.admin,
            session,
            f.note.id,
            signatureInput(f.note),
          );
          await db.deliveryNote.update({
            where: { id: f.note.id },
            data: { emailFirstAttemptAt: new Date(Date.now() - 25 * 3600000) },
          });
          await sendDeliveryEmail(db, shop, f.note.id, async () => {
            throw new Error("Must not send");
          });
          assert.equal(
            (await db.deliveryNote.findUnique({ where: { id: f.note.id } }))
              .emailState,
            "MANUAL_REVIEW",
          );
        },
      );
      await t.test(
        "PIN rate limiting, expiry and access revocation are enforced",
        async () => {
          const r = await createRepresentative(db, shop, {
            name: "Locked Example",
            email: "",
          });
          const access = new URL(r.link).searchParams.get("access");
          const wrong = r.pin === "11111111" ? "22222222" : "11111111";
          for (let i = 0; i < 5; i++)
            await assert.rejects(
              mobileLogin(db, access, wrong),
              (e) => e.status === 401,
            );
          await assert.rejects(
            mobileLogin(db, access, r.pin),
            (e) => e.status === 401,
          );
          const expired = await mobileSession(
            db,
            new Request("https://example.test/delivery", {
              headers: { Cookie: cookie.split(";")[0] },
            }),
            new Date(Date.now() + 13 * 3600000),
          );
          assert.equal(expired, null);
          await updateRepresentative(db, shop, credentials.id, false);
          assert.equal(
            await mobileSession(
              db,
              new Request("https://example.test/delivery", {
                headers: { Cookie: cookie.split(";")[0] },
              }),
            ),
            null,
          );
        },
      );
    } finally {
      await db.$disconnect();
    }
  },
);
