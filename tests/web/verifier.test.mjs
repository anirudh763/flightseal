// Cross-check: the JS verifier (docs/verifier.js) must print exactly what the C++ CLI prints, and its scan must
// equal the independent Python reader's, on every attack the repo tests plus hostile and malformed files.
//   FSEAL_BIN=build/fseal node --test tests/web/
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync, fstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { scanLog, parseReceipts, checkReceipts, cliReport, summarize, bytesSource, parseHex, hex, crc32, ed25519Supported, decodeReceipts } from "../../docs/verifier.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FSEAL = process.env.FSEAL_BIN || join(ROOT, "build", "fseal");
const PX4 = join(ROOT, "tests", ".data", "px4-sample.ulg");

if (!existsSync(FSEAL)) throw new Error(`build the CLI first (cmake --build build); missing ${FSEAL}`);
const dir = mkdtempSync(join(tmpdir(), "fseal-web-"));
const made = spawnSync("python3", [join(ROOT, "tests/web/make_cases.py"), FSEAL, dir, PX4], { encoding: "utf8" });
after(() => rmSync(dir, { recursive: true, force: true }));
if (made.status !== 0) throw new Error(made.stderr);
const { cases, malformed, unsigned, rejected } = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));
const PX4_MISSING = existsSync(PX4) ? false : "tests/.data/px4-sample.ulg is missing, so the 3 real-flight cases did not run: python3 tools/fetch_sample.py tests/.data";

function cli(c) {
  const args = ["verify", c.log, ...(c.receipts ? ["--receipts", c.receipts, "--pubkey", c.pubkey] : [])];
  const r = spawnSync(FSEAL, args, { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Reads the file through a chunked source, like the browser reads a dropped File.
function fileSource(path) {
  const fd = openSync(path, "r");
  const size = fstatSync(fd).size;
  return {
    size,
    async read(off, len) {
      const n = Math.max(0, Math.min(len, size - off));
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, off);
      return new Uint8Array(buf.buffer, buf.byteOffset, n);
    },
    close: () => closeSync(fd),
  };
}

async function js(c, mod = { scanLog, parseReceipts, checkReceipts, cliReport }) {
  let receipts = [];
  if (c.receipts) {
    const parsed = mod.parseReceipts(decodeReceipts(readFileSync(c.receipts)));
    if (parsed.error) return { error: parsed.error };
    receipts = parsed.receipts;
  }
  const src = fileSource(c.log);
  try {
    const scan = await mod.scanLog(src, { linksAt: receipts.map((r) => r.count) });
    const check = c.receipts ? await mod.checkReceipts(receipts, parseHex(c.pubkey, 32), scan) : null;
    const report = mod.cliReport(c.log, scan, check);
    return { scan, check, report, code: report.includes("RESULT: INTACT") ? 0 : report.includes("RESULT: UNVERIFIED") ? 3 : 1 };
  } finally {
    src.close();
  }
}

test("runtime has WebCrypto Ed25519 (needed for the signature cases)", async () => {
  assert.equal(await ed25519Supported(), true);
});

test("crc32 and hex match the standard check values", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(hex(new Uint8Array([0, 15, 255])), "000fff");
  assert.equal(parseHex("ABCD", 2), null); // lowercase only, like the C++ parse_hex
});

test("the case list covers the 7 attacks of tests/test_tools.py and the receipt attacks", () => {
  const names = new Set(cases.map((c) => c.name));
  for (const n of ["flip", "edit", "edit-fix-crc", "delete", "swap", "duplicate", "torn", "rewrite+receipts", "drop-tail+receipts",
    "receipts-from-another-key", "altered-signature", "altered-count", "batch-edge-255", "batch-edge-256+receipts", "batch-edge-257"])
    assert.ok(names.has(n), n);
});

for (const c of cases) {
  test(`JS = CLI = Python: ${c.name}`, async () => {
    const want = cli(c);
    assert.notEqual(want.code, 2, `CLI refused the case: ${want.stderr}`);
    const got = await js(c);
    assert.equal(got.error, undefined);
    assert.equal(got.report, want.stdout, "report differs from `fseal verify`");
    assert.equal(got.code, want.code, "exit status differs");
    const m = want.stdout.match(/first problem {2}record (\d+), byte (\d+)/);
    assert.deepEqual(got.scan.problem ? [got.scan.problem.record, got.scan.problem.offset] : null, m ? [Number(m[1]), Number(m[2])] : null,
      "first problem record/byte differs from the CLI");
    const py = c.python;
    assert.deepEqual({ problem: got.scan.status === "ok" ? null : got.scan.status, records: got.scan.records, head: hex(got.scan.head) }, py,
      "scan differs from tools/fseal_py.py");
  });
}

test("the real PX4 flight (64,542 records) is among the cases", { skip: PX4_MISSING }, () => {
  assert.ok(cases.some((c) => c.name === "px4-edited"));
});

for (const m of malformed) {
  test(`malformed receipts rejected at the same line as the CLI: ${m.name}`, async () => {
    const want = cli(m);
    assert.equal(want.code, 2);
    assert.match(want.stderr, new RegExp(`:${m.line}: not a receipt`), want.stderr);
    const got = await js(m);
    assert.deepEqual(got.error, { line: m.line, message: "not a receipt" });
  });
}

for (const name of ["receipts-from-another-key", "altered-signature", "altered-count"]) test(`receipts not validly signed by the trusted key are UNVERIFIED (exit 3), never TAMPERED: ${name}`, async () => {
  const c = cases.find((x) => x.name === name);
  const want = cli(c);
  assert.equal(want.code, 3);
  assert.match(want.stdout, /RESULT: UNVERIFIED \(receipts not validly signed by the key you trust\)/);
  const got = await js(c);
  assert.equal(got.report, want.stdout);
  assert.equal(got.code, 3);
});

test("a torn log with only untrusted receipts is INCOMPLETE in the CLI and the JS; a broken chain stays TAMPERED", async () => {
  for (const [name, want] of [["torn+receipts-from-another-key", "INCOMPLETE"], ["flip+receipts-from-another-key", "TAMPERED"]]) {
    const c = cases.find((x) => x.name === name);
    const out = cli(c);
    assert.match(out.stdout, new RegExp(`RESULT: ${want}`), name);
    assert.equal((await js(c)).report, out.stdout, name);
  }
});

for (const c of rejected) {
  test(`a receipts file with no receipts is refused by the CLI (exit 2), never a pass: ${c.name}`, async () => {
    const r = cli(c);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /contains no receipts/);
    assert.doesNotMatch(r.stdout, /INTACT/);
    assert.equal(parseReceipts(decodeReceipts(readFileSync(c.receipts))).receipts.length, 0); // the page warns instead
  });
}

