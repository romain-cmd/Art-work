import {
  createHash,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
export { RECEIPT_STATEMENT } from "./delivery-shared.js";
export class DeliveryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "DeliveryError";
    this.status = status;
  }
}
export const digest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : canonical(value),
    )
    .digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function text(value, max = 200, required = false) {
  const result = String(value ?? "").trim();
  if (
    result.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(result)
  )
    throw new DeliveryError(
      `Text must contain at most ${max} characters and no control characters.`,
    );
  if (required && !result)
    throw new DeliveryError("Please complete all required fields.");
  return result;
}
export function email(value, required = false) {
  const result = text(value, 254, required);
  if (result && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result))
    throw new DeliveryError("Enter a valid email address.");
  return result;
}
export function integer(value, min = 0, max = 100000) {
  const n =
    typeof value === "number"
      ? value
      : /^\d+$/.test(String(value))
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new DeliveryError(
      `Quantity must be a whole number between ${min} and ${max}.`,
    );
  return n;
}
export function requestKey(value) {
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(String(value || "")))
    throw new DeliveryError(
      "Invalid request identifier. Reload the page and try again.",
    );
  return value;
}
export function normalizeOrder(raw) {
  if (!raw?.id)
    throw new DeliveryError(
      "Order not found, or access is not available.",
      404,
    );
  const a = raw.shippingAddress;
  const yacht = raw.customAttributes?.find((v) =>
    /^(yacht|yacht_name|yacht name|nom du yacht)$/i.test(v.key),
  )?.value;
  return {
    id: raw.id,
    name: raw.name,
    updatedAt: raw.updatedAt,
    cancelledAt: raw.cancelledAt || null,
    customerName: a?.name || raw.customer?.displayName || raw.name,
    email: raw.email || "",
    yachtName: yacht || a?.company || "",
    address: a
      ? [
          a.name,
          a.company,
          a.address1,
          a.address2,
          [a.zip, a.city].filter(Boolean).join(" "),
          a.province,
          a.country,
        ].filter(Boolean)
      : [],
    items: raw.lineItems.nodes.map((i) => ({
      id: i.id,
      title: i.title,
      variantTitle: i.variantTitle || "",
      sku: i.sku || "",
      quantity: i.currentQuantity,
      requiresShipping: i.requiresShipping,
    })),
  };
}
export function orderHash(order) {
  const { updatedAt, ...data } = order;
  return digest({
    ...data,
    items: [...data.items].sort((a, b) => a.id.localeCompare(b.id)),
  });
}
export function availableItems(order, notes, excludeId) {
  return order.items
    .filter((i) => i.requiresShipping && i.quantity > 0)
    .map((item) => {
      let signed = 0,
        reserved = 0;
      for (const note of notes) {
        if (note.id === excludeId || !["READY", "SIGNED"].includes(note.status))
          continue;
        const quantity =
          note.snapshot.items.find((i) => i.lineItemId === item.id)?.quantity ||
          0;
        if (note.status === "SIGNED") signed += quantity;
        else reserved += quantity;
      }
      return {
        ...item,
        signed,
        reserved,
        available: Math.max(0, item.quantity - signed - reserved),
      };
    });
}
export function makeSnapshot(
  order,
  notes,
  input,
  representative,
  number,
  createdAt,
) {
  if (order.cancelledAt)
    throw new DeliveryError("This Shopify order has been cancelled.", 409);
  const quantities = input.quantities;
  if (
    !quantities ||
    typeof quantities !== "object" ||
    Array.isArray(quantities)
  )
    throw new DeliveryError("Select the quantities to deliver.");
  const available = availableItems(order, notes);
  for (const [id, value] of Object.entries(quantities)) {
    integer(value);
    if (Number(value) > 0 && !available.some((i) => i.id === id))
      throw new DeliveryError(
        "An item is no longer deliverable. Refresh the order.",
        409,
      );
  }
  const items = available
    .filter((i) => Number(quantities[i.id] || 0) > 0)
    .map((i) => {
      const quantity = integer(quantities[i.id], 1);
      if (quantity > i.available)
        throw new DeliveryError(
          `Only ${i.available} units remain available for ${i.title} (${i.variantTitle}).`,
          409,
        );
      return {
        lineItemId: i.id,
        title: i.title,
        variantTitle: i.variantTitle,
        sku: i.sku,
        ordered: i.quantity,
        alreadySigned: i.signed,
        reservedOnOtherNotes: i.reserved,
        quantity,
        remainingUnallocated: i.available - quantity,
      };
    });
  if (!items.length)
    throw new DeliveryError("Select at least one item to deliver.");
  const scheduledDate = text(input.scheduledDate, 10);
  if (
    scheduledDate &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate) ||
      !Number.isFinite(Date.parse(`${scheduledDate}T12:00:00Z`)) ||
      new Date(`${scheduledDate}T12:00:00Z`).toISOString().slice(0, 10) !==
        scheduledDate)
  )
    throw new DeliveryError("Choose a valid delivery date.");
  return {
    version: 1,
    documentNumber: `DN-${createdAt.getUTCFullYear()}-${String(number).padStart(6, "0")}`,
    createdAt: createdAt.toISOString(),
    orderId: order.id,
    orderName: order.name,
    sourceUpdatedAt: order.updatedAt,
    customerName: order.customerName,
    yachtName: text(input.yachtName || order.yachtName, 200),
    address: order.address,
    representative: { id: representative.id, name: representative.name },
    scheduledDate,
    packages: integer(input.packages || 0, 0, 9999),
    instructions: text(input.instructions, 1000),
    items,
    totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
  };
}
export function validateStrokes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw new DeliveryError("Please add a handwritten signature.");
  let count = 0;
  const points = [];
  const strokes = value.map((stroke) => {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > 6000)
      throw new DeliveryError(
        "Invalid signature. Please clear it and sign again.",
      );
    count += stroke.length;
    if (count > 6000)
      throw new DeliveryError(
        "Signature is too large. Please clear it and sign again.",
      );
    return stroke.map((p) => {
      if (
        !Array.isArray(p) ||
        p.length !== 2 ||
        !p.every(
          (n) =>
            typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
        )
      )
        throw new DeliveryError("Invalid signature coordinates.");
      const point = p.map((n) => Math.round(n * 10000) / 10000);
      points.push(point);
      return point;
    });
  });
  const span = (axis) =>
    Math.max(...points.map((p) => p[axis])) -
    Math.min(...points.map((p) => p[axis]));
  if (count < 6 || span(0) + span(1) < 0.04)
    throw new DeliveryError(
      "Please provide a complete signature, not just a dot.",
    );
  return strokes;
}
export function signatureSvg(strokes) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300" viewBox="0 0 800 300">${strokes.map((s) => `<path d="${s.map((p, i) => `${i ? "L" : "M"}${(p[0] * 800).toFixed(2)} ${(p[1] * 300).toFixed(2)}`).join(" ")}" fill="none" stroke="#102b46" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`).join("")}</svg>`;
}
export function credentials() {
  const access = randomBytes(32).toString("hex");
  const pin = String(randomInt(10000000, 100000000));
  return { access, pin, accessHash: digest(access), pinHash: hashPin(pin) };
}
export function hashPin(pin) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}
export function verifyPin(pin, stored) {
  if (!/^\d{8}$/.test(String(pin))) return false;
  const [salt, hash] = String(stored).split(":");
  if (!salt || !/^[a-f0-9]{64}$/.test(hash || "")) return false;
  return timingSafeEqual(scryptSync(pin, salt, 32), Buffer.from(hash, "hex"));
}
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
