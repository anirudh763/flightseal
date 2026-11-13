// FlightSeal verifier in plain JavaScript (browser and Node 22+), written from the file format in the README.
// It shares no code with the C++ reader; tests/web/verifier.test.mjs requires both to print the same report.
//
// file    = "FLTSEAL1" record*
// record  = length u32 | seq u64 | timestamp_us u64 | payload | link (32 bytes) | crc32 u32   (little-endian)
// link[i] = SHA-256(link[i-1] | seq | timestamp_us | length | payload), link[-1] = 32 zero bytes
//
// Checks per record, in order: length, checksum, sequence number, link. Verification stops at the first failure,
// exactly like `fseal verify`: a hash chain pinpoints the first record where the chain breaks, not every altered record.

export const MAGIC = new Uint8Array([0x46, 0x4c, 0x54, 0x53, 0x45, 0x41, 0x4c, 0x31]); // "FLTSEAL1"
export const HEADER = 20; // length u32 + seq u64 + timestamp u64
export const TRAILER = 36; // link (32) + crc32 (4)
export const MAX_PAYLOAD = 1 << 20;
const CHUNK = 16 << 20; // bytes read from a File at a time; a record is at most MAX_PAYLOAD + 56 bytes
const BATCH = 256; // records hashed in parallel (each link is checked against the stored previous link)
const BATCH_BYTES = 2 << 20; // ... or fewer, so one batch never copies more than about 2 MiB of payload
const SLICE_MS = 8; // give the event loop a turn this often, so the page stays responsive and Cancel works

// Lets other tasks (rendering, a click on Cancel) run. setTimeout would be clamped to 4 ms after nesting.
function yieldToEventLoop() {
  if (globalThis.scheduler && typeof globalThis.scheduler.yield === "function") return globalThis.scheduler.yield();
  if (typeof setImmediate === "function") return new Promise((r) => setImmediate(r));
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
}

// Same wording as describe(Status) in src/fseal.cpp, so reports match the CLI.
export const PROBLEM_TEXT = {
  "torn-tail": "torn final record (the writer stopped mid-record, e.g. a crash)",
  "bad-header": "not a FlightSeal log (bad file header)",
  "bad-length": "impossible record length (corruption)",
  "bad-crc": "checksum mismatch (bytes were changed or damaged)",
  "bad-seq": "sequence break (a record was deleted, reordered or duplicated)",
  "bad-link": "hash-chain break (a record's contents changed after sealing)",
};
export const RECEIPT_TEXT = {
  ok: "matches the log",
  "wrong-key": "signed by a different key than the one you trust",
  "bad-signature": "signature invalid (the receipt itself was altered)",
  "log-shorter": "log is shorter than the receipt (records were removed from the end)",
  "head-mismatch": "log does not match this receipt: it was rewritten after the receipt was issued, or these receipts belong to another log sealed with the same key",
};

// ---- small helpers ------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
export function hex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

// Lowercase hex only, exact length: the same rule as parse_hex() in the C++ code.
export function parseHex(text, n) {
  if (typeof text !== "string" || text.length !== 2 * n || !/^[0-9a-f]*$/.test(text)) return null;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(text.substr(2 * i, 2), 16);
  return out;
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error("WebCrypto is not available (the page must be served over https or from localhost)");
  return c.subtle;
}

// ---- byte sources ---------------------------------------------------------------------------------
// A source is { size, read(offset, length) -> Promise<Uint8Array> }. Reading in chunks keeps memory bounded
// for large or hostile files instead of loading the whole file at once.

export function bytesSource(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return { size: u8.length, read: async (off, len) => u8.subarray(off, Math.min(u8.length, off + len)) };
}

export function blobSource(blob) {
  return {
    size: blob.size,
    read: async (off, len) => new Uint8Array(await blob.slice(off, Math.min(blob.size, off + len)).arrayBuffer()),
  };
}