test("a corrupt length with complete records after it is bad-length in all three readers, not a torn tail", async () => {
  const c = cases.find((x) => x.name === "corrupt-length-before-complete-records");
  const got = await js(c);
  assert.equal(got.scan.status, "bad-length");
  assert.equal(got.scan.problem.record, 50);
  assert.equal(got.scan.problem.nextAt > got.scan.problem.offset, true);
  assert.equal(c.python.problem, "bad-length");
  assert.match(cli(c).stdout, /record 50, byte \d+: impossible record length/);
});

test("receipts of another flight sealed with the same key are not called only a rewrite", async () => {
  const c = cases.find((x) => x.name === "other-flight-same-key");
  const out = cli(c);
  assert.match(out.stdout, /or these receipts belong to another log sealed with the same key/);
  assert.equal((await js(c)).report, out.stdout);
});

test("a crafted tail of many follow-on candidates is fast in the JS and the CLI (bad-length, nothing trimmed)", async () => {
  const c = cases.find((x) => x.name === "crafted-many-candidates");
  let t = performance.now();
  const got = await js(c);
  const jsMs = performance.now() - t;
  assert.equal(got.scan.status, "bad-length");
  assert.equal(got.scan.problem.crafted, true);
  assert.ok(jsMs < 2000, `JS took ${jsMs.toFixed(0)} ms`);
  t = performance.now();
  const out = cli(c);
  const cliMs = performance.now() - t;
  assert.ok(cliMs < 2000, `CLI took ${cliMs.toFixed(0)} ms`);
  assert.equal(got.report, out.stdout);
});

test("the sample shipped with the page breaks where the page says", async () => {
  const c = cases.find((x) => x.name === "sample-tampered");
  const got = await js(c);
  const m = cli(c).stdout.match(/first problem {2}record (\d+), byte (\d+)/);
  assert.equal(got.scan.problem.record, Number(m[1]));
  assert.equal(got.scan.problem.offset, Number(m[2]));
  assert.equal(got.scan.problem.token, "bad-link");
  assert.match(got.scan.problem.expected, /^[0-9a-f]{64}$/);
  assert.notEqual(got.scan.problem.expected, got.scan.problem.actual);
});

