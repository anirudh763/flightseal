// Cross-check: the JS verifier (docs/verifier.js) must print exactly what the C++ CLI prints, and its scan must
// equal the independent Python reader's, on every attack the repo tests plus hostile and malformed files.
//   FSEAL_BIN=build/fseal node --test tests/web/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanLog, parseReceipts, checkReceipts, cliReport, bytesSource, parseHex, hex, crc32, ed25519Supported } from "../../docs/verifier.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FSEAL = process.env.FSEAL_BIN || join(ROOT, "build", "fseal");
const PX4 = join(ROOT, "tests", ".data", "px4-sample.ulg");

if (!existsSync(FSEAL)) throw new Error(`build the CLI first (cmake --build build); missing ${FSEAL}`);
const dir = mkdtempSync(join(tmpdir(), "fseal-web-"));
const made = spawnSync("python3", [join(ROOT, "tests/web/make_cases.py"), FSEAL, dir, PX4], { encoding: "utf8" });
if (made.status !== 0) throw new Error(made.stderr);
const { cases, malformed } = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));

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

async function js(c) {
  let receipts = [];
  if (c.receipts) {
    const parsed = parseReceipts(readFileSync(c.receipts, "latin1"));
    if (parsed.error) return { error: parsed.error };
    receipts = parsed.receipts;
  }
  const src = fileSource(c.log);
  try {
    const scan = await scanLog(src, { linksAt: receipts.map((r) => r.count) });
    const check = c.receipts ? await checkReceipts(receipts, parseHex(c.pubkey, 32), scan) : null;
    return { scan, report: cliReport(c.log, scan, check), code: cliReport(c.log, scan, check).includes("RESULT: INTACT") ? 0 : 1 };
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
    "receipts-from-another-key", "altered-signature", "altered-count"])
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
    const py = c.python;
    assert.deepEqual({ problem: got.scan.status === "ok" ? null : got.scan.status, records: got.scan.records, head: hex(got.scan.head) }, py,
      "scan differs from tools/fseal_py.py");
  });
}

for (const m of malformed) {
  test(`malformed receipts rejected at the same line as the CLI: ${m.name}`, async () => {
    const want = cli(m);
    assert.equal(want.code, 2);
    assert.match(want.stderr, new RegExp(`:${m.line}: not a receipt`), want.stderr);
    const got = await js(m);
    assert.deepEqual(got.error, { line: m.line, message: "not a receipt" });
  });
}

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

test("without Ed25519 the chain is still verified and signatures are reported as not checked", async () => {
  const c = cases.find((x) => x.name === "sample-rewritten");
  const real = globalThis.crypto.subtle.importKey.bind(globalThis.crypto.subtle);
  const mod = await import(`../../docs/verifier.js?noed=${Date.now()}`); // fresh module: fresh support probe
  globalThis.crypto.subtle.importKey = async (fmt, key, alg, ...rest) => {
    if (alg && alg.name === "Ed25519") throw new DOMException("not supported", "NotSupportedError");
    return real(fmt, key, alg, ...rest);
  };
  try {
    const { receipts } = mod.parseReceipts(readFileSync(c.receipts, "utf8"));
    const scan = await mod.scanLog(bytesSource(readFileSync(c.log)), { linksAt: receipts.map((r) => r.count) });
    const check = await mod.checkReceipts(receipts, parseHex(c.pubkey, 32), scan);
    assert.equal(scan.status, "ok");
    assert.equal(check.signaturesChecked, false);
    assert.ok(check.results.every((r) => r.sigChecked === false));
    assert.equal(check.results.find((r) => r.result !== "ok").result, "head-mismatch");
  } finally {
    globalThis.crypto.subtle.importKey = real;
  }
});