// ---- log scan ---------------------------------------------------------------------------------

// Offset in `tail` (which starts at a record whose length runs past the end of the file) of a complete record
// with sequence number `seq` and a valid CRC, within one maximum-size record; -1 if there is none.
function recordFollows(tail, seq) {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.length);
  const last = Math.min(tail.length - HEADER - TRAILER, HEADER + MAX_PAYLOAD + TRAILER);
  const lo = seq % 4294967296, hi = Math.floor(seq / 4294967296);
  for (let p = 1; p <= last; p++) {
    if (view.getUint32(p + 4, true) !== lo || view.getUint32(p + 8, true) !== hi) continue;
    const len = view.getUint32(p, true);
    const total = HEADER + len + TRAILER;
    if (len > MAX_PAYLOAD || p + total > tail.length) continue;
    if (crc32(tail, p, p + total - 4) === view.getUint32(p + total - 4, true)) return p;
  }
  return -1;
}

function growRows(rows, need, maxRows) {
  if (need <= rows.capacity) return true;
  if (rows.capacity >= maxRows) return false;
  const cap = Math.min(maxRows, Math.max(need, rows.capacity * 2));
  const off = new Float64Array(cap), ts = new BigUint64Array(cap), len = new Uint32Array(cap);
  off.set(rows.offset.subarray(0, rows.count));
  ts.set(rows.ts.subarray(0, rows.count));
  len.set(rows.len.subarray(0, rows.count));
  Object.assign(rows, { offset: off, ts, len, capacity: cap });
  return true;
}

/**
 * Scans a log from the start and stops at the first problem, like scan() in src/fseal.cpp.
 * options.linksAt: record counts (numbers or bigints) whose head link should be returned (for receipts).
 * options.maxRows: how many records to keep in the row index for display (memory bound); verification
 *   itself continues past it.
 * options.onProgress(bytesDone, size), options.signal (AbortSignal).
 */
