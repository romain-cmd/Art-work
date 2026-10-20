import { randomUUID } from "node:crypto";
import ts from "typescript";
import { createServer } from "vite";
import { snapshotPersonalization } from "../../app/lib/artwork-status.js";

// Isolated database/Shopify/email doubles; production route actions are loaded unchanged.
export function createFixture() {
  const now = new Date();
  const draft = { id: "draft", name: "D100", email: "client@example.test", status: "COMPLETED", tags: ["ARTWORK_REQUIRED"], createdAt: now.toISOString(), updatedAt: now.toISOString(), order: { id: "order", name: "#100" } };
  const item = { id: "article", shop: "fixture-shop", draftOrderId: "draft", lineItemId: "line", variantId: "variant", title: "Polo", variantTitle: "M", quantity: 20, requirement: "required", isActive: true };
  const p = { id: "marking-chest001", shop: item.shop, draftOrderId: "draft", lineItemId: "line", variantId: "variant", sourceQuantity: 20, productTitle: "Polo", type: "Broderie", quantity: 12, dimensions: "80 mm", color: "Navy", location: "Poitrine gauche", customText: "Example Yacht", logoUrl: null, isActive: true, createdAt: now };
  const state = {
    personalization: [p],
    artworkItem: [item],
    artworkCase: [{ id: "case", shop: item.shop, draftOrderId: "draft", name: "D100", email: draft.email, orderId: "order", orderName: "#100", yachtName: "Example Yacht", archivedAt: null, syncedAt: now, shopifyUpdatedAt: now }],
    proof: [{ id: "proof-chest", personalizationId: p.id, token: "token-chest", imageUrl: "/test/bat.svg", mimeType: "image/svg+xml", fileName: "chest.svg", version: 1, isCurrent: true, status: "approuve", snapshot: snapshotPersonalization(p), envoyeLe: now, reponduLe: now, createdAt: now }],
    kanbanCard: [{ id: "card-chest", shop: item.shop, draftOrderId: "draft", personalizationId: p.id, orderId: "order", orderName: "#100", status: "en_cours", lastSentAt: now, lastSentTo: "partner@example.test", createdAt: now }],
    artworkEvent: [], shopSettings: [{ shop: item.shop, artworkIndexedAt: now }], partnerEmail: [],
  };
  function matches(row, where = {}) {
    return Object.entries(where).every(([key, value]) => {
      if (value === undefined) return true;
      if (key === "OR") return value.some((v) => matches(row, v));
      if (key === "NOT") return !matches(row, value);
      if (key.includes("_") && value && typeof value === "object") return matches(row, value);
      if (key === "personalization") return matches(state.personalization.find((p) => p.id === row.personalizationId), value);
      if (value && typeof value === "object" && !(value instanceof Date)) {
        if ("in" in value) return value.in.includes(row[key]);
        if ("not" in value) return value.not === null ? row[key] != null : row[key] !== value.not;
      }
      return value === null ? row[key] == null : row[key] === value;
    });
  }
  function include(model, row, spec) {
    if (!row) return null;
    const copy = structuredClone(row);
    if (spec?.proofs) copy.proofs = state.proof.filter((pr) => pr.personalizationId === row.id && matches(pr, spec.proofs.where));
    if (spec?.events) copy.events = state.artworkEvent.filter((e) => e.caseId === row.id);
    if (spec?.personalization) copy.personalization = structuredClone(state.personalization.find((p) => p.id === row.personalizationId));
    return copy;
  }
  const db = Object.fromEntries(Object.keys(state).map((model) => [model, {
    findMany: async ({ where, include: spec } = {}) => state[model].filter((r) => matches(r, where)).map((r) => include(model, r, spec)),
    findFirst: async ({ where, include: spec } = {}) => include(model, state[model].find((r) => matches(r, where)), spec),
    findUnique: async ({ where, include: spec }) => include(model, state[model].find((r) => matches(r, where)), spec),
    create: async ({ data }) => {
      const row = { id: randomUUID(), createdAt: new Date(), ...(model === "personalization" ? { isActive: true } : {}), ...(model === "kanbanCard" ? { status: "a_faire", archivedAt: null } : {}), ...(model === "proof" ? { token: randomUUID(), status: "en_attente", isCurrent: true, version: 1, envoyeLe: null } : {}), ...data };
      state[model].push(row); return structuredClone(row);
    },
    update: async ({ where, data }) => {
      const row = state[model].find((r) => matches(r, where));
      if (!row) throw new Error(`Missing fixture ${model}`);
      Object.assign(row, data); return structuredClone(row);
    },
    updateMany: async ({ where, data }) => {
      const rows = state[model].filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data)); return { count: rows.length };
    },
    upsert: async ({ where, create, update }) => {
      const row = state[model].find((r) => matches(r, where));
      return row ? db[model].update({ where, data: update }) : db[model].create({ data: create });
    },
  }]));
  db.$transaction = async (fn) => {
    const before = structuredClone(state);
    try { return await fn(db); } catch (error) { Object.assign(state, before); throw error; }
  };
  const fixture = { state, draft, db, emails: [], admin: { graphql: async (query) => ({ json: async () => ({ data: {
    draftOrder: query.includes("lineItems") ? { id: draft.id, lineItems: { edges: state.artworkItem.filter((i) => i.isActive).map((i) => ({ node: { id: i.lineItemId, title: i.title, quantity: i.quantity, variant: { id: i.variantId, title: i.variantTitle } } })), pageInfo: { hasNextPage: false } } } : draft,
  } }) }) } };
  return fixture;
}

