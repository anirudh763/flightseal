// Browser test for docs/index.html: loads each sample, checks the page shows what the C++ CLI says, checks
// hostile files and the no-Ed25519 path, and runs axe-core (0 violations) in light and dark.
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
async function check(name, fn) {
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
  await page.waitForSelector("#report-wrap:not([hidden])");
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

  await check("first visit shows the tampered sample, broken at the record the CLI reports", async () => {
    await page.goto(url);
    await loaded(page);
    const m = cli("tampered.fseal").match(/first problem {2}record (\d+), byte (\d+): .*\[bad-link\]/);
    assert.ok(m, "CLI did not report a bad-link");
    const line = await page.textContent("#verdict-line");
    assert.equal(line.trim(), `Tampered: the chain breaks at record ${Number(m[1]).toLocaleString("en-US")}`);
    // The highlighted row in the table is that record, and the detail pane shows it.
    const row = await page.getAttribute("#rec-body tr.row-bad", "data-record");
    assert.equal(row, m[1]);
    assert.equal(await page.getAttribute(`#rec-body tr[data-record="${m[1]}"]`, "aria-current"), "true");
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
    assert.equal((await page.textContent("#report")), cli("tampered.fseal").replace(join(SAMPLES, "tampered.fseal"), "tampered.fseal (sample)"));
  });

  await check("axe-core: 0 violations, light, tampered sample", async () => {
    assert.deepEqual(await axe(page), []);
  });

  await check("intact sample: Intact, all receipts match", async () => {
    await page.click("text=Load intact sample");
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Intact");
    assert.match(cli("intact.fseal"), /RESULT: INTACT/);
    assert.match(await page.textContent("#facts"), /8 of 8 signed by the key you trust and match/);
    assert.match(page.url(), /sample=intact/);
  });

  await check("rewritten sample: chain passes, the receipt the CLI names fails", async () => {
    await page.click("text=Load rewritten sample");
    const m = cli("rewritten.fseal").match(/receipt (\d+) \(count (\d+)\): log does not match/);
    await page.waitForFunction((i) => document.querySelector("#verdict-line").textContent.trim() === `Tampered: receipt ${i} does not match the log`, m[1]);
    assert.match(await page.textContent("#verdict-detail"), new RegExp(`signed by the key you trust after ${m[2]} records`));
    assert.match(cli("rewritten.fseal", false), /RESULT: INTACT/);
  });

  await check("truncated sample: the receipt the CLI names says records were removed from the end", async () => {
    await page.click("text=Load truncated sample");
    const m = cli("truncated.fseal").match(/receipt (\d+) \(count (\d+)\): log is shorter/);
    await page.waitForFunction((i) => document.querySelector("#verdict-line").textContent.trim() === `Tampered: receipt ${i} does not match the log`, m[1]);
    assert.match(await page.textContent("#verdict-detail"), /records were removed from the end/);
  });

  await check("without receipts the page says truncation is only caught with receipts", async () => {
    await page.click("#rec-clear");
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.includes("no receipts checked"));
    assert.match(await page.textContent("#notes"), /Truncation of the tail \(records deleted from the end\) is only caught with receipts/);
    assert.doesNotMatch(page.url(), /sample=/);
  });

  await check("paging and jump to record work from the keyboard", async () => {
    await page.click("text=Load intact sample");
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Intact");
    await page.focus("#pg-next");
    await page.keyboard.press("Enter");
    assert.match(await page.textContent("#pg-label"), /Records 50 to 99 of 800/);
    await page.fill("#jump-to", "742");
    await page.keyboard.press("Enter");
    assert.match(await page.textContent("#pg-label"), /page 15 of 16/);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "742");
    await page.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 742");
    assert.match(page.url(), /record=742/);
  });

  await check("keyboard focus stays on a control after showing a record and paging to either end", async () => {
    const active = () => page.evaluate(() => ({ tag: document.activeElement.tagName, id: document.activeElement.id, text: document.activeElement.textContent }));
    assert.equal(await page.getAttribute("#pg-label", "aria-live"), "polite");
    // "Show record N" with Enter: focus stays on that row's button after the table re-renders.
    await page.focus('#rec-body tr[data-record="745"] button');
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 745");
    let a = await active();
    assert.notEqual(a.tag, "BODY");
    assert.equal(a.text, "745");
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
    await page.goto(url);
    await loaded(page);
    await page.click("#rec-clear");
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
    await page.setInputFiles("#log-file", join(tmp, "own.fseal"));
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Chain intact; no receipts checked");
    assert.equal(await page.inputValue("#pubkey"), "");
    assert.equal(await page.textContent("#rec-name"), "");
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
    assert.match(await page.textContent("#strip-legend"), /not checked against your key/);
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
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Load a sealed log or a sample to check it.");
    assert.equal(await page.isHidden("#records-area"), true);
  });

  await check("a network failure loading a sample is reported in text", async () => {
    const p = await ctx.newPage();
    await p.route("**/samples/**", (r) => r.abort());
    await p.goto(url + "?sample=intact");
    await p.waitForFunction(() => document.querySelector("#verdict-line").textContent.includes("Could not load the intact sample"));
    await p.close();
  });

  await check("keyboard only: skip link, then load a sample and reach the first break", async () => {
    const p = await ctx.newPage();
    await p.goto(url);
    await p.waitForSelector("#report-wrap:not([hidden])");
    await p.keyboard.press("Tab");
    assert.equal(await p.evaluate(() => document.activeElement.textContent), "Skip to the result");
    await p.keyboard.press("Enter");
    assert.equal(await p.evaluate(() => document.activeElement.id), "verdict");
    await p.evaluate(() => document.activeElement.blur());
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      await p.keyboard.press("Tab");
      found = (await p.evaluate(() => document.activeElement.textContent)) === "Load rewritten sample";
    }
    assert.ok(found, "Load rewritten sample is not reachable with Tab");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.querySelector("#verdict-line").textContent.includes("receipt 2 does not match"));
    await p.goto(url + "?sample=tampered");
    await p.waitForSelector("#report-wrap:not([hidden])");
    await p.focus("#show-break");
    await p.keyboard.press("Enter");
    assert.equal(await p.evaluate(() => document.activeElement.closest("tr").dataset.record), "150");
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
    await p.goto(url);
    await p.waitForSelector("#report-wrap:not([hidden])");
    await p.evaluate(() => {
      window.__long = [];
      new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => e.duration))).observe({ type: "longtask", buffered: false });
    });
    await p.click("#rec-clear");
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
    assert.doesNotMatch(await p2.textContent("#verdict"), /removed from the end\./);
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

  for (const scheme of ["light", "dark"]) {
    await check(`axe-core: 0 violations, ${scheme}, every sample and the empty state`, async () => {
      const c = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
      const p = await c.newPage();
      const all = [];
      for (const s of ["tampered", "intact", "rewritten", "truncated"]) {
        await p.goto(url + `?sample=${s}`);
        await loaded(p);
        await p.click("#report-wrap summary");
        all.push(...(await axe(p)).map((v) => `${s}: ${v}`));
      }
      await p.click("#log-clear");
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
    await loaded(p);
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await c.close();
    assert.ok(over <= 0, `page scrolls sideways by ${over}px`);
  });

  await check("200% zoom (640 px viewport at 2x text): no horizontal page scroll", async () => {
    const c = await browser.newContext({ viewport: { width: 640, height: 800 } });
    const p = await c.newPage();
    await p.goto(url);
    await loaded(p);
    await p.evaluate(() => { document.documentElement.style.fontSize = "30px"; }); // text at 200% of 15px
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await c.close();
    assert.ok(over <= 0, `page scrolls sideways by ${over}px`);
  });

  if (process.argv.includes("--screenshots")) {
    const out = join(ROOT, "docs", "screenshots");
    mkdirSync(out, { recursive: true });
    for (const [s, file] of [["tampered", "verifier-tampered.png"], ["rewritten", "verifier-rewritten.png"]]) {
      const c = await browser.newContext({ colorScheme: "light", viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
      const p = await c.newPage();
      await p.goto(url + `?sample=${s}`);
      await loaded(p);
      await p.screenshot({ path: join(out, file) });
      await c.close();
    }
    for (const [scheme, w, file] of [["dark", 1280, "dark.png"], ["light", 360, "narrow.png"]]) {
      const c = await browser.newContext({ colorScheme: scheme, viewport: { width: w, height: 900 } });
      const p = await c.newPage();
      await p.goto(url);
      await loaded(p);
      await p.screenshot({ path: join(tmpdir(), `fseal-${file}`), fullPage: true });
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
