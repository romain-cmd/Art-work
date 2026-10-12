import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const fixture = JSON.parse(
  await readFile("test-results/ui-fixture.json", "utf8"),
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(fixture.link);
  await page.getByLabel("Access code").fill(fixture.pin);
  await page.getByRole("button", { name: "Open my deliveries" }).click();
  await page.getByRole("heading", { name: "My deliveries" }).waitFor();
  await page.screenshot({
    path: "test-results/mobile-deliveries.png",
    fullPage: true,
  });
  await page.goto(`http://localhost:3000/delivery?note=${fixture.noteId}`);
  await page
    .getByRole("heading", { name: "Check the items, then sign." })
    .waitFor();
  await page.getByLabel("Recipient full name").fill("Demo Recipient");
  await page.getByLabel("Role / position").fill("Chief Stewardess");
  const signature = page.getByRole("img", {
    name: "Handwritten signature area",
  });
  await signature.scrollIntoViewIfNeeded();
  const box = await signature.boundingBox();
  await page.mouse.move(box.x + 35, box.y + 125);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 40, { steps: 12 });
  await page.mouse.move(box.x + 100, box.y + 155, { steps: 12 });
  await page.mouse.move(box.x + 170, box.y + 80, { steps: 12 });
  await page.mouse.up();
  const drawn = await page.locator('input[name="strokes"]').inputValue();
  assert.ok(JSON.parse(drawn)[0].length > 6);
  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(
    await page.locator('input[name="strokes"]').inputValue(),
    drawn,
    "Rotation must preserve the signature",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/mobile-signature.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Clear signature" }).click();
  assert.equal(await page.locator('input[name="strokes"]').inputValue(), "[]");
  await page.context().setOffline(true);
  await page
    .getByRole("alert")
    .filter({ hasText: "You are offline" })
    .waitFor();
  assert.ok(
    await page
      .getByRole("button", { name: "Confirm receipt & save signature" })
      .isDisabled(),
  );
  await page.context().setOffline(false);
  await page.goto(`http://localhost:3000/delivery?note=${fixture.signedId}`);
  await page
    .getByRole("heading", { name: "Thank you, Demo Recipient" })
    .waitFor();
  const download = await page.request.get(
    `http://localhost:3000/delivery/pdf?note=${fixture.signedId}`,
  );
  assert.equal(download.status(), 200);
  assert.match(download.headers()["content-type"], /application\/pdf/);
  assert.equal((await download.body()).subarray(0, 5).toString(), "%PDF-");
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.screenshot({
    path: "test-results/tablet-receipt.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await writeFile(
    "test-results/browser-check.json",
    JSON.stringify(
      {
        passed: true,
        checks: [
          "mobile login",
          "assigned notes",
          "signature drawing",
          "rotation preserves strokes",
          "clear signature",
          "offline blocks submission",
          "signed receipt",
          "authenticated PDF download",
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
