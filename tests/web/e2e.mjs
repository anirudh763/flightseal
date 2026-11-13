// Browser test for docs/index.html: loads each sample, checks the page shows what the C++ CLI says, checks
// hostile files and the no-Ed25519 path, and runs axe-core (0 violations) in light and dark.
//   FSEAL_BIN=build/fseal node tests/web/e2e.mjs [--screenshots]
// Needs the playwright and axe-core packages (CI installs them; set AXE_PATH to use another axe.min.js).
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
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
    assert.equal((await page.textContent("#report")), cli("tampered.fseal").replace(join(SAMPLES, "tampered.fseal"), "tampered.fseal (sample)"));
  });

  await check("axe-core: 0 violations, light, tampered sample", async () => {
    assert.deepEqual(await axe(page), []);
  });

  await check("intact sample: Intact, all receipts match", async () => {
    await page.click("text=Load intact sample");
    await page.waitForFunction(() => document.querySelector("#verdict-line").textContent.trim() === "Intact");
    assert.match(cli("intact.fseal"), /RESULT: INTACT/);
    assert.match(await page.textContent("#facts"), /8 of 8 match/);
    assert.match(page.url(), /sample=intact/);
  });

  await check("rewritten sample: chain passes, the receipt the CLI names fails", async () => {
    await page.click("text=Load rewritten sample");
    const m = cli("rewritten.fseal").match(/receipt (\d+) \(count (\d+)\): log does not match/);
    await page.waitForFunction((i) => document.querySelector("#verdict-line").textContent.trim() === `Tampered: receipt ${i} does not match the log`, m[1]);
    assert.match(await page.textContent("#verdict-detail"), new RegExp(`issued after ${m[2]} records`));
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
    assert.match(await page.textContent("#pg-label"), /Records 100 to 199 of 800/);
    await page.fill("#jump-to", "742");
    await page.keyboard.press("Enter");
    assert.match(await page.textContent("#pg-label"), /page 8 of 8/);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "742");
    await page.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 742");
    assert.match(page.url(), /record=742/);
  });

  await check("a shared URL opens the same view", async () => {
    await page.goto(url + "?sample=truncated&record=12");
    await loaded(page);
    await page.waitForFunction(() => document.querySelector("#detail-h").textContent === "Record 12");
  });

  const tmp = mkdtempSync(join(tmpdir(), "fseal-e2e-"));
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

  await check("no page errors", async () => assert.deepEqual(errors, []));

  await check("without WebCrypto Ed25519 the page says so and still verifies the chain", async () => {
    const p2 = await ctx.newPage();
    await p2.addInitScript(() => {
      const real = crypto.subtle.importKey.bind(crypto.subtle);
      crypto.subtle.importKey = (f, k, alg, ...rest) => (alg && alg.name === "Ed25519" ? Promise.reject(new DOMException("no", "NotSupportedError")) : real(f, k, alg, ...rest));
    });
    await p2.goto(url + "?sample=intact");
    await loaded(p2);
    assert.equal((await p2.textContent("#verdict-line")).trim(), "Chain intact; receipt signatures not checked");
    assert.match(await p2.textContent("#notes"), /cannot verify Ed25519 signatures/);
    await p2.goto(url + "?sample=tampered");
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
}
console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
