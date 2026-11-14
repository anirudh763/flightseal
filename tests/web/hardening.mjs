// Browser regressions for recoverable file reads, stale record detail reads and report export.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = process.env.FSEAL_WEB_EVIDENCE || join(ROOT, "build", "test-artifacts", "hardening");
mkdirSync(EVIDENCE, { recursive: true });
const { server, url } = await serve();
const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  (process.platform === "darwin" && existsSync(systemChrome) ? systemChrome : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const results = [];
const record = async (name, fn) => {
  try { await fn(); results.push({ name, passed: true }); console.log(`ok ${name}`); }
  catch (error) { results.push({ name, passed: false, error: String(error.message || error) }); console.error(`FAIL ${name}: ${error.message || error}`); }
};
try {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on("pageerror", (e) => runtimeErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") runtimeErrors.push(m.text()); });

  await record("null secondary action renders without a browser exception", async () => {
    await page.goto(`${url}#/findings?sample=intact`);
    await page.waitForSelector("#report-wrap:not([hidden])");
    assert.doesNotMatch(await page.locator("#next-actions").textContent(), /\bnull\b/, "optional secondary action must not render literal null");
    assert.deepEqual(runtimeErrors, []);
  });

  await record("download report matches displayed CLI-format text and has generic filename", async () => {
    await page.locator("#report-wrap").evaluate((e) => { e.open = true; });
    const expected = await page.locator("#report").textContent();
    const [download] = await Promise.all([
      page.waitForEvent("download"), page.click("#download-report"),
    ]);
    assert.equal(download.suggestedFilename(), "flightseal-verification-report.txt");
    const path = await download.path();
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(path, "utf8"), expected);
  });

  await record("receipt read rejection is visible, removes proof, and recovers on retry", async () => {
    await page.goto(`${url}#/verify`);
    await page.locator("#log-file").setInputFiles(join(ROOT, "docs/samples/intact.fseal"));
    await page.waitForFunction(() => !document.querySelector("#report-wrap").hidden, null, { timeout: 8000 }).catch(async () => {
      assert.fail(`local log did not verify: log=${await page.locator("#log-name").textContent()}, status=${await page.locator("#run-status").textContent()}, error=${await page.locator("#log-error").textContent()}, runtime=${runtimeErrors.join(" | ")}`);
    });
    await page.evaluate(() => {
      const original = Blob.prototype.arrayBuffer;
      let reject = true;
      Blob.prototype.arrayBuffer = function (...args) {
        if (reject && this instanceof File) { reject = false; return Promise.reject(new Error("private injected failure")); }
        return original.apply(this, args);
      };
    });
    await page.locator("#rec-file").setInputFiles({ name: "retry.receipts", mimeType: "text/plain", buffer: Buffer.from("fseal-receipt-v1\\n") });
    await page.waitForFunction(() => document.querySelector("#rec-error").textContent.includes("Could not read"));
    assert.match(await page.locator("#rec-error").textContent(), /Choose the receipts file again to retry/);
    assert.equal(await page.locator("#report-wrap").isHidden(), true, "old report must disappear while failed receipt input is handled");
    await page.locator("#rec-file").setInputFiles(join(ROOT, "docs/samples/flight.receipts"));
    await page.waitForFunction(() => document.querySelector("#rec-name").textContent.includes("flight.receipts") && !document.querySelector("#rec-error").textContent);
    assert.deepEqual(runtimeErrors, []);
  });

  await record("record read rejection shows retry and stale rejection cannot replace a newer selection", async () => {
    await page.goto(`${url}#/records?sample=intact`);
    await page.waitForSelector("#records-area:not([hidden])");
    await page.evaluate(() => {
      const originalSlice = Blob.prototype.slice;
      window.__originalBlobSlice = originalSlice;
      window.__readReject = null;
      window.__holdNextRecordRead = true;
      Blob.prototype.slice = function (...args) {
        const part = originalSlice.apply(this, args);
        if (!window.__holdNextRecordRead) return part;
        window.__holdNextRecordRead = false;
        return { arrayBuffer: () => new Promise((_, reject) => { window.__readReject = reject; }) };
      };
    });
    await page.getByRole("button", { name: "Show record 1", exact: true }).click();
    await page.waitForFunction(() => typeof window.__readReject === "function");
    await page.getByRole("button", { name: "Show record 2", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 2" && document.querySelector("#detail").textContent.includes("Payload bytes"));
    await page.evaluate(() => { window.__readReject(new Error("injected stale read failure")); window.__readReject = null; });
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#detail-h").textContent(), "Record 2");
    assert.doesNotMatch(await page.locator("#detail").textContent(), /Could not read record/);
    // A current selection's failure is recoverable and a retry reloads the same record.
    await page.evaluate(() => {
      const originalSlice = Blob.prototype.slice;
      window.__originalBlobSlice = originalSlice;
      let failOnce = true;
      Blob.prototype.slice = function (...args) {
        const part = originalSlice.apply(this, args);
        if (!failOnce) return part;
        failOnce = false;
        return { arrayBuffer: () => Promise.reject(new Error("injected read failure")) };
      };
    });
    await page.getByRole("button", { name: "Show record 3", exact: true }).click();
    await page.getByRole("button", { name: "Retry" }).waitFor();
    await page.evaluate(() => { Blob.prototype.slice = window.__originalBlobSlice; });
    await page.getByRole("button", { name: "Retry" }).click();
    await page.waitForFunction(() => document.querySelector("#detail").textContent.includes("Payload bytes"));
    assert.deepEqual(runtimeErrors, []);
  });

  await record("skip link hit target is at least 44 by 44", async () => {
    await page.goto(`${url}#/verify`);
    await page.keyboard.press("Tab");
    const box = await page.locator("#skip").boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44, JSON.stringify(box));
  });
  await page.screenshot({ path: join(EVIDENCE, "hardening-browser.png"), fullPage: true });
  await context.close();
} finally {
  await browser.close();
  server.close();
  writeFileSync(join(EVIDENCE, "hardening-browser.json"), JSON.stringify({ checks: results, count: results.length, passed: results.filter((x) => x.passed).length }, null, 2));
}
if (results.some((x) => !x.passed)) process.exitCode = 1;
