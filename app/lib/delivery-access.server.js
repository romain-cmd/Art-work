import { randomBytes } from "node:crypto";
import {
  DeliveryError,
  credentials,
  digest,
  email,
  safeEqual,
  text,
  verifyPin,
} from "./delivery-core.server.js";
export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};
const COOKIE = "__Host-myw-delivery";
export function appOrigin() {
  return new URL(process.env.SHOPIFY_APP_URL).origin;
}
export function requireOrigin(request) {
  if (request.headers.get("Origin") !== appOrigin())
    throw new DeliveryError(
      "This request could not be verified. Reload the page and try again.",
      403,
    );
}
export async function deliveryForm(request) {
  requireOrigin(request);
  if (
    !request.headers
      .get("Content-Type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    throw new DeliveryError("Unsupported form format.", 415);
  const limit = 512000;
  if (Number(request.headers.get("Content-Length")) > limit)
    throw new DeliveryError("Form is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new DeliveryError("Missing form.");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new DeliveryError("Form is too large.", 413);
    }
    chunks.push(Buffer.from(value));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
export async function createRepresentative(db, shop, input) {
  const secret = credentials();
  const representative = await db.deliveryRepresentative.create({
    data: {
      shop,
      name: text(input.name, 120, true),
      email: email(input.email) || null,
      accessHash: secret.accessHash,
      pinHash: secret.pinHash,
    },
  });
  return {
    id: representative.id,
    name: representative.name,
    link: `${appOrigin()}/delivery#access=${secret.access}`,
    pin: secret.pin,
  };
}
export async function updateRepresentative(db, shop, id, rotate) {
  const secret = credentials();
  await db.$transaction(async (tx) => {
    const rep = await tx.deliveryRepresentative.findFirst({
      where: { id, shop },
    });
    if (!rep) throw new DeliveryError("Representative not found.", 404);
    await tx.deliveryRepresentative.update({
      where: { id },
      data: rotate
        ? {
            accessHash: secret.accessHash,
            pinHash: secret.pinHash,
            isActive: true,
            failedAttempts: 0,
            lockedUntil: null,
          }
        : { isActive: false },
    });
    await tx.deliverySession.deleteMany({ where: { representativeId: id } });
  });
  return rotate
    ? {
        link: `${appOrigin()}/delivery#access=${secret.access}`,
        pin: secret.pin,
      }
    : null;
}
export async function mobileLogin(db, access, pin, now = new Date()) {
  if (!/^[a-f0-9]{64}$/.test(access || ""))
    throw new DeliveryError("Invalid access link or code.", 401);
  const token = randomBytes(32).toString("hex");
  const result = await db.$transaction(async (tx) => {
    const candidate = await tx.deliveryRepresentative.findUnique({
      where: { accessHash: digest(access) },
    });
    if (!candidate) return false;
    await tx.$queryRaw`SELECT "id" FROM "DeliveryRepresentative" WHERE "id" = ${candidate.id} FOR UPDATE`;
    const rep = await tx.deliveryRepresentative.findUnique({
      where: { id: candidate.id },
    });
    if (
      !rep.isActive ||
      rep.accessHash !== digest(access) ||
      (rep.lockedUntil && rep.lockedUntil > now)
    )
      return false;
    const failures =
      rep.lockedUntil && rep.lockedUntil <= now ? 0 : rep.failedAttempts;
    if (!verifyPin(pin, rep.pinHash)) {
      await tx.deliveryRepresentative.update({
        where: { id: rep.id },
        data: {
          failedAttempts: failures + 1,
          lockedUntil:
            failures + 1 >= 5 ? new Date(now.getTime() + 15 * 60000) : null,
        },
      });
      return false;
    }
    await tx.deliveryRepresentative.update({
      where: { id: rep.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    await tx.deliverySession.deleteMany({
      where: { representativeId: rep.id, expiresAt: { lte: now } },
    });
    await tx.deliverySession.create({
      data: {
        representativeId: rep.id,
        tokenHash: digest(token),
        csrf: randomBytes(32).toString("hex"),
        expiresAt: new Date(now.getTime() + 12 * 3600000),
      },
    });
    return true;
  });
  if (!result)
    throw new DeliveryError(
      "Invalid access link or code. After repeated attempts, wait 15 minutes or contact the office.",
      401,
    );
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`;
}
export async function mobileSession(db, request, now = new Date()) {
  const token = request.headers
    .get("Cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!/^[a-f0-9]{64}$/.test(token || "")) return null;
  const session = await db.deliverySession.findUnique({
    where: { tokenHash: digest(token) },
    include: { representative: true },
  });
  if (!session || session.expiresAt <= now || !session.representative.isActive)
    return null;
  return session;
}
export function requireCsrf(session, value) {
  if (!session || !safeEqual(session.csrf, value))
    throw new DeliveryError("Your session has expired. Sign in again.", 403);
}
export async function mobileLogout(db, session) {
  await db.deliverySession.deleteMany({ where: { id: session.id } });
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