export async function scanLog(source, options = {}) {
  const { linksAt = [], maxRows = 5_000_000, onProgress, signal } = options;
  const size = source.size;
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("file size is not a safe integer");
  const wanted = new Set([...linksAt].map((c) => String(c)));
  const r = {
    status: "ok",
    records: 0,
    goodBytes: 0,
    size,
    head: new Uint8Array(32),
    timeReversals: 0,
    problem: null, // { token, record, offset, expected, actual, detail }
    links: new Map(), // String(count) -> Uint8Array(32)
    rows: { count: 0, capacity: 0, offset: new Float64Array(0), ts: new BigUint64Array(0), len: new Uint32Array(0) },
    rowsTruncated: false,
  };

  // Window over the file.
  let win = new Uint8Array(0), winStart = 0;
  async function ensure(off, n) {
    if (off >= winStart && off + n <= winStart + win.length) return;
    win = await source.read(off, Math.max(n, CHUNK));
    winStart = off;
  }

  if (size < MAGIC.length) {
    if (size > 0) {
      await ensure(0, size);
      const isPrefix = equal(win.subarray(0, size), MAGIC.subarray(0, size));
      r.status = isPrefix ? "torn-tail" : "bad-header";
      r.problem = { token: r.status, record: 0, offset: 0 };
    }
    return r;
  }
  await ensure(0, MAGIC.length);
  if (!equal(win.subarray(0, MAGIC.length), MAGIC)) {
    r.status = "bad-header";
    r.problem = { token: "bad-header", record: 0, offset: 0, expected: hex(MAGIC), actual: hex(win.subarray(0, MAGIC.length)) };
    return r;
  }

  let off = MAGIC.length;
  r.goodBytes = off;
  let lastTs = 0n;
  let fail = null; // structural failure found while gathering a batch
  let sliceStart = Date.now();
  const cancelled = () => new DOMException("verification cancelled", "AbortError");

  while (off < size && !fail) {
    if (Date.now() - sliceStart >= SLICE_MS) {
      await yieldToEventLoop();
      sliceStart = Date.now();
    }
    if (signal && signal.aborted) throw cancelled();
    // Gather up to BATCH records (and about BATCH_BYTES) that pass the length, checksum and sequence checks.
    const batch = [];
    let pos = off, batchBytes = 0;
    while (batch.length < BATCH && batchBytes < BATCH_BYTES && pos < size) {
      const left = size - pos;
      const index = r.records + batch.length;
      if (left < HEADER) {
        fail = { token: "torn-tail", record: index, offset: pos, detail: `${left} byte(s) left, a record header needs ${HEADER}` };
        break;
      }
      await ensure(pos, HEADER);
      let view = new DataView(win.buffer, win.byteOffset + (pos - winStart));
      const len = view.getUint32(0, true);
      if (len > MAX_PAYLOAD) {
        fail = { token: "bad-length", record: index, offset: pos, expected: `at most ${MAX_PAYLOAD}`, actual: String(len) };
        break;
      }
      const total = HEADER + len + TRAILER;
      if (left < total) {
        // A crash leaves a torn tail. A corrupted length with an intact next record after it is corruption, and
        // the records after it are evidence (fseal recover must not trim them).
        await ensure(pos, left);
        const next = recordFollows(win.subarray(pos - winStart, pos - winStart + left), index + 1);
        fail = next >= 0
          ? { token: "bad-length", record: index, offset: pos, expected: `${next - HEADER - TRAILER} or less (record ${index + 1} starts ${next} bytes later)`, actual: String(len), nextAt: pos + next }
          : { token: "torn-tail", record: index, offset: pos, detail: `record needs ${total} bytes, ${left} left in the file` };
        break;
      }
      await ensure(pos, total);
      const rec = win.subarray(pos - winStart, pos - winStart + total);
      view = new DataView(rec.buffer, rec.byteOffset, total);
      const storedCrc = view.getUint32(total - 4, true);
      const crc = crc32(rec, 0, total - 4);
      if (crc !== storedCrc) {
        fail = { token: "bad-crc", record: index, offset: pos, expected: crc.toString(16).padStart(8, "0"), actual: storedCrc.toString(16).padStart(8, "0") };
        break;
      }
      const seqLo = view.getUint32(4, true), seqHi = view.getUint32(8, true);
      // index < 2^53, so a high word >= 2^21 can never be equal to it.
      if (seqHi >= 0x200000 || seqHi * 4294967296 + seqLo !== index) {
        fail = { token: "bad-seq", record: index, offset: pos, expected: String(index), actual: view.getBigUint64(4, true).toString() };
        break;
      }
      batch.push({ rec, pos, len, index, ts: view.getBigUint64(12, true) });
      pos += total;
      batchBytes += total;
    }

    // Hash the batch in parallel. Each record's link is computed from the stored link of the record before it;
    // all earlier stored links are checked first (in order), so this equals the sequential chain.
    const sub = subtle();
    const digests = await Promise.all(
      batch.map((b, i) => {
        const prev = i === 0 ? r.head : batch[i - 1].rec.subarray(HEADER + batch[i - 1].len, HEADER + batch[i - 1].len + 32);
        const input = new Uint8Array(52 + b.len);
        input.set(prev, 0);
        input.set(b.rec.subarray(4, 20), 32); // seq, timestamp
        input.set(b.rec.subarray(0, 4), 48); // length
        input.set(b.rec.subarray(HEADER, HEADER + b.len), 52); // payload
        return sub.digest("SHA-256", input);
      }),
    );
    for (let i = 0; i < batch.length; i++) {
      const b = batch[i];
      const computed = new Uint8Array(digests[i]);
      const stored = b.rec.subarray(HEADER + b.len, HEADER + b.len + 32);
      if (!equal(computed, stored)) {
        fail = { token: "bad-link", record: b.index, offset: b.pos, expected: hex(computed), actual: hex(stored) };
        break;
      }
      if (r.records > 0 && b.ts < lastTs) r.timeReversals++;
      lastTs = b.ts;
      r.head = stored.slice();
      if (growRows(r.rows, r.rows.count + 1, maxRows)) {
        const k = r.rows.count++;
        r.rows.offset[k] = b.pos;
        r.rows.ts[k] = b.ts;
        r.rows.len[k] = b.len;
      } else r.rowsTruncated = true;
      r.records++;
      off = b.pos + HEADER + b.len + TRAILER;
      r.goodBytes = off;
      if (wanted.has(String(r.records))) r.links.set(String(r.records), r.head);
    }
    if (onProgress) onProgress(off, size);
  }
  if (signal && signal.aborted) throw cancelled();
  if (fail) {
    r.status = fail.token;
    r.problem = fail;
  }
  return r;
}

