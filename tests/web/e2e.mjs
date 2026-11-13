// Browser test for docs/index.html: loads each sample, checks the page shows what the C++ CLI says, checks
// hostile files and the no-Ed25519 path, and runs axe-core (0 violations) in light and dark. The routed screens
// themselves (focus, Menu, Back/Forward, deep links, theme) are covered by tests/web/routes.mjs.
//   FSEAL_BIN=build/fseal node tests/web/e2e.mjs [--screenshots]
// Needs the playwright and axe-core packages (CI installs them; set AXE_PATH to use another axe.min.js).
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FSEAL = process.env.FSEAL_BIN || join(ROOT, "build", "fseal");
const SAMPLES = join(ROOT, "docs", "samples");
const PUB = readFileSync(join(SAMPLES, "pubkey.txt"), "utf8").trim();
const { chromium } = require("playwright");
const AXE = readFileSync(process.env.AXE_PATH || require.resolve("axe-core/axe.min.js"), "utf8");

let failures = 0, passed = 0;
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null; // run only matching checks
async function check(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${String(e.message || e).split("\n").join("\n     ")}`);
  }
}

function cli(log, withReceipts = true) {
  const args = ["verify", join(SAMPLES, log), ...(withReceipts ? ["--receipts", join(SAMPLES, "flight.receipts"), "--pubkey", PUB] : [])];
  return spawnSync(FSEAL, args, { encoding: "utf8" }).stdout;
}

async function axe(page) {
  await page.evaluate(AXE);
  const r = await page.evaluate(() => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } }));
  return r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) ${v.nodes.slice(0, 3).map((x) => x.target.join(" ")).join(", ")}`);
}

async function loaded(page) {
  await page.waitForSelector("#report-wrap:not([hidden])", { state: "attached" });
}
// Screens are hash routes; the file inputs, key field and Remove buttons are on Verify, examples on Examples.
async function go(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction((h) => location.hash.startsWith(h), hash);
}
async function example(page, name) {
  await go(page, "#/examples");
  await page.click(`text=Load ${name} example`);
}
async function opened(page) {
  await page.waitForFunction(() => [...document.querySelectorAll("h1")].some((h) => h.offsetParent !== null));
}

