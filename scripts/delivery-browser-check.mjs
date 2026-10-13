import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const fixture = JSON.parse(
  await readFile("test-results/ui-fixture.json", "utf8"),
);
const access = new URLSearchParams(new URL(fixture.link).hash.slice(1)).get(
  "access",
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
});
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
  await page.waitForFunction(
    () => document.querySelector('input[name="access"]')?.value.length === 64,
  );
  assert.equal(new URL(page.url()).search, "");
  assert.equal(new URL(page.url()).hash, "");
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
  const savedInput = page.locator('input[name="strokes"]');
  assert.equal(await savedInput.inputValue(), "[]");
  await page.getByRole("button", { name: /Tap here to sign in full screen/ }).click();
  const dialog = page.getByRole("dialog", { name: "Sign for delivery" });
  await dialog.waitFor();
  assert.equal(
    await page.evaluate(() => document.body.style.overflow),
    "hidden",
    "The page must not scroll while the signature pad is open",
  );
  const signature = page.getByRole("img", { name: "Draw your signature here" });
  const box = await signature.boundingBox();
  assert.ok(box.width > 300 && box.height > 350,
    "The signature pad must use most of the mobile viewport");
  const cdp = await page.context().newCDPSession(page);
  const touchPoint = (x, y) => ({
    x: box.x + box.width * x,
    y: box.y + box.height * y,
  });
  const drawSignature = async () => {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touchPoint(0.1, 0.7)],
    });
    for (const [x, y] of [
      [0.15, 0.5],
      [0.2, 0.3],
      [0.25, 0.2],
      [0.3, 0.4],
      [0.35, 0.6],
      [0.4, 0.8],
      [0.5, 0.6],
      [0.6, 0.5],
      [0.7, 0.4],
    ]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [touchPoint(x, y)],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  };
  await drawSignature();
  assert.equal(await savedInput.inputValue(), "[]",
    "Drawing must not commit a signature before confirmation");
  await page.getByRole("button", { name: "Cancel" }).last().click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await savedInput.inputValue(), "[]",
    "Cancel must discard unconfirmed strokes");
  assert.equal(await page.evaluate(() => document.body.style.overflow), "",
    "Closing the pad must restore page scrolling");
  await page.getByRole("button", { name: /Tap here to sign in full screen/ }).click();
  await drawSignature();
  await page.getByRole("button", { name: "Clear" }).click();
  assert.equal(await page.getByRole("button", { name: "Confirm signature" }).isDisabled(), true);
  await drawSignature();
  await page.getByRole("button", { name: "Confirm signature" }).click();
  await dialog.waitFor({ state: "hidden" });
  const drawn = await savedInput.inputValue();
  assert.ok(JSON.parse(drawn)[0].length > 6,
    "Confirmed touch input must record a complete signature");
  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(await savedInput.inputValue(), drawn,
    "Rotation must preserve the confirmed signature");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/mobile-signature.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /Edit signature/ }).click();
  await dialog.waitFor();
  await page.getByRole("button", { name: "Clear" }).click();
  await page.getByRole("button", { name: "Cancel" }).last().click();
  assert.equal(await savedInput.inputValue(), drawn,
    "Cancel after editing must retain the previous confirmed signature");
  await page.getByRole("button", { name: /Edit signature/ }).click();
  await page.getByRole("button", { name: "Clear" }).click();
  await drawSignature();
  await page.getByRole("button", { name: "Confirm signature" }).click();
  assert.ok(JSON.parse(await savedInput.inputValue()).length > 0);
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
  const serverLog = await readFile("test-results/server.log", "utf8");
  assert.ok(
    access && !serverLog.includes(access),
    "The private access secret must not appear in HTTP request logs",
  );
  await writeFile(
    "test-results/browser-check.json",
    JSON.stringify(
      {
        passed: true,
        checks: [
          "private fragment login",
          "access secret absent from HTTP logs",
          "assigned notes",
          "fullscreen touch signature drawing",
          "body scroll locked during signing",
          "cancel discards draft signature",
          "confirm saves signature",
          "rotation preserves strokes",
          "clear and edit signature",
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
} catch (error) {
  await page
    .screenshot({ path: "test-results/browser-failure.png", fullPage: true })
    .catch(() => {});
  await writeFile(
    "test-results/browser-error.txt",
    String(error.stack || error),
  );
  throw error;
} finally {
  await browser.close();
}