// ---- receipts ---------------------------------------------------------------------------------

const MAX_U64 = (1n << 64n) - 1n;

/** Parses a receipts file the way `fseal verify` does: every line must be a receipt, or the file is rejected. */
export function parseReceipts(text) {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // getline() yields no empty line at EOF
  const receipts = [];
  for (let n = 0; n < lines.length; n++) {
    const fields = lines[n].split(/[ \t\n\v\f\r]+/).filter((f) => f !== "");
    const fail = (why) => ({ receipts: [], error: { line: n + 1, message: why } });
    if (fields.length < 6 || fields[0] !== "fseal-receipt" || fields[1] !== "v1") return fail("not a receipt");
    const value = (f, name) => (f.startsWith(name) ? f.slice(name.length) : "");
    const c = value(fields[2], "count=");
    if (!/^[0-9]+$/.test(c)) return fail("not a receipt");
    const count = BigInt(c);
    if (count > MAX_U64) return fail("not a receipt");
    const head = parseHex(value(fields[3], "head="), 32);
    const key = parseHex(value(fields[4], "key="), 32);
    const sig = parseHex(value(fields[5], "sig="), 64);
    if (!head || !key || !sig) return fail("not a receipt");
    receipts.push({ count, head, key, sig });
  }
  return { receipts, error: null };
}

let ed25519Probe;
/** True if this runtime's WebCrypto can verify Ed25519 signatures. */
export function ed25519Supported() {
  if (!ed25519Probe) {
    ed25519Probe = (async () => {
      try {
        await subtle().importKey("raw", new Uint8Array(32).fill(1), { name: "Ed25519" }, false, ["verify"]);
        return true;
      } catch {
        return false;
      }
    })();
  }
  return ed25519Probe;
}

function signedMessage(count, head) {
  const label = new TextEncoder().encode("fseal-receipt v1");
  const m = new Uint8Array(label.length + 8 + 32);
  m.set(label, 0);
  new DataView(m.buffer).setBigUint64(label.length, count, true);
  m.set(head, label.length + 8);
  return m;
}

/**
 * Checks every receipt like `fseal verify`: key, then signature, then count, then head link.
 * Receipts past the first problem in a broken log are "unchecked". If Ed25519 is unavailable, signatures are
 * reported as not checked (sigChecked: false) and the other checks still run.
 */