export async function fixtureServer() {
  globalThis.__artworkFixture = createFixture();
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, ssr: { noExternal: ["resend", "@shopify/app-bridge-react"] }, appType: "custom", esbuild: { jsx: "automatic" }, plugins: [{
    name: "isolated-artwork-fixture",
    enforce: "pre",
    resolveId(id) {
      if (id.includes("db.server")) return "\0fixture-db";
      if (id.includes("shopify.server")) return "\0fixture-auth";
      if (id.includes("shopify-files.server")) return "\0fixture-files";
      if (id === "@shopify/app-bridge-react") return "\0fixture-bridge";
      if (id === "resend") return "\0fixture-resend";
    },
    load(id) {
      if (id === "\0fixture-db") return "export default new Proxy({}, { get: (_, key) => globalThis.__artworkFixture.db[key] })";
      if (id === "\0fixture-auth") return "export const authenticate = { admin: async () => ({ session: { shop: 'fixture-shop' }, admin: globalThis.__artworkFixture.admin }) }";
      if (id === "\0fixture-files") return "export const uploadFileToShopify = async () => '/test/bat.svg'";
      if (id === "\0fixture-bridge") return "const bridge = {toast:{show:()=>{}}}; export const useAppBridge=()=>bridge";
      if (id === "\0fixture-resend") return "export class Resend { emails = { send: async (data) => { globalThis.__artworkFixture.emails.push(data); return {data:{id:'test-email'}} } } }";
    },
    transform(code, id, options) {
      if (options?.ssr || !/app\/routes\/(app.personnalisation|app.kanban|proof-review)\.jsx$/.test(id)) return;
      // Browser exercises the real UI; remove only server exports/dependencies as React Router does.
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
      const retained = source.statements.filter((node) => {
        if (ts.isImportDeclaration(node) && /\.server/.test(node.moduleSpecifier.text)) return false;
        if (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => ["loader", "action"].includes(d.name.getText(source)))) return false;
        if (ts.isFunctionDeclaration(node) && ["checkedPersonalization", "specifications", "proofFiles", "logoFile"].includes(node.name?.text)) return false;
        return true;
      });
      return { code: retained.map((n) => n.getFullText(source)).join("\n"), map: null };
    },
  }] });
  const routes = {
    artwork: await server.ssrLoadModule("/app/routes/app.personnalisation.jsx"),
    production: await server.ssrLoadModule("/app/routes/app.kanban.jsx"),
    review: await server.ssrLoadModule("/app/routes/proof-review.jsx"),
  };
  return { server, routes, get fixture() { return globalThis.__artworkFixture; }, reset() { globalThis.__artworkFixture = createFixture(); } };
}
