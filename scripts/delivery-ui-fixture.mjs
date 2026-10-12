import { PrismaClient } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createRepresentative,
  mobileLogin,
  mobileSession,
} from "../app/lib/delivery-access.server.js";
import {
  createDeliveryNote,
  signDeliveryNote,
} from "../app/lib/delivery-notes.server.js";
import {
  rawOrder,
  adminFor,
  inputFor,
  signatureInput,
} from "../tests/deliveries/fixtures.mjs";
if (process.env.DELIVERY_TEST_DATABASE !== "1")
  throw new Error("Use a disposable test database only.");
const db = new PrismaClient();
try {
  const shop = "ui-test-only.myshopify.com";
  const rep = await createRepresentative(db, shop, {
    name: "Alex Example",
    email: "rep@example.test",
  });
  const cookie = await mobileLogin(
    db,
    new URLSearchParams(new URL(rep.link).hash.slice(1)).get("access"),
    rep.pin,
  );
  const session = await mobileSession(
    db,
    new Request("http://localhost:3000/delivery", {
      headers: { Cookie: cookie.split(";")[0] },
    }),
  );
  const order = rawOrder("901");
  const note = await createDeliveryNote(
    db,
    adminFor(order),
    shop,
    "Test operator",
    inputFor(order, rep, 3),
  );
  const signed = await createDeliveryNote(
    db,
    adminFor(order),
    shop,
    "Test operator",
    inputFor(order, rep, 2),
  );
  await signDeliveryNote(
    db,
    adminFor(order),
    session,
    signed.id,
    signatureInput(signed, { sendEmail: "no" }),
  );
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/ui-fixture.json",
    JSON.stringify({ ...rep, noteId: note.id, signedId: signed.id }),
  );
} finally {
  await db.$disconnect();
}