export async function checkReceipts(receipts, trustedKey, scan) {
  const canVerify = await ed25519Supported();
  const keys = new Map();
  const results = [];
  for (let i = 0; i < receipts.length; i++) {
    const rc = receipts[i];
    const out = { index: i + 1, count: rc.count, result: "ok", sigChecked: false, receiptHead: hex(rc.head), logHead: null };
    if (!equal(rc.key, trustedKey)) {
      out.result = "wrong-key";
      results.push(out);
      continue;
    }
    if (canVerify) {
      const k = hex(rc.key);
      if (!keys.has(k)) keys.set(k, subtle().importKey("raw", rc.key, { name: "Ed25519" }, false, ["verify"]).catch(() => null));
      const key = await keys.get(k);
      const ok = key ? await subtle().verify({ name: "Ed25519" }, key, rc.sig, signedMessage(rc.count, rc.head)) : false;
      out.sigChecked = true;
      if (!ok) {
        out.result = "bad-signature";
        results.push(out);
        continue;
      }
    }
    // Key and signature first: an untrusted receipt is untrusted wherever it points (as in `fseal verify`).
    if (scan.status !== "ok" && rc.count > BigInt(scan.records)) {
      out.result = "unchecked";
      results.push(out);
      continue;
    }
    if (rc.count > BigInt(scan.records)) {
      out.result = "log-shorter";
      results.push(out);
      continue;
    }
    const at = rc.count === 0n ? new Uint8Array(32) : scan.links.get(rc.count.toString()) || new Uint8Array(32);
    out.logHead = hex(at);
    if (!equal(at, rc.head)) out.result = "head-mismatch";
    results.push(out);
  }
  return { results, signaturesChecked: canVerify };
}

/**
 * The overall verdict. With receipt signatures checked (or no receipts) it follows verify() in src/main.cpp
 * exactly. Without Ed25519 in this runtime, receipts are not authenticated: anyone could have written them, so a
 * receipt that disagrees with the log is not evidence of tampering and one that agrees is not evidence of
 * integrity. A receipt signed by a key you do not trust, or with an invalid signature, is the same: anyone can
 * make one. TAMPERED therefore
 * needs a broken chain, or a receipt with a valid signature by the trusted key that disagrees with the log;
 * receipts that prove nothing either way give UNVERIFIED (the CLI's exit status 3).
 *
 * Three things are reported separately: chain consistency (scan.status), authenticated receipt coverage
 * (`covered`, records 0..covered-1 are pinned by a receipt you can trust) and the unprotected suffix
 * (`uncovered` records after the last authenticated receipt).
 */
export function summarize(scan, receiptCheck) {
  const list = receiptCheck ? receiptCheck.results : [];
  const authenticated = list.length > 0 && receiptCheck.signaturesChecked;
  let covered = 0n, failed = 0, unchecked = 0, unverifiedMismatches = 0, untrusted = 0;
  let firstFailure = null, firstUntrusted = null;
  for (const x of list) {
    if (x.result === "unchecked") unchecked++;
    else if (x.result === "ok") covered = x.count > covered ? x.count : covered;
    else if (!authenticated) unverifiedMismatches++;
    else if (x.result === "wrong-key" || x.result === "bad-signature") {
      if (untrusted++ === 0) firstUntrusted = x;
    } else if (failed++ === 0) firstFailure = x;
  }
  if (!authenticated) covered = 0n;
  let result;
  if (list.length === 0 || authenticated) {
    const bad = scan.status !== "ok" || failed > 0;
    // A torn final record is reported as tampering only when an authenticated receipt is present.
    result = !bad ? (untrusted ? "UNVERIFIED" : "INTACT") : scan.status === "torn-tail" && list.length === untrusted ? "INCOMPLETE" : "TAMPERED";
  } else if (scan.status !== "ok" && scan.status !== "torn-tail") result = "TAMPERED";
  else result = scan.status === "torn-tail" ? "INCOMPLETE" : "UNVERIFIED";
  return {
    result,
    authenticated,
    receipts: list.length,
    matched: list.length - failed - unchecked - unverifiedMismatches - untrusted,
    failed,
    untrusted,
    firstUntrusted,
    unchecked,
    unverifiedMismatches,
    firstFailure,
    covered,
    uncovered: BigInt(scan.records) - covered,
  };
}

/**
 * Text identical to `fseal verify LOG [--receipts R --pubkey K]` stdout whenever signatures were checked; the
 * cross-check tests compare it byte for byte. When they could not be checked it says so and never says INTACT.
 */
