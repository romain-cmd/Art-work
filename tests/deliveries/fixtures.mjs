import { randomUUID } from "node:crypto";
import {
  normalizeOrder,
  orderHash,
} from "../../app/lib/delivery-core.server.js";
export const strokes = [
  [
    [0.1, 0.65],
    [0.15, 0.4],
    [0.22, 0.22],
    [0.25, 0.65],
    [0.3, 0.35],
    [0.4, 0.55],
    [0.48, 0.3],
    [0.55, 0.6],
    [0.68, 0.42],
    [0.78, 0.58],
  ],
];
export function rawOrder(number = "100", quantity = 10) {
  return {
    id: `gid://shopify/Order/${number}`,
    name: `#TEST-${number}`,
    updatedAt: "2026-10-12T12:00:00Z",
    cancelledAt: null,
    email: "recipient@example.test",
    customer: { displayName: "Example Customer" },
    customAttributes: [{ key: "Yacht Name", value: "Example Yacht (TEST)" }],
    shippingAddress: {
      name: "Example Customer",
      company: "Example Yacht (TEST)",
      address1: "1 Example Quay",
      address2: "",
      city: "Example City",
      zip: "00000",
      province: "",
      country: "France",
    },
    lineItems: {
      nodes: [
        {
          id: `gid://shopify/LineItem/${number}1`,
          title: "Technical Polo",
          variantTitle: "White / M",
          sku: "TEST-POLO-W-M",
          currentQuantity: quantity,
          requiresShipping: true,
        },
        {
          id: `gid://shopify/LineItem/${number}2`,
          title: "Performance Bermuda",
          variantTitle: "Navy / L",
          sku: "TEST-BERM-N-L",
          currentQuantity: 4,
          requiresShipping: true,
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}
export function adminFor(raw) {
  return {
    graphql: async () =>
      new Response(JSON.stringify({ data: { order: raw } }), {
        headers: { "Content-Type": "application/json" },
      }),
  };
}
export function inputFor(raw, rep, quantity = 3) {
  return {
    createKey: randomUUID(),
    sourceHash: orderHash(normalizeOrder(raw)),
    orderId: raw.id,
    representativeId: rep.id,
    yachtName: "Example Yacht (TEST)",
    packages: "2",
    scheduledDate: "2026-10-17",
    instructions: "TEST ONLY. Deliver to the reception desk.",
    quantities: { [raw.lineItems.nodes[0].id]: String(quantity) },
  };
}
export function signatureInput(note, overrides = {}) {
  return {
    signatureKey: randomUUID(),
    revision: note.revision,
    name: "Demo Recipient",
    role: "Chief Stewardess",
    reservations: "TEST ONLY. Packaging checked on receipt.",
    agreed: "yes",
    sendEmail: "yes",
    emailTo: "recipient@example.test",
    strokes,
    ...overrides,
  };
}