test("hostile input: a file claiming huge records finishes fast and bounded", async () => {
  // 64 MiB of records whose length fields all say 0xFFFFFFFF, served lazily (never allocated).
  const size = 64 << 20;
  const src = {
    size,
    async read(off, len) {
      const n = Math.min(len, size - off);
      const u = new Uint8Array(n).fill(0xff);
      if (off === 0) u.set(new TextEncoder().encode("FLTSEAL1"));
      return u;
    },
  };
  const t0 = Date.now();
  const s = await scanLog(src);
  assert.equal(s.status, "bad-length");
  assert.equal(s.records, 0);
  assert.ok(Date.now() - t0 < 2000);
});

test("hostile input: maxRows bounds memory while verification continues", async () => {
  const c = cases.find((x) => x.name === "sample-intact");
  const s = await scanLog(bytesSource(readFileSync(c.log)), { maxRows: 100 });
  assert.equal(s.status, "ok");
  assert.equal(s.records, 800);
  assert.equal(s.rows.count, 100);
  assert.equal(s.rowsTruncated, true);
});

test("hostile input: cancelling stops the scan", async () => {
  const c = cases.find((x) => x.name === "sample-intact");
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(scanLog(bytesSource(readFileSync(c.log)), { signal: ac.signal }), /cancelled/);
});

// Runs fn with a fresh copy of the verifier whose WebCrypto has no Ed25519 (as in an older browser).
async function withoutEd25519(fn) {
  const real = globalThis.crypto.subtle.importKey;
  const mod = await import(`../../docs/verifier.js?noed=${Math.random()}`); // fresh module: fresh support probe
  globalThis.crypto.subtle.importKey = async function (fmt, key, alg, ...rest) {
    if (alg && alg.name === "Ed25519") throw new DOMException("not supported", "NotSupportedError");
    return real.call(this, fmt, key, alg, ...rest);
  };
  try {
    return await fn(mod);
  } finally {
    globalThis.crypto.subtle.importKey = real;
  }
}

test("without Ed25519 the chain is still verified and signatures are reported as not checked", async () => {
  await withoutEd25519(async (mod) => {
    const got = await js(cases.find((x) => x.name === "sample-rewritten"), mod);
    assert.equal(got.scan.status, "ok");
    assert.equal(got.check.signaturesChecked, false);
    assert.ok(got.check.results.every((r) => r.sigChecked === false));
    assert.match(got.report, /signatures {3}NOT CHECKED/);
    assert.match(got.report, /RESULT: UNVERIFIED/);
  });
});

for (const [name, c] of Object.entries(unsigned)) {
  test(`unauthenticated receipts are never proof either way (no Ed25519): ${name}`, async () => {
    // With signatures checked, the JS still matches the CLI exactly.
    const want = cli(c);
    const signed = await js(c);
    assert.equal(signed.report, want.stdout);
    await withoutEd25519(async (mod) => {
      const got = await js(c, mod);
      const s = summarize(got.scan, got.check);
      assert.doesNotMatch(got.report, /RESULT: INTACT/, "unauthenticated receipts must not yield INTACT");
      assert.match(got.report, /NOT CHECKED/);
      assert.equal(s.covered, 0n, "no record is covered by an unauthenticated receipt");
      const expected = {
        "zero-sig": "UNVERIFIED", // all receipts agree, but anyone could have written them
        "bogus-count2-one-record": "UNVERIFIED", // claims 2 records: not proof of deletion
        "zero-sig-on-edited-log": "TAMPERED", // the chain itself is broken: proved without signatures
        "zero-sig-on-torn-log": "INCOMPLETE",
        "other-key-unsigned": "UNVERIFIED", // a key you do not trust: anyone could have made these
        "other-key-on-torn-log": "INCOMPLETE",
      }[name];
      assert.equal(s.result, expected);
      assert.ok(got.report.includes(`RESULT: ${expected}`));
    });
  });
}

// A valid chain of n empty records, built with Node's own SHA-256.
function emptyRecordLog(n) {
  const buf = Buffer.alloc(8 + n * 56);
  buf.write("FLTSEAL1");
  let prev = Buffer.alloc(32);
  for (let i = 0; i < n; i++) {
    const o = 8 + i * 56;
    buf.writeUInt32LE(0, o);
    buf.writeBigUInt64LE(BigInt(i), o + 4);
    buf.writeBigUInt64LE(BigInt(i), o + 12);
    prev = createHash("sha256").update(prev).update(buf.subarray(o + 4, o + 20)).update(buf.subarray(o, o + 4)).digest();
    prev.copy(buf, o + 20);
    buf.writeUInt32LE(crc32(buf, o, o + 52), o + 52);
  }
  return buf;
}

