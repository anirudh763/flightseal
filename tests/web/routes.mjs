// Root visual gate for the routed verifier (docs/): screens, routing, focus, Menu sheet, Back/Forward, deep and
// old links, empty states, light-by-default theme, overflow and axe-core on every primary screen.
//   node tests/web/routes.mjs
// Needs the playwright and axe-core packages (CI installs them in tests/web; AXE_PATH overrides axe.min.js).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const AXE = readFileSync(process.env.AXE_PATH || require.resolve("axe-core/axe.min.js"), "utf8");

let failures = 0, passed = 0;
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function check(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${String(e.message || e).split("\n").slice(0, 6).join("\n     ")}`);
  }
}
const T = { timeout: 8000 };

// The primary screens and what each must show when reached with the tampered sample loaded.
const SCREENS = [
  ["verify", "#/verify", "Verify a file"],
  ["findings", "#/findings?sample=tampered", "Findings"],
  ["records", "#/records?sample=tampered", "Records"],
  ["receipts", "#/receipts?sample=tampered", "Receipts"],
  ["help", "#/help", "Trust help"],
  ["examples", "#/examples", "Examples"],
];

const h1 = (p) => p.evaluate(() => {
  const s = [...document.querySelectorAll("h1")].filter((h) => h.offsetParent !== null);
  return s.length === 1 ? s[0].textContent.trim() : `${s.length} visible h1`;
});
const focusedIsH1 = (p) => p.evaluate(() => document.activeElement.tagName === "H1" && document.activeElement.offsetParent !== null);
const waitH1 = (p, text) => p.waitForFunction((t) => [...document.querySelectorAll("h1")].some((h) => h.offsetParent !== null && h.textContent.trim() === t), text, T);
const waitResult = (p) => p.waitForFunction(() => /Tampered|Intact|Chain intact|Incomplete/.test((document.querySelector("#verdict-line") || {}).textContent || ""), null, T);
async function axe(p) {
  await p.evaluate(AXE);
  const r = await p.evaluate(() => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } }));
  return r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) ${v.nodes.slice(0, 3).map((x) => x.target.join(" ")).join(", ")}`);
}

