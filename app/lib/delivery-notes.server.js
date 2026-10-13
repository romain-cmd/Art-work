import {
  DeliveryError,
  RECEIPT_STATEMENT,
  availableItems,
  digest,
  email,
  integer,
  makeSnapshot,
  orderHash,
  requestKey,
  text,
  validateStrokes,
} from "./delivery-core.server.js";
import { loadDeliveryOrder } from "./delivery-shopify.server.js";
import { renderDeliveryPdf } from "./delivery-pdf.server.js";
import { getFromAddress } from "./email-from.server.js";
const transaction = (db, callback) =>
  db.$transaction(callback, { maxWait: 5000, timeout: 45000 });
async function lockOrder(tx, shop, orderId) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${shop}), hashtext(${orderId}))::text`;
}
export async function createDeliveryNote(db, admin, shop, actor, input) {
  requestKey(input.createKey);
  const createHash = digest(input);
  return transaction(db, async (tx) => {
    await lockOrder(tx, shop, input.orderId);
    const previous = await tx.deliveryNote.findUnique({
      where: { shop_createKey: { shop, createKey: input.createKey } },
    });
    if (previous) {
      if (previous.createHash !== createHash)
        throw new DeliveryError(
          "This request was already used with different details. Reload the order.",
          409,
        );
      return previous;
    }
    const order = await loadDeliveryOrder(admin, input.orderId);
    if (orderHash(order) !== input.sourceHash)
      throw new DeliveryError(
        "The Shopify order has changed. Reload it before preparing the delivery note.",
        409,
      );
    const rep = await tx.deliveryRepresentative.findFirst({
      where: { id: input.representativeId, shop, isActive: true },
    });
    if (!rep) throw new DeliveryError("Choose an active representative.");
    const notes = await tx.deliveryNote.findMany({
      where: { shop, orderId: order.id, status: { in: ["READY", "SIGNED"] } },
    });
    const now = new Date();
    const snapshot = makeSnapshot(order, notes, input, rep, 0, now);
    let note = await tx.deliveryNote.create({
      data: {
        shop,
        orderId: order.id,
        orderName: order.name,
        representativeId: rep.id,
        snapshot,
        sourceHash: input.sourceHash,
        createKey: input.createKey,
        createHash,
        emailTo: email(order.email) || null,
        createdAt: now,
      },
    });
    snapshot.documentNumber = `DN-${now.getUTCFullYear()}-${String(note.number).padStart(6, "0")}`;
    note = await tx.deliveryNote.update({
      where: { id: note.id },
      data: {
        snapshot,
        searchText: [
          snapshot.documentNumber,
          order.name,
          snapshot.yachtName,
          snapshot.customerName,
          rep.name,
        ]
          .join(" ")
          .toLowerCase(),
      },
    });
    await tx.deliveryEvent.create({
      data: {
        noteId: note.id,
        actor,
        kind: "CREATED",
        details: { sourceHash: note.sourceHash, representativeId: rep.id },
      },
    });
    return note;
  });
}
export async function voidDeliveryNote(db, shop, id, actor, reason) {
  reason = text(reason, 500, true);
  return transaction(db, async (tx) => {
    const found = await tx.deliveryNote.findFirst({ where: { id, shop } });
    if (!found) throw new DeliveryError("Delivery note not found.", 404);
    await lockOrder(tx, shop, found.orderId);
    const changed = await tx.deliveryNote.updateMany({
      where: { id, shop, status: "READY" },
      data: { status: "VOID", revision: { increment: 1 } },
    });
    if (!changed.count)
      throw new DeliveryError(
        "Only unsigned delivery notes can be cancelled.",
        409,
      );
    await tx.deliveryEvent.create({
      data: { noteId: id, actor, kind: "VOIDED", details: { reason } },
    });
  });
}
async function signWithAuthorization(db, admin, auth, id, input) {
  requestKey(input.signatureKey);
  const { shop } = auth;
  return transaction(db, async (tx) => {
    const original = await tx.deliveryNote.findFirst({
      where: {
        id,
        shop,
        ...(auth.type === "mobile" ? { representativeId: auth.representativeId } : {}),
      },
    });
    if (!original) throw new DeliveryError("Delivery note not found.", 404);
    await lockOrder(tx, shop, original.orderId);
    const note = await tx.deliveryNote.findUnique({ where: { id } });
    if (auth.type === "mobile") {
      const validSession = await tx.deliverySession.findFirst({
        where: {
          id: auth.session.id,
          representativeId: auth.representativeId,
          expiresAt: { gt: new Date() },
          representative: { isActive: true },
        },
      });
      if (!validSession)
        throw new DeliveryError(
          "Your access has expired or been revoked. Sign in again.",
          403,
        );
    }
    if (note.status === "SIGNED") {
      if (note.signatureKey === input.signatureKey) return note;
      throw new DeliveryError(
        "This delivery note has already been signed. It cannot be changed.",
        409,
      );
    }
    if (note.status !== "READY" || note.revision !== integer(input.revision, 1))
      throw new DeliveryError(
        "This delivery note has changed or been cancelled. Reload it.",
        409,
      );
    if (input.agreed !== "yes")
      throw new DeliveryError(
        "The recipient must confirm the receipt statement.",
      );
    const receipt = {
      name: text(input.name, 120, true),
      role: text(input.role, 120, true),
      reservations: text(input.reservations, 2000),
      statement: RECEIPT_STATEMENT,
      strokes: validateStrokes(input.strokes),
      signedAt: new Date().toISOString(),
      representativeId: note.representativeId,
    };
    const emailTo =
      input.sendEmail === "yes" ? email(input.emailTo, true) : null;
    const order = await loadDeliveryOrder(admin, note.orderId);
    if (order.cancelledAt || orderHash(order) !== note.sourceHash)
      throw new DeliveryError(
        "The Shopify order has changed since this note was prepared. Do not sign it. Ask the office to cancel and recreate the unsigned note.",
        409,
      );
    const otherNotes = await tx.deliveryNote.findMany({
      where: {
        shop,
        orderId: note.orderId,
        status: { in: ["READY", "SIGNED"] },
      },
    });
    const remaining = availableItems(order, otherNotes, note.id);
    for (const item of note.snapshot.items) {
      if (
        item.quantity >
        (remaining.find((i) => i.id === item.lineItemId)?.available || 0)
      )
        throw new DeliveryError(
          "The available quantities have changed. Contact the office.",
          409,
        );
    }
    const proofHash = digest({
      snapshot: note.snapshot,
      receipt,
      sourceHash: note.sourceHash,
    });
    const pdf = await renderDeliveryPdf(note.snapshot, receipt, proofHash);
    if (pdf.length > 5000000)
      throw new DeliveryError(
        "This PDF is too large to archive safely. Contact the office.",
        422,
      );
    const signed = await tx.deliveryNote.update({
      where: { id },
      data: {
        status: "SIGNED",
        receipt,
        signedAt: new Date(receipt.signedAt),
        proofHash,
        signatureKey: input.signatureKey,
        emailTo,
        emailFrom: getFromAddress(),
        emailState: "PENDING",
      },
    });
    await tx.deliveryDocument.create({
      data: { noteId: id, pdf, sha256: digest(pdf) },
    });
    await tx.deliveryEvent.create({
      data: {
        noteId: id,
        actor: auth.actor,
        kind: "SIGNED",
        details: {
          proofHash,
          pdfHash: digest(pdf),
          sourceHash: note.sourceHash,
          verifiedAgainstShopifyAt: new Date().toISOString(),
          sessionId: auth.type === "mobile" ? auth.session.id : null,
          channel: auth.type === "mobile" ? "MOBILE" : "SHOPIFY_ADMIN",
        },
      },
    });
    return signed;
  });
}
export async function signDeliveryNote(db, admin, session, id, input) {
  return signWithAuthorization(
    db,
    admin,
    {
      type: "mobile",
      shop: session.representative.shop,
      representativeId: session.representative.id,
      actor: session.representative.name,
      session,
    },
    id,
    input,
  );
}

// Called exclusively after authenticate.admin() in the embedded Shopify route.
export async function signDeliveryNoteFromAdmin(db, admin, shop, id, input) {
  return signWithAuthorization(
    db,
    admin,
    { type: "admin", shop, actor: "Shopify administrator" },
    id,
    { ...input, sendEmail: "no", emailTo: "" },
  );
}
export async function deliveryDocument(db, shop, id, representativeId) {
  const document = await db.deliveryDocument.findFirst({
    where: {
      noteId: id,
      note: {
        shop,
        status: "SIGNED",
        ...(representativeId ? { representativeId } : {}),
      },
    },
    include: { note: { select: { snapshot: true } } },
  });
  if (!document) throw new DeliveryError("Signed document not found.", 404);
  const pdf = Buffer.from(document.pdf);
  if (digest(pdf) !== document.sha256)
    throw new DeliveryError(
      "The archived document failed its integrity check. Contact the office.",
      500,
    );
  return {
    pdf,
    filename: `${document.note.snapshot.documentNumber}.pdf`,
    sha256: document.sha256,
  };
}
export function noteView(note) {
  return {
    id: note.id,
    status: note.status,
    revision: note.revision,
    snapshot: note.snapshot,
    emailTo: note.emailTo || "",
    emailState: note.emailState,
    emailError: note.emailError,
    signedAt: note.signedAt,
    receipt: note.receipt,
    proofHash: note.proofHash,
    createdAt: note.createdAt,
    events: note.events?.map((e) => ({
      kind: e.kind,
      actor: e.actor,
      createdAt: e.createdAt,
      details: e.kind === "VOIDED" ? e.details : undefined,
    })),
  };
}