test("Cancel stops a big log within 200 ms, and the scan completes otherwise", async () => {
  // Event-loop responsiveness is measured in the browser test (Chromium long tasks); in Node, GC from the other
  // cases makes pause timing too noisy to gate on.
  const log = emptyRecordLog(400_000); // 22 MB, 400,000 records
  const s = await scanLog(bytesSource(log));
  assert.equal(s.status, "ok");
  assert.equal(s.records, 400_000);

  const ac = new AbortController();
  const run = scanLog(bytesSource(log), { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 50));
  const t0 = performance.now();
  ac.abort();
  await assert.rejects(run, /cancelled/);
  assert.ok(performance.now() - t0 < 200, `cancel took ${(performance.now() - t0).toFixed(0)} ms`);
});

// ---- review findings on 791eaad (cancel during receipts, unbounded count parse, shorter-log wording) ------------

const SAMPLES = join(ROOT, "docs", "samples");
const SAMPLE_PUB = readFileSync(join(SAMPLES, "pubkey.txt"), "utf8").trim();
const lastReceipt = readFileSync(join(SAMPLES, "flight.receipts"), "utf8").trim().split("\n").pop(); // count=800

test("Cancel during the receipt stage stops checking at once (10,000 valid receipts)", async () => {
  const text = `${lastReceipt}\n`.repeat(10000);
  const { receipts } = parseReceipts(text);
  assert.equal(receipts.length, 10000);
  const scan = await scanLog(bytesSource(new Uint8Array(readFileSync(join(SAMPLES, "intact.fseal")))), { linksAt: [800n] });
  assert.ok(await ed25519Supported());
  const abort = new AbortController();
  const real = crypto.subtle.verify.bind(crypto.subtle);
  let calls = 0;
  crypto.subtle.verify = (...a) => { if (++calls === 1) abort.abort(); return real(...a); };
  try {
    await assert.rejects(checkReceipts(receipts, parseHex(SAMPLE_PUB, 32), scan, abort.signal), { name: "AbortError" });
  } finally {
    crypto.subtle.verify = real;
  }
  assert.ok(calls < 10, `checked ${calls} signatures after Cancel`);
});

test("an overlong receipt count is rejected fast, like the CLI; leading zeros are accepted by both", () => {
  const [, , , ...rest] = lastReceipt.split(" ");
  const long = `fseal-receipt v1 count=${"9".repeat(16_000_000)} ${rest.join(" ")}\n`;
  const t0 = performance.now();
  const r = parseReceipts(long);
  const ms = performance.now() - t0;
  assert.deepEqual(r.error, { line: 1, message: "not a receipt" });
  assert.ok(ms < 200, `took ${ms.toFixed(0)} ms`);
  const zeros = `fseal-receipt v1 count=${"0".repeat(100_000)}800 ${rest.join(" ")}\n`;
  assert.equal(parseReceipts(zeros).receipts[0].count, 800n);
  assert.equal(parseReceipts(`fseal-receipt v1 count=18446744073709551616 ${rest.join(" ")}\n`).error.line, 1); // 2^64
  assert.equal(parseReceipts(`fseal-receipt v1 count=018446744073709551615 ${rest.join(" ")}\n`).receipts[0].count, (1n << 64n) - 1n);
  for (const [name, body, code, out] of [["long", long, 2, /:1: not a receipt/], ["zeros", zeros, 0, /RESULT: INTACT/]]) {
    const p = join(dir, `count-${name}.receipts`);
    writeFileSync(p, body);
    const c = spawnSync(FSEAL, ["verify", join(SAMPLES, "intact.fseal"), "--receipts", p, "--pubkey", SAMPLE_PUB], { encoding: "utf8" });
    assert.equal(c.status, code, c.stderr);
    assert.match(c.stdout + c.stderr, out);
  }
});

test("a receipt past the end of the log names both causes, in the CLI and the JS", async () => {
  const c = { log: join(SAMPLES, "truncated.fseal"), receipts: join(SAMPLES, "flight.receipts"), pubkey: SAMPLE_PUB };
  const want = /log is shorter than the receipt: records were removed from the end, or these receipts belong to another log sealed with the same key/;
  assert.match(cli(c).stdout, want);
  assert.match((await js(c)).report, want);
});