const { server, url } = await serve();
const browser = await chromium.launch();
try {
  await check("a bare first visit opens Verify, with its title, H1 and nav item marked current", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    await p.goto(url);
    await waitH1(p, "Verify a file");
    assert.equal(await p.title(), "Verify a file – FlightSeal");
    assert.equal(await p.getByRole("banner").count(), 1, "exactly one page banner");
    assert.equal(await p.getAttribute('nav a[aria-current="page"]', "href"), "#/verify");
    // Verify is a guided form: the log, optional receipts and the key you trust, plus one primary action.
    for (const id of ["log-choose", "rec-choose", "pubkey"]) assert.ok(await p.isVisible(`#${id}`), `#${id} not visible`);
    assert.equal(await p.locator(".screen:not([hidden]) .btn.primary").count(), 1, "Verify needs exactly one primary action");
    await c.close();
  });

  await check("each nav item opens its own screen: title, aria-current and focus on the H1", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    await p.goto(url + "#/verify");
    await waitH1(p, "Verify a file");
    for (const [route, , title] of [["#/findings", 0, "Findings"], ["#/records", 0, "Records"], ["#/receipts", 0, "Receipts"], ["#/help", 0, "Trust help"], ["#/examples", 0, "Examples"], ["#/verify", 0, "Verify a file"]]) {
      await p.click(`nav a[href="${route}"]`);
      await waitH1(p, title);
      assert.equal(await p.title(), `${title} – FlightSeal`);
      assert.equal(await p.getAttribute('nav a[aria-current="page"]', "href"), route);
      assert.equal(await p.locator('nav a[aria-current="page"]').count(), 1);
      assert.ok(await focusedIsH1(p), `focus is not on the ${title} H1`);
      // Only that screen's content is in the workspace.
      assert.equal(await p.locator("main .screen:not([hidden])").count(), 1);
    }
    // The H1 takes focus without a workspace-wide outline.
    assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector("main")).outlineStyle), "none");
    await c.close();
  });

  await check("Findings, Records and Receipts without a run show a real empty state with the Verify action", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    for (const [route, title] of [["#/findings", "Findings"], ["#/records", "Records"], ["#/receipts", "Receipts"]]) {
      await p.goto(url + route);
      await waitH1(p, title);
      const empty = p.locator(".screen:not([hidden]) .empty");
      assert.ok(await empty.isVisible(), `${title}: no empty state`);
      assert.match(await empty.innerText(), /No file has been verified yet/);
      assert.equal(await empty.locator('a[href="#/verify"]').count(), 1, `${title}: empty state has no Verify action`);
    }
    await c.close();
  });

  await check("an unknown route shows a Not found screen with a link home", async () => {
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.goto(url + "#/no-such-screen");
    await waitH1(p, "Not found");
    assert.equal(await p.title(), "Not found – FlightSeal");
    assert.ok(await p.locator('.screen:not([hidden]) a[href="#/verify"]').isVisible());
    await c.close();
  });

  await check("old ?sample= links still open: ?sample=rewritten shows its Findings, ?sample=truncated&record=12 shows record 12", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    await p.goto(url + "?sample=rewritten");
    await waitH1(p, "Findings");
    await waitResult(p);
    assert.match(await p.textContent("#verdict-line"), /receipt 2 does not match/);
    assert.match(p.url(), /#\/findings\?sample=rewritten$/);
    assert.doesNotMatch(p.url(), /\/\?sample=/);
    await p.goto(url + "?sample=truncated&record=12");
    await waitH1(p, "Records");
    await p.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 12", null, T);
    assert.match(p.url(), /#\/records\/12\?sample=truncated$/);
    await c.close();
  });

  await check("deep links load directly: #/records/742?sample=intact and #/receipts/2?sample=rewritten", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    await p.goto(url + "#/records/742?sample=intact");
    await waitH1(p, "Records");
    await p.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 742", null, T);
    assert.match(await p.textContent("#pg-label"), /page 15 of 16/);
    await p.goto(url + "#/receipts/2?sample=rewritten");
    await waitH1(p, "Receipts");
    await p.waitForFunction(() => /Receipt 2/.test(document.querySelector("#receipt-detail-h").textContent), null, T);
    assert.match(await p.textContent("#receipt-detail"), /does not match/);
    const receiptHeading = await p.locator("#receipt-detail-h").boundingBox();
    assert.ok(receiptHeading.y < 900, "selected receipt comparison starts below the initial viewport");
    await c.close();
  });

  await check("a user file supersedes a sample whose receipt read is still pending", async () => {
    const c = await browser.newContext({ serviceWorkers: "block" });
    const p = await c.newPage();
    const receiptSize = readFileSync(new URL("../../docs/samples/flight.receipts", import.meta.url)).length;
    await p.addInitScript((size) => {
      const read = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function () {
        if (this.size === size && !window.__sampleReadReleased) {
          window.__receiptReadHeld = true;
          return new Promise((resolve) => {
            window.__releaseReceiptRead = async () => {
              window.__sampleReadReleased = true;
              resolve(await read.call(this));
            };
          });
        }
        return read.call(this);
      };
    }, receiptSize);
    await p.goto(url + "#/findings?sample=intact");
    await p.waitForFunction(() => window.__receiptReadHeld, null, T);
    await p.click('nav a[href="#/verify"]');
    await p.setInputFiles("#log-file", { name: "own-px4.fseal", mimeType: "application/octet-stream",
      buffer: readFileSync(new URL("../../docs/samples/px4-intact.fseal", import.meta.url)) });
    await p.waitForFunction(() => document.getElementById("run-status").textContent.includes("Chain intact; no receipts checked"), null, T);
    await p.evaluate(async () => {
      await window.__releaseReceiptRead();
      // The sample's read continuations finish before the next browser task.
      await new Promise((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => { ch.port1.close(); ch.port2.close(); resolve(); };
        ch.port2.postMessage(0);
      });
    });
    assert.match(await p.textContent("#log-name"), /^own-px4.fseal,/);
    assert.equal(await p.textContent("#rec-name"), "No file chosen");
    assert.equal(await p.inputValue("#pubkey"), "");
    assert.match(await p.textContent("#run-status"), /Chain intact; no receipts checked/);
    assert.doesNotMatch(p.url(), /sample=/);
    await c.close();
  });

  await check("Back and Forward restore the screen and its state (selected record, form text)", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    await p.goto(url + "#/verify");
    await waitH1(p, "Verify a file");
    await p.fill("#pubkey", "abc123");
    await p.click('nav a[href="#/help"]');
    await waitH1(p, "Trust help");
    await p.goBack();
    await waitH1(p, "Verify a file");
    assert.equal(await p.inputValue("#pubkey"), "abc123", "form text lost after Back");
    // A run, then a record, then receipts; Back walks through them with their state.
    await p.goto(url + "#/findings?sample=intact");
    await waitResult(p);
    await p.click('nav a[href="#/records"]');
    await waitH1(p, "Records");
    await p.fill("#jump-to", "742");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 742", null, T);
    assert.match(p.url(), /#\/records\/742\?sample=intact$/);
    await p.click('nav a[href="#/receipts"]');
    await waitH1(p, "Receipts");
    await p.goBack();
    await waitH1(p, "Records");
    await p.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 742", null, T);
    assert.match(await p.textContent("#pg-label"), /page 15 of 16/);
    await p.goBack();
    await waitH1(p, "Records");
    await p.goBack();
    await waitH1(p, "Findings");
    assert.equal((await p.textContent("#verdict-line")).trim(), "Intact");
    await p.goForward();
    await p.goForward();
    await waitH1(p, "Records");
    await p.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 742", null, T);
    await c.close();
  });

  await check("leaving a screen while its check finishes: the new route wins (no bounce back to the old screen)", async () => {
    // A slow main thread runs the hashchange handler late. Here it is delayed on purpose, and the sample files are
    // held, so the check finishes (and re-syncs the URL) after the user chose Trust help but before its handler ran.
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const p = await c.newPage();
    await p.addInitScript(() => {
      const add = window.addEventListener.bind(window);
      window.addEventListener = (type, fn, ...rest) => add(type, type === "hashchange" ? (e) => (window.__hashDelay ? setTimeout(() => fn(e), window.__hashDelay) : fn(e)) : fn, ...rest);
    });
    await p.route("**/samples/**", async (r) => { await new Promise((ok) => setTimeout(ok, 600)); await r.continue(); });
    await p.goto(url + "#/findings?sample=intact");
    await waitH1(p, "Findings");
    await p.evaluate(() => { window.__hashDelay = 2500; location.hash = "#/help"; });
    await p.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Intact", null, { timeout: 10000 });
    await waitH1(p, "Trust help");
    assert.match(await p.evaluate(() => location.hash), /^#\/help/);
    assert.equal(await p.getAttribute('nav a[aria-current="page"]', "href"), "#/help");
    await c.close();
  });

  await check("Findings is focused: verdict, coverage and one next action to the first break", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    await p.goto(url + "#/findings?sample=tampered");
    await waitResult(p);
    assert.equal((await p.textContent("#verdict-line")).trim(), "Tampered: the chain breaks at record 150");
    assert.match(await p.textContent("#facts"), /records 0 to 99; nothing from the problem at record 150 on/);
    const primary = p.locator(".screen:not([hidden]) .btn.primary");
    assert.equal(await primary.count(), 1);
    assert.equal((await primary.textContent()).trim(), "Inspect record 150");
    assert.equal(await p.textContent(".next-heading .section-number"), "02", "dynamic next heading lost its folio number");
    const action = await primary.boundingBox();
    assert.ok(action.y + action.height <= 900, "next action is below the initial viewport");
    await primary.click();
    await waitH1(p, "Records");
    assert.match(p.url(), /#\/records\/150\?sample=tampered$/);
    await p.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 150", null, T);
    // The records table is not on the Findings screen.
    await p.goBack();
    await waitH1(p, "Findings");
    assert.equal(await p.isVisible("#rec-table"), false);
    await c.close();
  });

  await check("an example loaded from Examples opens its Findings", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    await p.goto(url + "#/examples");
    await waitH1(p, "Examples");
    await p.click("text=Load truncated example");
    await waitH1(p, "Findings");
    await waitResult(p);
    assert.match(await p.textContent("#verdict-line"), /does not match the log/);
    assert.match(p.url(), /#\/findings\?sample=truncated$/);
    await c.close();
  });

  for (const w of [320, 375, 768]) await check(`${w} px: the Menu button opens the nav sheet; focus stays inside; Escape closes and returns focus`, async () => {
    const c = await browser.newContext({ viewport: { width: w, height: 800 } });
    const p = await c.newPage();
    await p.goto(url + "#/verify");
    await waitH1(p, "Verify a file");
    const menu = p.locator("#menu-btn");
    assert.ok(await menu.isVisible(), "no Menu button");
    assert.equal((await menu.innerText()).trim(), "Menu");
    assert.equal(await p.isVisible('nav a[href="#/findings"]'), false, "nav is permanently shown");
    assert.equal(await menu.getAttribute("aria-expanded"), "false");
    await menu.focus();
    await p.keyboard.press("Enter");
    await p.waitForSelector('nav a[href="#/findings"]', { state: "visible", ...T });
    assert.equal(await menu.getAttribute("aria-expanded"), "true");
    for (let i = 0; i < 25; i++) {
      await p.keyboard.press("Tab");
      const inside = await p.evaluate(() => !!document.activeElement.closest("#rail"));
      assert.ok(inside, `Tab ${i + 1} left the open sheet (${await p.evaluate(() => document.activeElement.outerHTML.slice(0, 80))})`);
    }
    await p.keyboard.press("Escape");
    await p.waitForSelector('nav a[href="#/findings"]', { state: "hidden", ...T });
    assert.equal(await p.evaluate(() => document.activeElement.id), "menu-btn");
    // Choosing a destination closes the sheet and focuses that screen's H1.
    await menu.click();
    await p.click('nav a[href="#/help"]');
    await waitH1(p, "Trust help");
    assert.equal(await p.isVisible('nav a[href="#/findings"]'), false);
    assert.ok(await focusedIsH1(p));
    await c.close();
  });

  await check("a first load with an in-page anchor (#content) shows Verify with its nav item marked current", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    await p.goto(url + "#content");
    await waitH1(p, "Verify a file");
    assert.equal(await p.getAttribute('nav a[aria-current="page"]', "href"), "#/verify");
    assert.equal(await p.title(), "Verify a file – FlightSeal");
    await c.close();
  });

  for (const w of [320, 1440]) await check(`${w} px: every interactive target on Findings, Records and Receipts is at least 44 x 44 px`, async () => {
    const c = await browser.newContext({ viewport: { width: w, height: 900 } });
    const p = await c.newPage();
    const small = [];
    for (const [route, title] of [
      ["#/findings?sample=tampered", "Findings"], ["#/records/150?sample=tampered", "Records"], ["#/receipts/2?sample=tampered", "Receipts"],
      ["#/findings?sample=rewritten", "Findings"], ["#/records/99?sample=rewritten", "Records"], ["#/receipts/2?sample=rewritten", "Receipts"],
    ]) {
      await p.goto(url + route);
      await waitH1(p, title);
      await waitResult(p);
      await p.waitForTimeout(200);
      if (title === "Findings") await p.click("#report-wrap summary"); // its Copy report button counts too
      const found = await p.evaluate(() => [...document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
        .filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden" && e.id !== "skip")
        .map((e) => { const r = e.getBoundingClientRect(); return { what: `${e.tagName.toLowerCase()} "${(e.textContent || e.getAttribute("aria-label") || e.id).trim().slice(0, 40)}"`, w: r.width, h: r.height }; })
        .filter((t) => t.w < 43.5 || t.h < 43.5));
      small.push(...found.map((t) => `${route}: ${t.what} ${t.w.toFixed(0)}x${t.h.toFixed(0)}`));
    }
    await c.close();
    assert.deepEqual(small, []);
  });

  await check("1440 px: a horizontal folio index and the complete verification form fit the initial viewport", async () => {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await c.newPage();
    await p.goto(url + "#/verify");
    await waitH1(p, "Verify a file");
    assert.equal(await p.isVisible("#menu-btn"), false);
    const box = await p.locator("#rail").boundingBox();
    assert.equal(Math.round(box.width), 1440);
    assert.ok(box.height < 140, `folio index is ${box.height}px tall`);
    const action = await p.locator("#show-findings").boundingBox();
    assert.ok(action.y + action.height <= 900, "Show findings is below the initial viewport");
    const sheet = await p.locator("#dropzone").boundingBox();
    assert.ok(Math.abs(sheet.x + sheet.width / 2 - 720) < 1, "verification sheet is not centered");
    await c.close();
  });

  for (const w of [320, 768, 1440]) await check(`${w} px: no page horizontal overflow on any primary screen`, async () => {
    const c = await browser.newContext({ viewport: { width: w, height: 800 } });
    const p = await c.newPage();
    const bad = [];
    for (const [name, route, title] of SCREENS) {
      await p.goto(url + route);
      await waitH1(p, title);
      if (route.includes("sample=")) await waitResult(p);
      const over = await p.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
      if (over > 0) bad.push(`${name}: ${over}px`);
    }
    // Wide tables scroll inside their own labelled region instead of the page.
    await p.goto(url + "#/receipts?sample=tampered");
    await waitResult(p);
    assert.match(await p.getAttribute("#receipts-scroll", "aria-label") || "", /Receipts table/);
    await c.close();
    assert.deepEqual(bad, []);
  });

  await check("200% text zoom at 640 px: no page horizontal overflow on Findings and Records", async () => {
    const c = await browser.newContext({ viewport: { width: 640, height: 800 } });
    const p = await c.newPage();
    for (const route of ["#/findings?sample=tampered", "#/records?sample=tampered"]) {
      await p.goto(url + route);
      await waitResult(p);
      await p.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
      const over = await p.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
      assert.ok(over <= 0, `${route}: ${over}px`);
    }
    await c.close();
  });

  await check("the default is light even when the OS prefers dark; dark is an explicit, remembered choice", async () => {
    const c = await browser.newContext({ colorScheme: "dark", viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    await p.goto(url + "#/verify");
    await waitH1(p, "Verify a file");
    const bg = () => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(await bg(), "rgb(239, 247, 242)", "canvas is not mint #eff7f2 under OS dark");
    assert.equal(await p.evaluate(() => getComputedStyle(document.body).color), "rgb(25, 54, 43)");
    const t = p.locator("#theme-toggle");
    assert.equal(await t.getAttribute("aria-pressed"), "false");
    await t.click();
    assert.equal(await t.getAttribute("aria-pressed"), "true");
    assert.notEqual(await bg(), "rgb(239, 247, 242)");
    await p.reload();
    await waitH1(p, "Verify a file");
    assert.equal(await p.getAttribute("#theme-toggle", "aria-pressed"), "true", "dark choice not remembered");
    assert.notEqual(await bg(), "rgb(239, 247, 242)");
    await p.click("#theme-toggle");
    assert.equal(await bg(), "rgb(239, 247, 242)");
    await c.close();
  });

  await check("the primary colour is FlightSeal forest #195944 on the primary action", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    await p.goto(url + "#/verify");
    await waitH1(p, "Verify a file");
    assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector(".screen:not([hidden]) .btn.primary")).backgroundColor), "rgb(25, 89, 68)");
    const h = await p.locator(".screen:not([hidden]) .btn.primary").boundingBox();
    assert.ok(h.height >= 44, `primary action is ${h.height}px tall`);
    await c.close();
  });

  for (const theme of ["light", "dark"]) for (const w of [1280, 320]) {
    await check(`axe-core: 0 violations, ${theme}, ${w} px, every primary screen and the empty and not-found states`, async () => {
      const c = await browser.newContext({ viewport: { width: w, height: 900 } });
      const p = await c.newPage();
      if (theme === "dark") await p.addInitScript(() => { try { localStorage.setItem("flightseal-theme", "dark"); } catch {} });
      const all = [];
      for (const [name, route, title] of [...SCREENS, ["records-detail", "#/records/150?sample=tampered", "Records"], ["receipt-detail", "#/receipts/2?sample=rewritten", "Receipts"]]) {
        await p.goto(url + route);
        await waitH1(p, title);
        if (route.includes("sample=")) await waitResult(p);
        if (theme === "dark") assert.equal(await p.getAttribute("html", "data-theme"), "dark");
        all.push(...(await axe(p)).map((v) => `${name}: ${v}`));
      }
      const fresh = await browser.newContext({ viewport: { width: w, height: 900 } });
      const q = await fresh.newPage();
      if (theme === "dark") await q.addInitScript(() => { try { localStorage.setItem("flightseal-theme", "dark"); } catch {} });
      for (const [route, title] of [["#/findings", "Findings"], ["#/nope", "Not found"]]) {
        await q.goto(url + route);
        await waitH1(q, title);
        all.push(...(await axe(q)).map((v) => `${route}: ${v}`));
      }
      if (w === 320) {
        await q.goto(url + "#/verify");
        await waitH1(q, "Verify a file");
        await q.click("#menu-btn");
        await q.waitForSelector('nav a[href="#/findings"]', { state: "visible" });
        all.push(...(await axe(q)).map((v) => `menu open: ${v}`));
      }
      await fresh.close();
      await c.close();
      assert.deepEqual(all, []);
    });
  }

  await check("no console errors across the screens; the CSP is unchanged", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    for (const [, route, title] of SCREENS) {
      await p.goto(url + route);
      await waitH1(p, title);
    }
    const csp = await p.getAttribute('meta[http-equiv="Content-Security-Policy"]', "content");
    assert.equal(csp, "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
    assert.deepEqual(errs, []);
    await c.close();
  });

  await check("the service worker cache version was bumped and caches every script the page loads", async () => {
    const sw = readFileSync(new URL("../../docs/sw.js", import.meta.url), "utf8");
    const version = sw.match(/const VERSION = "([^"]+)"/)[1];
    assert.notEqual(version, "0.1.0-2", "VERSION still 0.1.0-2 (main) although cached files changed");
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.goto(url + "#/verify");
    await waitH1(p, "Verify a file");
    const scripts = await p.evaluate(() => [...document.querySelectorAll("script[src],link[rel=stylesheet]")].map((s) => (s.getAttribute("src") || s.getAttribute("href"))));
    for (const s of scripts) assert.ok(sw.includes(`"${s}"`), `${s} is not in the offline cache list`);
    await c.close();
  });
} finally {
  await browser.close();
  server.close();
}
console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