export function cliReport(path, scan, receiptCheck) {
  const s = summarize(scan, receiptCheck);
  const out = [];
  out.push(`FlightSeal verify: ${path}`);
  out.push(`  records      ${scan.records}${scan.status === "ok" ? " intact" : " intact before the problem"}`);
  out.push(`  head         ${hex(scan.head)}`);
  out.push(`  time order   ${scan.timeReversals} backward timestamp(s)`);
  if (scan.status !== "ok")
    out.push(`  first problem  record ${scan.records}, byte ${scan.goodBytes}: ${PROBLEM_TEXT[scan.status]} [${scan.status}]`);
  if (s.receipts > 0 && s.authenticated) {
    if (s.firstFailure)
      out.push(`  receipt ${s.firstFailure.index} (count ${s.firstFailure.count}): ${RECEIPT_TEXT[s.firstFailure.result]}`);
    if (s.firstUntrusted)
      out.push(`  receipt ${s.firstUntrusted.index} (count ${s.firstUntrusted.count}): ${RECEIPT_TEXT[s.firstUntrusted.result]} (not evidence either way)`);
    let line = `  receipts     ${s.matched} of ${s.receipts} match`;
    if (s.untrusted) line += `; ${s.untrusted} not validly signed by the key you trust`;
    if (s.unchecked) line += `; ${s.unchecked} cannot be checked past the first problem`;
    else if (s.failed === 0 && s.untrusted === 0) line += `; ${s.uncovered} record(s) after the last receipt are not covered`;
    out.push(line);
  } else if (s.receipts > 0) {
    out.push(`  signatures   NOT CHECKED: this browser cannot verify Ed25519, so the receipts are not authenticated`);
    if (s.firstFailure)
      out.push(`  receipt ${s.firstFailure.index} (count ${s.firstFailure.count}): ${RECEIPT_TEXT[s.firstFailure.result]}`);
    let line = `  receipts     ${s.receipts} loaded, none authenticated; ${s.matched} agree with the log, ${s.unverifiedMismatches} do not`;
    if (s.unchecked) line += `, ${s.unchecked} cannot be checked past the first problem`;
    out.push(line);
    out.push(`  coverage     no record is covered by an authenticated receipt`);
  }
  const why = {
    INCOMPLETE: "INCOMPLETE (if the writer crashed, run: fseal recover)",
    UNVERIFIED: s.authenticated
      ? "UNVERIFIED (receipts not validly signed by the key you trust)"
      : "UNVERIFIED (hash chain intact; receipt signatures NOT CHECKED; run fseal verify)",
  };
  out.push(`RESULT: ${why[s.result] || s.result}`);
  return out.join("\n") + "\n";
}

/** Decodes a receipts file like the C++ reader sees it: a byte-order mark is kept (and rejected), not stripped. */
export function decodeReceipts(bytes) {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/** Reads one record's bytes for the detail view. Returns null if the offset is not a whole record. */
export async function readRecord(source, offset) {
  if (offset + HEADER > source.size) return null;
  const head = await source.read(offset, HEADER);
  const len = new DataView(head.buffer, head.byteOffset, HEADER).getUint32(0, true);
  const total = HEADER + Math.min(len, MAX_PAYLOAD) + TRAILER;
  const rec = await source.read(offset, Math.min(total, source.size - offset));
  const v = new DataView(rec.buffer, rec.byteOffset, rec.length);
  const whole = len <= MAX_PAYLOAD && rec.length === total;
  return {
    offset,
    length: len,
    seq: rec.length >= 12 ? v.getBigUint64(4, true) : null,
    ts: rec.length >= 20 ? v.getBigUint64(12, true) : null,
    payload: whole ? rec.subarray(HEADER, HEADER + len) : rec.subarray(HEADER),
    link: whole ? hex(rec.subarray(HEADER + len, HEADER + len + 32)) : null,
    crc: whole ? v.getUint32(total - 4, true).toString(16).padStart(8, "0") : null,
    whole,
  };
}
