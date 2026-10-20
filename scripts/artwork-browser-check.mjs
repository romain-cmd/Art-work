/* eslint-env node */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { fixtureServer } from "../tests/artwork/fixture.mjs";

const { chromium } = await import(process.env.ARTWORK_PLAYWRIGHT_MODULE || "playwright");
const env = await fixtureServer();
const routeFor = (path) => path.startsWith("/app/kanban") ? env.routes.production : path.startsWith("/proof-review") ? env.routes.review : env.routes.artwork;
const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/@vite/client") { res.setHeader("Content-Type", "application/javascript"); res.end("export const createHotContext=()=>({accept(){},dispose(){},invalidate(){},on(){},send(){}});export const injectQuery=(url)=>url;"); return; }
    if (url.pathname === "/test/data" || url.pathname === "/test/action") {
      const path = url.searchParams.get("path");
      let body;
      if (req.method === "POST") { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = Buffer.concat(chunks); }
      const request = new Request(`http://localhost${path}`, { method: req.method, headers: req.headers, ...(body ? { body } : {}) });
      const result = await routeFor(path)[req.method === "POST" ? "action" : "loader"]({ request });
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result)); return;
    }
    if (url.pathname === "/test/bat.svg") { res.setHeader("Content-Type", "image/svg+xml"); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#dbeafe"/><text x="30" y="120" font-size="24">Example Yacht</text></svg>'); return; }
    if (["/app/personnalisation", "/app/kanban", "/proof-review"].includes(url.pathname)) {
      res.setHeader("Content-Type", "text/html"); res.end((await env.server.transformIndexHtml(url.pathname, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/artwork/browser-entry.jsx"></script></body></html>')).replace('<script type="module" src="/@vite/client"></script>', "")); return;
    }
    env.server.middlewares(req, res, () => { res.statusCode = 404; res.end(); });
  } catch (error) { console.error(error); res.statusCode = 500; res.end(String(error)); }
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${http.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
await mkdir("test-results/artwork", { recursive: true });
try {
  for (const width of [1440, 390]) {
    env.reset();
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => (errors.push(error.message), console.error(error.stack)));
    await page.goto(`${base}/app/personnalisation?case=case`);
    await page.getByRole("button", { name: "Dupliquer cette personnalisation", exact: true }).click();
    const editor = page.locator(".aw-editor").filter({ has: page.getByRole("heading", { name: "Dupliquer cette personnalisation" }) });
    assert.equal(await editor.locator('[name="personalizationId"]').inputValue(), "");
    assert.equal(await editor.locator('[name="quantity"]').inputValue(), "12");
    assert.equal(await editor.locator('[name="dimensions"]').inputValue(), "80 mm");
    assert.equal(await editor.locator('[name="customText"]').inputValue(), "Example Yacht");
    await editor.locator('[name="type"]').selectOption("Impression");
    await editor.locator('[name="location"]').selectOption("Dos");
    await page.screenshot({ path: `test-results/artwork/${width}-duplicate.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
    await editor.getByRole("button", { name: "Enregistrer la personnalisation et les fichiers" }).click();
    await editor.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".aw-personalization").count(), 2);
    const back = page.locator(".aw-personalization").filter({ has: page.getByRole("heading", { name: /Impression · Dos/ }) });
    await back.getByText("Ajouter un BAT / une vue supplémentaire", { exact: true }).click();
    await back.locator('[name="proofImages"]').setInputFiles({ name: "back.png", mimeType: "image/png", buffer: Buffer.from("fixture") });
    await back.getByRole("button", { name: "Enregistrer les BAT", exact: true }).click();
    await back.getByText("À envoyer", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Envoyer 1 BAT au client" }).click();
    await page.getByRole("button", { name: "Confirmer l’envoi" }).click();
    await page.getByRole("button", { name: "Relancer le client" }).waitFor();
    const second = env.fixture.state.proof.find((p) => p.personalizationId !== "marking-chest001");
    await page.goto(`${base}/proof-review?tokens=${second.token}`);
    await page.getByRole("heading", { name: /Print · Back/ }).waitFor();
    await page.screenshot({ path: `test-results/artwork/${width}-client.png`, fullPage: true });
    const approve = page.getByRole("button", { name: /Approve/ }).first();
    await approve.click();
    await page.getByText("✓ Approved", { exact: true }).first().waitFor();
    await page.goto(`${base}/app/kanban`);
    await page.getByRole("heading", { name: /Impression · Dos/ }).waitFor();
    await page.screenshot({ path: `test-results/artwork/${width}-production.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Artwork browser workflow passed at ${width}px`);
  }
} finally { await browser.close(); await env.server.close(); http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); }