const tmp = mkdtempSync(join(tmpdir(), "fseal-e2e-"));
const { server, url } = await serve();
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await check("the tampered sample shows the break at the record the CLI reports", async () => {
    await page.goto(url + "#/findings?sample=tampered");
    await loaded(page);
    const m = cli("tampered.fseal").match(/first problem {2}record (\d+), byte (\d+): .*\[bad-link\]/);
    assert.ok(m, "CLI did not report a bad-link");
    const line = await page.textContent("#verdict-line");
    assert.equal(line.trim(), `Tampered: the chain breaks at record ${Number(m[1]).toLocaleString("en-US")}`);
    // The broken link on the chain is that record, selected, and the detail pane shows it.
    const row = await page.getAttribute("#rec-body li.link-bad", "data-record");
    assert.equal(row, m[1]);
    assert.equal(await page.getAttribute(`#rec-body li[data-record="${m[1]}"]`, "aria-current"), "true");
    await page.waitForFunction((r) => document.querySelector("#detail-h").textContent === `Record ${r}`, m[1]);
    // Expected vs actual link, in monospace.
    const codes = await page.$$eval("#break code", (cs) => cs.map((c) => [c.textContent, getComputedStyle(c).fontFamily]));
    assert.equal(codes.length, 2);
    assert.match(codes[0][0], /^[0-9a-f]{64}$/);
    assert.notEqual(codes[0][0], codes[1][0]);
    assert.match(codes[0][1], /mono/i);
    assert.match(await page.textContent("#verdict-detail"), /A hash chain pinpoints the first record where the chain breaks, not every altered record\./);
    assert.match(await page.textContent("#verdict-detail"), new RegExp(`At byte ${Number(m[2]).toLocaleString("en-US")},`));
    assert.match(await page.textContent("#facts"), /records 0 to 99; nothing from the problem at record 150 on/);
    // The evidence chain marks the covered prefix, the uncovered records before the break, and the break.
    const chain = await page.innerText("#chain-summary");
    assert.match(chain, /Records 0 to 99\s+pass every check; covered by a matching receipt/);
    assert.match(chain, /Covered prefix ends after record 99\./);
    assert.match(chain, /Records 100 to 149\s+pass every check; not covered by a receipt/);
    assert.match(chain, /Record 150\s+chain breaks here \[bad-link\]/);
    assert.match(chain, /Receipts 2 to 8\s+after 200 to 800 records:\s+not checked: past the first problem/);
    const order = ["Records 0 to 99", "Covered prefix ends", "Records 100 to 149", "Record 150", "After record 150"].map((t) => chain.indexOf(t));
    assert.deepEqual([...order].sort((a, b) => a - b), order, `chain out of order: ${order}`);
    assert.equal((await page.textContent("#report")), cli("tampered.fseal").replace(join(SAMPLES, "tampered.fseal"), "tampered.fseal (sample)"));
  });

  await check("axe-core: 0 violations, light, tampered sample", async () => {
    assert.deepEqual(await axe(page), []);
  });

  await check("a loaded sample shows its file names, not the browser's 'No file chosen'", async () => {
    // The native file inputs (whose own text would say "No file chosen") are not shown; a Choose file button is.
    for (const id of ["log", "rec"]) {
      assert.equal(await page.isVisible(`#${id}-file`), false, `#${id}-file is visible`);
      assert.equal((await page.textContent(`#${id}-choose`)).trim(), "Choose file");
    }
    assert.match(await page.textContent("#log-name"), /^tampered\.fseal \(sample\), [\d,]+ bytes$/);
    assert.match(await page.textContent("#rec-name"), /^flight\.receipts \(sample\), [\d,]+ bytes$/);
    assert.doesNotMatch(await page.innerText("#dropzone"), /No file chosen/);
    await go(page, "#/verify");
    // Its accessible name keeps the field label, and the button opens the file chooser.
    const name = await page.evaluate(() => [...document.querySelector("#log-choose").getAttribute("aria-labelledby").split(" ")].map((i) => document.getElementById(i).textContent).join(" "));
    assert.match(name, /Choose file Sealed log/);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#log-choose")]);
    assert.equal(await chooser.element().getAttribute("id"), "log-file");
  });

  await check("the favicon loads (200, SVG) with no console errors", async () => {
    const p = await ctx.newPage();
    const errs = [];
    p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    await p.goto(url);
    await opened(p);
    const href = await p.evaluate(() => document.querySelector('link[rel="icon"]').href);
    const r = await p.evaluate(async (h) => { const x = await fetch(h); return [x.status, x.headers.get("content-type")]; }, href);
    assert.equal(r[0], 200);
    assert.match(r[1], /image\/svg\+xml/);
    assert.deepEqual(errs, []);
    await p.close();
  });

  await check("with JavaScript disabled the page says it needs JavaScript and points to the CLI", async () => {
    const c = await browser.newContext({ javaScriptEnabled: false });
    const p = await c.newPage();
    await p.goto(url);
    const msg = p.locator("noscript .noscript, .noscript");
    assert.equal(await msg.count(), 1);
    assert.ok(await msg.isVisible(), "noscript message is not visible");
    assert.match(await msg.innerText(), /needs JavaScript/);
    assert.match(await msg.innerText(), /fseal verify/);
    await c.close();
  });

  await check("offline: after one visit the page reloads and verifies a sample with the network off", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    await p.goto(url + "#/findings?sample=tampered");
    await loaded(p);
    // The service worker is installed, has cached the files and controls this page.
    await p.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
    const scope = await p.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope);
    assert.equal(scope, url);
    const manifest = await p.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).json());
    assert.equal(manifest.start_url, "./");
    assert.deepEqual(manifest.icons.map((i) => i.sizes).sort(), ["192x192", "512x512", "any"]);
    await c.setOffline(true);
    await p.reload();
    await loaded(p);
    assert.equal((await p.textContent("#verdict-line")).trim(), "Tampered: the chain breaks at record 150");
    await example(p, "intact");
    await p.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Intact");
    await example(p, "PX4 flight"); // the real PX4 example is cached too
    await p.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Intact");
    await p.goto(url + "?sample=rewritten"); // a shared link with a query also opens offline
    await loaded(p);
    assert.match(await p.textContent("#verdict-line"), /receipt 2 does not match/);
    assert.deepEqual(errs, []);
    await c.close();
  });

  await check("real PX4 flight examples: the page and its report match the CLI (intact, then the break)", async () => {
    const px4 = (log) => spawnSync(FSEAL, ["verify", join(SAMPLES, log), "--receipts", join(SAMPLES, "px4-flight.receipts"), "--pubkey", readFileSync(join(SAMPLES, "px4-pubkey.txt"), "utf8").trim()], { encoding: "utf8" }).stdout;
    await example(page, "PX4 flight");
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Intact");
    assert.equal(await page.textContent("#report"), px4("px4-intact.fseal").replace(join(SAMPLES, "px4-intact.fseal"), "px4-intact.fseal (sample)"));
    await example(page, "tampered PX4");
    const m = px4("px4-tampered.fseal").match(/first problem {2}record (\d+), byte (\d+): .*\[bad-link\]/);
    await page.waitForFunction((r) => document.querySelector("#verdict-line").textContent.trim() === `Tampered: the chain breaks at record ${r}`, Number(m[1]).toLocaleString("en-US"));
    assert.equal(await page.textContent("#report"), px4("px4-tampered.fseal").replace(join(SAMPLES, "px4-tampered.fseal"), "px4-tampered.fseal (sample)"));
    assert.match(await page.innerText("#chain-summary"), new RegExp(`Record ${Number(m[1]).toLocaleString("en-US")}\\s+chain breaks here`));
  });

  await check("intact sample: Intact, all receipts match", async () => {
    await example(page, "intact");
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Intact");
    assert.match(cli("intact.fseal"), /RESULT: INTACT/);
    assert.match(await page.textContent("#facts"), /8 of 8 signed by the key you trust and match/);
    assert.match(page.url(), /sample=intact/);
  });

  await check("rewritten sample: chain passes, the receipt the CLI names fails", async () => {
    await example(page, "rewritten");
    const m = cli("rewritten.fseal").match(/receipt (\d+) \(count (\d+)\): log does not match/);
    await page.waitForFunction((i) => document.querySelector("#verdict-line").textContent.trim() === `Tampered: receipt ${i} does not match the log`, m[1]);
    assert.match(await page.textContent("#verdict-detail"), new RegExp(`signed by the key you trust after ${m[2]} records`));
    assert.match(cli("rewritten.fseal", false), /RESULT: INTACT/);
  });

  await check("truncated sample: the receipt the CLI names says records were removed from the end", async () => {
    await example(page, "truncated");
    const m = cli("truncated.fseal").match(/receipt (\d+) \(count (\d+)\): log is shorter/);
    await page.waitForFunction((i) => document.querySelector("#verdict-line").textContent.trim() === `Tampered: receipt ${i} does not match the log`, m[1]);
    assert.match(await page.textContent("#verdict-detail"), /records were removed from the end/);
    // The receipts past the end of the log are pinned after the last record on the chain.
    assert.match(await page.innerText("#chain-summary"), /Receipts 7 to 8\s+after 700 to 800 records:\s+log is shorter than the receipt/);
  });

  await check("without receipts the page says truncation is only caught with receipts", async () => {
    await go(page, "#/verify");
    await page.click("#rec-clear");
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.includes("no receipts checked"));
    assert.match(await page.textContent("#notes"), /Truncation of the tail \(records deleted from the end\) is only caught with receipts/);
    assert.doesNotMatch(page.url(), /sample=/);
  });

  await check("paging and jump to record work from the keyboard", async () => {
    await example(page, "intact");
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Intact");
    await go(page, "#/records");
    await page.focus("#pg-next");
    await page.keyboard.press("Enter");
    assert.match(await page.textContent("#pg-label"), /Records 50 to 99 of 800/);
    await page.fill("#jump-to", "742");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 742");
    assert.match(await page.textContent("#pg-label"), /page 15 of 16/);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Record 742");
    assert.match(page.url(), /#\/records\/742\?sample=intact$/);
  });

  await check("pager on a broken log: counts records checked, and a one-record page names one record", async () => {
    const p = await ctx.newPage();
    await p.goto(url + "#/records?sample=tampered");
    await loaded(p);
    // The tampered log has 800 records; 150 pass and record 150 breaks the chain, so the table holds 151 rows.
    // It opens on the page with the break, which holds that one record.
    assert.equal((await p.textContent("#pg-label")).trim(), "Record 150 of 151 checked (verification stopped at record 150), page 4 of 4");
    await p.click("#pg-first");
    assert.equal((await p.textContent("#pg-label")).trim(), "Records 0 to 49 of 151 checked (verification stopped at record 150), page 1 of 4");
    await p.close();
  });

  await check("loading an example opens Findings with the verdict in view and focus on its heading", async () => {
    for (const [width, height] of [[375, 812], [1280, 900]]) {
      const c = await browser.newContext({ viewport: { width, height } });
      const p = await c.newPage();
      await p.goto(url + "#/examples");
      await opened(p);
      await p.locator("text=Load intact example").scrollIntoViewIfNeeded();
      await p.click("text=Load intact example");
      await p.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Intact");
      const top = await p.evaluate(() => document.querySelector("#verdict-line").getBoundingClientRect().top);
      assert.ok(top >= 0 && top < height, `${width} px: the verdict line is at y=${top.toFixed(0)}, outside the ${height} px viewport`);
      assert.equal(await p.evaluate(() => document.activeElement.textContent), "Findings");
      await c.close();
    }
  });

  await check("keyboard focus stays on a control after showing a record and paging to either end", async () => {
    const active = () => page.evaluate(() => ({ tag: document.activeElement.tagName, id: document.activeElement.id, text: document.activeElement.textContent }));
    assert.equal(await page.getAttribute("#pg-label", "aria-live"), "polite");
    // "Show record N" with Enter: focus stays on that row's button after the table re-renders.
    await page.focus('#rec-body li[data-record="745"] button');
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 745");
    let a = await active();
    assert.notEqual(a.tag, "BODY");
    assert.equal(a.text, "Record 745");
    // On the next-to-last page (15 of 16), Next reaches the last page and becomes disabled: focus moves to Previous.
    assert.match(await page.textContent("#pg-label"), /page 15 of 16/);
    await page.focus("#pg-next");
    await page.keyboard.press("Enter");
    a = await active();
    assert.notEqual(a.tag, "BODY");
    assert.equal(a.id, "pg-prev");
    // Last, from the first page; then First from the last page.
    await page.click("#pg-first");
    await page.focus("#pg-last");
    await page.keyboard.press("Enter");
    a = await active();
    assert.equal(a.id, "pg-prev");
    await page.focus("#pg-first");
    await page.keyboard.press("Enter");
    a = await active();
    assert.equal(a.id, "pg-next");
  });

  await check("a corrupt length with complete records after it is not called a crash", async () => {
    const data = Buffer.from(readFileSync(join(SAMPLES, "intact.fseal")));
    let off = 8;
    for (let i = 0; i < 50; i++) off += 56 + data.readUInt32LE(off);
    data[off + 2] |= 0x08;
    const p = join(tmp, "corrupt-length.fseal");
    writeFileSync(p, data);
    const out = spawnSync(FSEAL, ["recover", p], { encoding: "utf8" });
    assert.notEqual(out.status, 0);
    await go(page, "#/verify");
    await page.click("#rec-clear");
    await page.setInputFiles("#log-file", p);
    await page.waitForFunction(() => document.querySelector("#verdict-detail").textContent.includes("fseal recover will not trim anything"));
    assert.equal((await page.textContent("#verdict-line")).trim(), "Tampered: the chain breaks at record 50");
    assert.doesNotMatch(await page.textContent("#verdict"), /Incomplete|crash while writing/);
  });

  await check("a shared URL opens the same view", async () => {
    await page.goto(url + "?sample=truncated&record=12");
    await loaded(page);
    await page.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 12");
  });

  const hostile = (name, bytes) => { const p = join(tmp, name); writeFileSync(p, bytes); return p; };
  const intact = readFileSync(join(SAMPLES, "intact.fseal"));

  await check("hostile file: length field 0xFFFFFFFF is reported, page keeps working", async () => {
    const b = Buffer.from(intact.subarray(0, 4096));
    b.writeUInt32LE(0xffffffff, 8);
    await page.goto(url + "#/verify");
    await opened(page);
    await page.setInputFiles("#log-file", hostile("len.fseal", b));
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.includes("record 0"));
    assert.match(await page.textContent("#verdict-detail"), /claims a length of 4,294,967,295 bytes/);
  });

  await check("hostile file: random bytes are not a FlightSeal log", async () => {
    await page.setInputFiles("#log-file", hostile("random.bin", Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 97) & 255))));
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Not a FlightSeal log");
  });

  await check("hostile file: a truncated record is reported as cut short", async () => {
    await page.setInputFiles("#log-file", hostile("torn.fseal", intact.subarray(0, intact.length - 9)));
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.startsWith("Incomplete"));
  });

  await check("hostile file: 64 MiB of zeros after the header finishes and reports a break", async () => {
    const big = Buffer.alloc(64 << 20);
    big.write("FLTSEAL1");
    await page.setInputFiles("#log-file", hostile("zeros.fseal", big));
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.startsWith("Tampered"), null, { timeout: 30000 });
  });

  await check("malformed receipts are rejected with the line number, chain still checked", async () => {
    await page.setInputFiles("#log-file", join(SAMPLES, "intact.fseal"));
    await page.setInputFiles("#rec-file", hostile("bad.receipts", "fseal-receipt v1 count=99999999999999999999999 head=00\n"));
    await page.waitForFunction(() => document.querySelector("#notes").textContent.includes("line 1: not a receipt"));
  });

  // A log sealed by the user with their own key, plus its receipts.
  const ownKey = join(tmp, "own.pem");
  const ownPub = spawnSync(FSEAL, ["keygen", ownKey], { encoding: "utf8" }).stdout.trim();
  const ownLines = Array.from({ length: 30 }, (_, i) => `${1000 * (i + 1)}\t{"z":${i}}\n`).join("");
  spawnSync(FSEAL, ["append", join(tmp, "own.fseal"), "--key", ownKey, "--receipts", join(tmp, "own.receipts"), "--every", "10"], { input: ownLines });
  const v = () => page.textContent("#verdict-line").then((t) => t.trim());

  await check("picking your own log clears the sample's receipts and key (no false 'rewritten')", async () => {
    await page.goto(url + "?sample=intact");
    await loaded(page);
    await go(page, "#/verify");
    await page.setInputFiles("#log-file", join(tmp, "own.fseal"));
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Chain intact; no receipts checked");
    assert.equal(await page.inputValue("#pubkey"), "");
    assert.equal(await page.textContent("#rec-name"), "No file chosen");
    assert.equal(await page.isHidden("#rec-clear"), true);
    await page.setInputFiles("#rec-file", join(tmp, "own.receipts"));
    await page.fill("#pubkey", ownPub);
    await page.press("#pubkey", "Tab");
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Intact");
    assert.match(spawnSync(FSEAL, ["verify", join(tmp, "own.fseal"), "--receipts", join(tmp, "own.receipts"), "--pubkey", ownPub], { encoding: "utf8" }).stdout, /RESULT: INTACT/);
  });

  await check("an empty receipts file counts as no receipts (never 'all 0 receipts match')", async () => {
    await page.setInputFiles("#rec-file", hostile("empty.receipts", ""));
    await page.waitForFunction(() => document.querySelector("#notes").textContent.includes("contains no receipts"));
    assert.equal(await v(), "Chain intact; no receipts checked");
    assert.match(await page.textContent("#notes"), /Truncation of the tail \(records deleted from the end\) is only caught with receipts/);
    assert.doesNotMatch(await page.textContent("#verdict"), /0 receipts match/);
    assert.match(await page.textContent("#facts"), /file loaded, 0 receipts/);
  });

  await check("a receipts file with a UTF-8 byte-order mark is rejected at line 1, like the CLI", async () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(join(tmp, "own.receipts"))]);
    const bomPath = hostile("bom.receipts", bom);
    assert.match(spawnSync(FSEAL, ["verify", join(tmp, "own.fseal"), "--receipts", bomPath, "--pubkey", ownPub], { encoding: "utf8" }).stderr, /:1: not a receipt/);
    await page.setInputFiles("#rec-file", bomPath);
    await page.waitForFunction(() => document.querySelector("#notes").textContent.includes("line 1: not a receipt"));
  });

  await check("a crash-torn log whose receipts all match is Incomplete, with the CLI's TAMPERED explained", async () => {
    const own = readFileSync(join(tmp, "own.fseal"));
    const torn = hostile("own-torn.fseal", Buffer.concat([own, own.subarray(8, 8 + 30)])); // a half-written 31st record
    const out = spawnSync(FSEAL, ["verify", torn, "--receipts", join(tmp, "own.receipts"), "--pubkey", ownPub], { encoding: "utf8" }).stdout;
    assert.match(out, /3 of 3 match/);
    assert.match(out, /RESULT: TAMPERED/);
    await page.setInputFiles("#log-file", torn);
    await page.setInputFiles("#rec-file", join(tmp, "own.receipts"));
    await page.fill("#pubkey", ownPub);
    await page.press("#pubkey", "Tab");
    await page.waitForFunction(() => document.querySelector("#verdict-detail").textContent.includes("fseal verify reports TAMPERED whenever receipts are given"));
    assert.equal((await page.textContent("#verdict-line")).trim(), "Incomplete: the final record is cut short");
    const body = await page.textContent("#verdict-detail");
    assert.match(body, /fseal verify reports TAMPERED whenever receipts are given/);
    assert.doesNotMatch(body, /expected more/);
  });

  await check("a receipt with a forged signature is not valid for the key you trust: UNVERIFIED, never Intact or Tampered", async () => {
    const forged = readFileSync(join(tmp, "own.receipts"), "utf8").replace(/sig=[0-9a-f]+/g, "sig=" + "0".repeat(128));
    await page.setInputFiles("#log-file", join(tmp, "own.fseal"));
    await page.setInputFiles("#rec-file", hostile("forged.receipts", forged));
    await page.fill("#pubkey", ownPub);
    await page.press("#pubkey", "Tab");
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Chain intact; receipts not valid for the key you trust");
    assert.match(await page.textContent("#report"), /RESULT: UNVERIFIED/);
    assert.equal(spawnSync(FSEAL, ["verify", join(tmp, "own.fseal"), "--receipts", join(tmp, "forged.receipts"), "--pubkey", ownPub]).status, 3);
  });

  await check("receipts validly signed by a key you do not trust: UNVERIFIED, like the CLI (exit 3)", async () => {
    await page.setInputFiles("#rec-file", join(tmp, "own.receipts"));
    await page.fill("#pubkey", PUB); // the sample key, not the one that signed these receipts
    await page.press("#pubkey", "Tab");
    await page.waitForFunction(() => document.querySelector("#verdict-detail").textContent.includes("it names a different signing key"));
    assert.equal((await page.textContent("#verdict-line")).trim(), "Chain intact; receipts not valid for the key you trust");
    assert.match(await page.textContent("#chain-legend"), /not checked against your key/);
    const out = spawnSync(FSEAL, ["verify", join(tmp, "own.fseal"), "--receipts", join(tmp, "own.receipts"), "--pubkey", PUB], { encoding: "utf8" });
    assert.equal(out.status, 3);
    assert.equal(await page.textContent("#report"), out.stdout.replace(join(tmp, "own.fseal"), "own.fseal"));
  });

  await check("an empty log file says it has no records", async () => {
    await page.click("#rec-clear");
    await page.setInputFiles("#log-file", hostile("empty.fseal", ""));
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "The log has no records");
  });

  await check("removing the log returns to the empty state", async () => {
    await page.click("#log-clear");
    await page.waitForFunction(() => document.querySelector("#run-status").textContent.trim() === "No file checked yet.");
    assert.equal(await page.isHidden("#records-area"), true);
    // Findings, Records and Receipts show the real empty state again, with the Verify action.
    for (const s of ["findings", "records", "receipts"]) {
      assert.match(await page.textContent(`.screen[data-screen="${s}"] [data-empty]`), /No file has been verified yet/);
    }
    assert.equal((await page.textContent("#log-name")).trim(), "No file chosen");
    assert.equal(await page.evaluate(() => document.activeElement.id), "log-choose");
  });

  await check("a network failure loading a sample is reported in text", async () => {
    // A first visit with nothing cached: service workers blocked, since page.route cannot see a worker's requests.
    const c = await browser.newContext({ serviceWorkers: "block" });
    const p = await c.newPage();
    await p.route("**/samples/**", (r) => r.abort());
    await p.goto(url + "?sample=intact");
    await p.waitForFunction(() => document.querySelector("#verdict-line").textContent.includes("Could not load the intact sample"));
    await c.close();
  });

  await check("keyboard only: skip link, then load a sample and reach the first break", async () => {
    const p = await ctx.newPage();
    await p.goto(url);
    await opened(p);
    await p.keyboard.press("Tab");
    assert.equal(await p.evaluate(() => document.activeElement.textContent), "Skip to content");
    await p.keyboard.press("Enter");
    assert.equal(await p.evaluate(() => document.activeElement.textContent), "Verify a file");
    const tabTo = async (text) => {
      for (let i = 0; i < 40; i++) {
        await p.keyboard.press("Tab");
        if ((await p.evaluate(() => document.activeElement.textContent.trim())) === text) return;
      }
      assert.fail(`${text} is not reachable with Tab`);
    };
    await tabTo("Open an example");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.activeElement.textContent === "Examples");
    await tabTo("Load rewritten example");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.querySelector("#verdict-line").textContent.includes("receipt 2 does not match"));
    await tabTo("Review receipt 2"); // the one next action
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.querySelector("#receipt-detail-h").textContent === "Receipt 2");
    await p.goto(url + "#/records?sample=tampered");
    await loaded(p);
    await p.focus("#show-break");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.activeElement.closest("li") && document.activeElement.closest("li").dataset.record === "150");
    await p.close();
  });

  await check("a 56 MB log of 1,000,000 records: no long task over 200 ms, Cancel answers within 200 ms", async () => {
    const n = 1_000_000;
    const buf = Buffer.alloc(8 + n * 56);
    buf.write("FLTSEAL1");
    let prev = Buffer.alloc(32);
    const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    for (let i = 0; i < n; i++) {
      const o = 8 + i * 56;
      buf.writeBigUInt64LE(BigInt(i), o + 4);
      buf.writeBigUInt64LE(BigInt(i), o + 12);
      prev = createHash("sha256").update(prev).update(buf.subarray(o + 4, o + 20)).update(buf.subarray(o, o + 4)).digest();
      prev.copy(buf, o + 20);
      buf.writeUInt32LE(crc(buf.subarray(o, o + 52)), o + 52);
    }
    const big = hostile("big.fseal", buf);
    const p = await ctx.newPage();
    await p.goto(url + "#/verify");
    await opened(p);
    await p.evaluate(() => {
      window.__long = [];
      new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => e.duration))).observe({ type: "longtask", buffered: false });
    });
    await p.setInputFiles("#log-file", big);
    await p.waitForSelector("#progress-wrap:not([hidden])");
    await p.waitForTimeout(3000);
    const cancelMs = await p.evaluate(() => new Promise((resolve) => {
      const t0 = performance.now();
      const line = document.querySelector("#verdict-line");
      new MutationObserver(() => line.textContent.includes("cancelled") && resolve(performance.now() - t0)).observe(line, { subtree: true, childList: true, characterData: true });
      document.querySelector("#cancel").click();
    }));
    const worst = Math.max(0, ...(await p.evaluate(() => window.__long)));
    await p.close();
    console.log(`     measured: Cancel answered in ${cancelMs.toFixed(0)} ms, longest task ${worst.toFixed(0)} ms`);
    assert.ok(cancelMs < 200, `Cancel took ${cancelMs.toFixed(0)} ms`);
    assert.ok(worst < 200, `longest task ${worst.toFixed(0)} ms`);
  });

  await check("Cancel during the receipt stage: checks stop and no verdict is shown (10,000 receipts)", async () => {
    const lastReceipt = readFileSync(join(SAMPLES, "flight.receipts"), "utf8").trim().split("\n").pop();
    const many = hostile("many.receipts", `${lastReceipt}\n`.repeat(10000));
    const p = await ctx.newPage();
    // Press Cancel the moment the first signature is checked, and count every signature check after that.
    await p.addInitScript(() => {
      const real = crypto.subtle.verify.bind(crypto.subtle);
      window.__verifies = 0;
      crypto.subtle.verify = (...a) => {
        if (window.__armed && ++window.__verifies === 1) document.querySelector("#cancel").click();
        return real(...a);
      };
    });
    await p.goto(url + "?sample=intact");
    await loaded(p);
    await go(p, "#/verify");
    await p.setInputFiles("#log-file", join(SAMPLES, "intact.fseal")); // your own files replace the sample's log and key
    await p.setInputFiles("#rec-file", many);
    await p.evaluate(() => { window.__armed = true; });
    await p.fill("#pubkey", PUB);
    await p.press("#pubkey", "Tab");
    await p.waitForFunction(() => document.querySelector("#verdict-line").textContent.includes("cancelled"));
    assert.equal(await p.isVisible("#cancel"), false); // progress and Cancel are hidden again after cancelling
    await p.waitForTimeout(2500); // the 10,000 checks took about 1.5 s when Cancel did not reach them
    assert.equal((await p.textContent("#verdict-line")).trim(), "Verification cancelled.");
    assert.equal(await p.isHidden("#report-wrap"), true);
    const calls = await p.evaluate(() => window.__verifies);
    assert.ok(calls < 10, `${calls} signatures checked after Cancel`);
    await p.close();
  });

  await check("without Web Workers the page verifies on the main thread", async () => {
    const p = await ctx.newPage();
    await p.addInitScript(() => { delete window.Worker; });
    await p.goto(url + "?sample=tampered");
    await p.waitForSelector("#report-wrap:not([hidden])");
    assert.equal((await p.textContent("#verdict-line")).trim(), "Tampered: the chain breaks at record 150");
    await p.close();
  });

  await check("no page errors", async () => assert.deepEqual(errors, []));

  await check("without WebCrypto Ed25519 the page says so and still verifies the chain", async () => {
    const p2 = await ctx.newPage();
    await p2.addInitScript(() => {
      const real = crypto.subtle.importKey.bind(crypto.subtle);
      crypto.subtle.importKey = (f, k, alg, ...rest) => (alg && alg.name === "Ed25519" ? Promise.reject(new DOMException("no", "NotSupportedError")) : real(f, k, alg, ...rest));
    });
    await p2.goto(url + "?sample=intact");
    await loaded(p2);
    assert.equal((await p2.textContent("#verdict-line")).trim(), "Chain intact; receipts not authenticated");
    assert.match(await p2.textContent("#notes"), /cannot verify Ed25519 signatures/);
    let report = await p2.textContent("#report");
    assert.match(report, /NOT CHECKED/);
    assert.doesNotMatch(report, /RESULT: INTACT/);
    assert.match(await p2.innerText("#chain-summary"), /No record is covered: the receipts are not authenticated in this browser\./);
    await go(p2, "#/verify");
    // The reviewer's case: a one-record log and a bogus, unsigned receipt claiming 2 records.
    spawnSync(FSEAL, ["append", join(tmp, "one.fseal")], { input: "1000\t{\"z\":1}\n" });
    const pub = readFileSync(join(SAMPLES, "pubkey.txt"), "utf8").trim();
    await p2.setInputFiles("#log-file", join(tmp, "one.fseal"));
    await p2.setInputFiles("#rec-file", hostile("bogus.receipts", `fseal-receipt v1 count=2 head=${"0".repeat(64)} key=${pub} sig=${"0".repeat(128)}\n`));
    await p2.fill("#pubkey", pub);
    await p2.press("#pubkey", "Tab");
    await p2.waitForFunction(() => document.querySelector("#verdict-detail").textContent.includes("The 1 record passes"));
    assert.equal((await p2.textContent("#verdict-line")).trim(), "Chain intact; receipts not authenticated");
    report = await p2.textContent("#report");
    assert.doesNotMatch(report, /RESULT: (TAMPERED|INTACT)/);
    assert.doesNotMatch(await p2.textContent("#verdict"), /records were removed from the end/);
    // A receipt naming a random key, unsigned, with Ed25519 off: not evidence, so not Tampered.
    await p2.setInputFiles("#log-file", join(SAMPLES, "intact.fseal"));
    await p2.setInputFiles("#rec-file", hostile("randkey.receipts", `fseal-receipt v1 count=800 head=${"0".repeat(64)} key=${"ab".repeat(32)} sig=${"0".repeat(128)}\n`));
    await p2.fill("#pubkey", pub);
    await p2.press("#pubkey", "Tab");
    await p2.waitForFunction(() => document.querySelector("#report").textContent.includes("intact.fseal"));
    assert.equal((await p2.textContent("#verdict-line")).trim(), "Chain intact; receipts not authenticated");
    assert.doesNotMatch(await p2.textContent("#report"), /RESULT: (TAMPERED|INTACT)/);
    await p2.goto(url + "?sample=tampered"); // a broken chain is still proved without signatures
    await loaded(p2);
    assert.match(await p2.textContent("#verdict-line"), /chain breaks at record/);
    await p2.close();
  });

  for (const scheme of ["light", "dark"]) for (const width of [1280, 375]) {
    await check(`axe-core: 0 violations, ${scheme}, ${width} px, every sample and the empty state`, async () => {
      const c = await browser.newContext({ colorScheme: scheme, viewport: { width, height: 900 } });
      const p = await c.newPage();
      const all = [];
      for (const s of ["tampered", "intact", "rewritten", "truncated"]) {
        await p.goto(url + `?sample=${s}`);
        await loaded(p);
        await p.click("#report-wrap summary");
        all.push(...(await axe(p)).map((v) => `${s}: ${v}`));
      }
      await go(p, "#/verify");
      await p.click("#log-clear");
      await go(p, "#/findings");
      all.push(...(await axe(p)).map((v) => `empty: ${v}`));
      await c.close();
      assert.deepEqual(all, []);
    });
  }

  for (const w of [375, 320]) await check(`${w} px wide, every sample: no horizontal page scroll`, async () => {
    const c = await browser.newContext({ viewport: { width: w, height: 800 } });
    const p = await c.newPage();
    for (const s of ["tampered", "intact", "rewritten", "truncated"]) {
      await p.goto(url + `?sample=${s}`);
      await loaded(p);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(over <= 0, `${s}: page scrolls sideways by ${over}px`);
    }
    await c.close();
  });

  await check("320 px wide: no horizontal page scroll", async () => {
    const c = await browser.newContext({ viewport: { width: 320, height: 800 } });
    const p = await c.newPage();
    await p.goto(url);
    await opened(p);
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await c.close();
    assert.ok(over <= 0, `page scrolls sideways by ${over}px`);
  });

  await check("200% zoom (640 px viewport at 2x text): no horizontal page scroll", async () => {
    const c = await browser.newContext({ viewport: { width: 640, height: 800 } });
    const p = await c.newPage();
    await p.goto(url + "#/findings?sample=tampered");
    await loaded(p);
    await p.evaluate(() => { document.documentElement.style.fontSize = "32px"; }); // text at 200% of 16px
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await c.close();
    assert.ok(over <= 0, `page scrolls sideways by ${over}px`);
  });

  if (process.argv.includes("--screenshots")) {
    // README screenshots: light, deviceScaleFactor 2, real sample data. Findings at 1440 and 320 (the primary
    // screen), the Records evidence chain at 1440, and the README's two existing names.
    const out = join(ROOT, "docs", "screenshots");
    mkdirSync(out, { recursive: true });
    const shots = [
      ["#/findings?sample=tampered", 1440, 1000, "findings-1440.png", false],
      ["#/findings?sample=tampered", 320, 800, "findings-320.png", true],
      ["#/records/1107?sample=px4-tampered", 1440, 1000, "records-chain-1440.png", false],
      ["#/findings?sample=tampered", 1280, 860, "verifier-tampered.png", false],
      ["#/findings?sample=rewritten", 1280, 860, "verifier-rewritten.png", false],
    ];
    for (const [route, w, h, file, full] of shots) {
      const c = await browser.newContext({ colorScheme: "light", viewport: { width: w, height: h }, deviceScaleFactor: 2 });
      const p = await c.newPage();
      await p.goto(url + route);
      await loaded(p);
      await p.waitForTimeout(300);
      await p.screenshot({ path: join(out, file), fullPage: full });
      await c.close();
    }
    console.log(`screenshots in ${out} (review copies in ${tmpdir()})`);
  }
} finally {
  await browser.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
