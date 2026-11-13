// UI for the FlightSeal verifier. All checking is in verifier.js; this file reads files, renders and keeps the
// view in the URL (?sample=...&record=N) so a sample view can be shared.
import {
  scanLog, parseReceipts, checkReceipts, summarize, cliReport, blobSource, readRecord, parseHex, ed25519Supported,
  decodeReceipts, PROBLEM_TEXT, RECEIPT_TEXT, MAGIC,
} from "./verifier.js";

const $ = (id) => document.getElementById(id);
const PAGE = 50;
const MAX_RECEIPTS_BYTES = 16 << 20;
const MAX_KEY_FILE_BYTES = 4096;
const MAX_ROWS = 2_000_000; // records kept for the table (about 40 MB); verification itself has no limit
const fmt = new Intl.NumberFormat("en-US");
const n = (x) => fmt.format(x);

const state = {
  log: null, // { blob, name, fromSample }
  receipts: null, // { text, name, fromSample } or { error, name }
  pubkey: "",
  pubkeyFromSample: false,
  sample: null,
  result: null, // { scan, check, summary, source }
  page: 0,
  selected: null,
  run: 0,
  abort: null,
};

// ---- small DOM helpers -------------------------------------------------------------------------
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
// Status glyphs drawn as SVG (not emoji), always next to text.
const ICONS = {
  ok: "M3 8.5l3 3 7-7",
  bad: "M4 4l8 8M12 4l-8 8",
  warn: "M8 2.5v7M8 12.5v1",
};
function icon(kind) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `icon ${kind}`);
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", ICONS[kind]);
  svg.append(p);
  return svg;
}
function code(text, cls = "hash") {
  return el("code", { class: cls, text });
}

// ---- inputs ---------------------------------------------------------------------------------
const NO_FILE = "No file chosen";
// A file of the user's own replaces every input that came from a sample, so a sample's receipts and key are
// never checked against the user's log (an honest log sealed with another key would look rewritten).
function clearSampleInputs() {
  state.sample = null;
  if (state.log && state.log.fromSample) clearLog();
  if (state.receipts && state.receipts.fromSample) clearReceipts();
  if (state.pubkeyFromSample) setKey("", false);
}
function clearLog() {
  state.log = null;
  $("log-file").value = "";
  $("log-name").textContent = NO_FILE;
  $("log-clear").hidden = true;
}
function clearReceipts() {
  state.receipts = null;
  $("rec-file").value = "";
  $("rec-name").textContent = NO_FILE;
  $("rec-clear").hidden = true;
}
async function setLog(blob, name, fromSample = false) {
  if (!fromSample) clearSampleInputs();
  state.log = { blob, name, fromSample };
  $("log-name").textContent = `${name}, ${n(blob.size)} bytes`;
  $("log-clear").hidden = false;
}
async function setReceipts(blob, name, fromSample = false) {
  if (!fromSample) clearSampleInputs();
  if (blob.size > MAX_RECEIPTS_BYTES) {
    state.receipts = { error: `${name} is ${n(blob.size)} bytes; a receipts file over 16 MB is not read here. Use the fseal CLI.`, name, fromSample };
  } else {
    // Decoded without stripping a byte-order mark, so a file the CLI rejects is rejected here too.
    state.receipts = { text: decodeReceipts(new Uint8Array(await blob.arrayBuffer())), name, fromSample };
  }
  $("rec-name").textContent = `${name}, ${n(blob.size)} bytes`;
  $("rec-clear").hidden = false;
}
function setKey(text, fromSample = false) {
  state.pubkey = text.trim().toLowerCase();
  state.pubkeyFromSample = fromSample;
  $("pubkey").value = state.pubkey;
}

async function classify(file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const isLog = head.length >= 8 && MAGIC.every((b, i) => head[i] === b);
  if (isLog || /\.fseal$/i.test(file.name)) return "log";
  if (file.size <= MAX_KEY_FILE_BYTES && /^\s*[0-9a-fA-F]{64}\s*$/.test(await file.text())) return "key";
  if (/\.receipts?$/i.test(file.name) || new TextDecoder().decode(head).startsWith("fseal-receipt")) return "receipts";
  return "log"; // unknown: check it as a log, which reports what is wrong with it
}

async function addFiles(files) {
  try {
    for (const f of files) {
      const kind = await classify(f);
      if (kind === "log") await setLog(f, f.name);
      else if (kind === "receipts") await setReceipts(f, f.name);
      else {
        clearSampleInputs();
        setKey(await f.text());
      }
    }
  } catch (e) {
    showError(`Could not read the dropped file (a folder cannot be checked): ${e.message || e}`);
    return;
  }
  state.selected = null;
  state.page = 0;
  syncUrl();
  verify();
}

async function loadSample(name, record = null) {
  const get = async (p) => {
    const r = await fetch(`samples/${p}`);
    if (!r.ok) throw new Error(`could not load samples/${p} (HTTP ${r.status})`);
    return r.blob();
  };
  try {
    const [log, rec, key] = await Promise.all([get(`${name}.fseal`), get("flight.receipts"), get("pubkey.txt")]);
    state.sample = name;
    await setLog(log, `${name}.fseal (sample)`, true);
    await setReceipts(rec, "flight.receipts (sample)", true);
    setKey(await key.text(), true);
    $("log-file").value = "";
    $("rec-file").value = "";
    state.selected = record;
    state.page = 0;
    syncUrl();
    await verify();
  } catch (e) {
    showError(`Could not load the ${name} sample: ${e.message || e}. Check your connection and reload, or choose your own files.`);
  }
}

function syncUrl() {
  const u = new URL(location.href);
  u.search = "";
  if (state.sample) u.searchParams.set("sample", state.sample);
  if (state.sample && state.selected != null) u.searchParams.set("record", String(state.selected));
  history.replaceState(null, "", u);
}

// ---- verification ----------------------------------------------------------------------------
// Scans in a module worker (Cancel terminates it at once); falls back to the main thread, where scanLog yields to
// the page every few milliseconds, if a worker cannot be started.
function runScan(blob, options) {
  const { signal, onProgress } = options;
  let worker;
  try {
    worker = new Worker(new URL("scan-worker.js", import.meta.url), { type: "module" });
  } catch {
    return scanLog(blobSource(blob), options);
  }
  return new Promise((resolve, reject) => {
    const stop = () => {
      worker.terminate();
      reject(new DOMException("verification cancelled", "AbortError"));
    };
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") return onProgress(m.done, m.size);
      signal.removeEventListener("abort", stop);
      worker.terminate();
      if (m.type === "done") resolve(m.result);
      else reject(new Error(m.message));
    };
    worker.onerror = (e) => {
      // A worker that fails to load (old browser, unusual hosting): verify on the main thread instead.
      e.preventDefault();
      signal.removeEventListener("abort", stop);
      worker.terminate();
      scanLog(blobSource(blob), options).then(resolve, reject);
    };
    worker.postMessage({ blob, linksAt: options.linksAt, maxRows: options.maxRows });
  });
}

function showError(message) {
  $("verdict-line").replaceChildren(icon("warn"), el("span", { text: message }));
  $("verdict-line").className = "verdict-line warn";
}

async function verify() {
  const run = ++state.run;
  if (state.abort) state.abort.abort();
  clearResult();
  if (!state.log) {
    $("verdict-line").className = "verdict-line";
    $("verdict-line").textContent = "Load a sealed log or a sample to check it.";
    return;
  }
  let receipts = null, key = null, receiptError = null, emptyReceipts = false;
  if (state.receipts) {
    if (state.receipts.error) receiptError = state.receipts.error;
    else {
      const parsed = parseReceipts(state.receipts.text);
      if (parsed.error) receiptError = `${state.receipts.name}, line ${parsed.error.line}: not a receipt. Nothing was checked against the receipts.`;
      else if (parsed.receipts.length === 0) emptyReceipts = true, receiptError = `${state.receipts.name} contains no receipts, so nothing was checked against receipts.`;
      else receipts = parsed.receipts;
    }
    if (receipts) {
      key = parseHex(state.pubkey, 32);
      if (!key) receiptError = state.pubkey
        ? "The public key must be 64 hexadecimal digits. The receipts were not checked."
        : "Enter the public key you trust to check the receipts. The receipts were not checked.";
    }
  }
  $("pubkey").setAttribute("aria-invalid", receipts && !key && state.pubkey ? "true" : "false");

  const source = blobSource(state.log.blob);
  const abort = new AbortController();
  state.abort = abort;
  $("progress-wrap").hidden = state.log.blob.size < (4 << 20) && !(receipts && key && receipts.length > 1000);
  $("progress").value = 0;
  let last = 0;
  try {
    const scan = await runScan(state.log.blob, {
      linksAt: receipts ? receipts.map((r) => r.count) : [],
      maxRows: MAX_ROWS,
      signal: abort.signal,
      onProgress: (done, size) => {
        const now = performance.now();
        if (now - last > 100) {
          last = now;
          $("progress").value = size ? Math.round((100 * done) / size) : 100;
        }
      },
    });
    const check = receipts && key ? await checkReceipts(receipts, key, scan, abort.signal) : null;
    if (run !== state.run) return;
    if (abort.signal.aborted) throw new DOMException("verification cancelled", "AbortError"); // never a verdict after Cancel
    const summary = summarize(scan, check);
    state.result = { scan, check, summary, source, receiptError, emptyReceipts };
    render();
  } catch (e) {
    if (run !== state.run) return;
    showError(e.name === "AbortError" ? "Verification cancelled." : `Could not check this file: ${e.message || e}`);
  } finally {
    if (run === state.run) $("progress-wrap").hidden = true;
  }
}

function clearResult() {
  state.result = null;
  for (const id of ["verdict-detail", "facts", "break", "notes", "rec-body", "receipts-body", "strip", "strip-legend"]) $(id).replaceChildren();
  $("records-area").hidden = true;
  $("receipts-area").hidden = true;
  $("strip-wrap").hidden = true;
  $("report-wrap").hidden = true;
  $("detail-h").textContent = "Record";
  $("detail").replaceChildren(el("p", { class: "muted", text: "Choose a record to see its fields." }));
}

// ---- verdict ---------------------------------------------------------------------------------
const plural = (k, word) => `${n(k)} ${word}${k === 1 || k === 1n ? "" : "s"}`;
const allPass = (k) => (k === 1 ? "The 1 record passes" : `All ${n(k)} records pass`);
const lowestCount = (list) => list.reduce((m, x) => (!m || x.count < m.count ? x : m), null);
// Three things are judged separately: whether the hash chain is consistent (proved without any key), whether
// receipts signed by the key you trust cover the log, and which records no authenticated receipt covers.
function verdictFor(r) {
  const { scan, check, summary } = r;
  const p = scan.problem;
  const authenticated = summary.authenticated;
  const unauthenticated = check && !authenticated;
  if (scan.status === "bad-header") return { kind: "bad", head: "Not a FlightSeal log", body: [`The file does not start with the FlightSeal header. Nothing in it was checked.`] };

  // 1. The chain itself (no key needed).
  if (scan.status !== "ok" && scan.status !== "torn-tail") {
    const what = {
      "bad-crc": `the checksum of record ${n(p.record)} does not match its bytes: they were changed or damaged`,
      "bad-seq": `record ${n(p.record)} has sequence number ${p.actual}, not ${p.expected}: a record was deleted, reordered or duplicated`,
      "bad-link": `the contents of record ${n(p.record)} changed after sealing: its link does not match the record and the one before it`,
      "bad-length": p.crafted
        ? `record ${n(p.record)} claims a length of ${n(Number(p.actual))} bytes, which runs past the end of the file, and the bytes after it hold many possible starts of record ${n(p.record + 1)}: this is treated as corruption, not a crash, so fseal recover will not trim anything`
        : p.nextAt != null
        ? `record ${n(p.record)} claims a length of ${n(Number(p.actual))} bytes, which runs past the end of the file, but a complete record ${n(p.record + 1)} starts at byte ${n(p.nextAt)}: the length field was corrupted. This is not what a crash leaves, so fseal recover will not trim anything; the records after it are evidence`
        : `record ${n(p.record)} claims a length of ${n(Number(p.actual))} bytes, more than any record can have: the file is corrupt`,
    }[scan.status];
    return { kind: "bad", head: `Tampered: the chain breaks at record ${n(p.record)}`, body: [
      `At byte ${n(p.offset)}, ${what}. ${scan.records ? `Records 0 to ${n(scan.records - 1)} are intact.` : "No record before it passed."}`,
      `A hash chain pinpoints the first record where the chain breaks, not every altered record. Records after ${n(p.record)} were not checked and may also have been changed.`,
    ] };
  }

  // 2. Receipts that cannot be authenticated in this browser are not evidence either way.
  if (unauthenticated) {
    const mism = summary.unverifiedMismatches;
    return { kind: "warn", head: scan.status === "torn-tail" ? "Incomplete; receipts not authenticated" : "Chain intact; receipts not authenticated", body: [
      scan.status === "torn-tail"
        ? `Records 0 to ${n(scan.records - 1)} pass every check; the last ${n(scan.size - scan.goodBytes)} bytes are an unfinished record, as a crash leaves it.`
        : `${allPass(scan.records)} their checksum, sequence and hash-chain checks.`,
      `This browser cannot verify Ed25519 signatures, so the ${plural(summary.receipts, "receipt")} ${summary.receipts === 1 ? "is" : "are"} not authenticated: anyone could have written them. ${mism ? `${n(mism)} disagree with the log, which proves nothing without a valid signature.` : "Agreeing with the log proves nothing without a valid signature."} No record is covered by an authenticated receipt. Use the fseal CLI or a browser with Ed25519 to check them.`,
    ] };
  }

  // 3. Authenticated receipts (valid signature by the key you trust) that disagree with the log: proof.
  if (summary.failed > 0) {
    const f = lowestCount(check.results.filter((x) => x.result === "head-mismatch" || x.result === "log-shorter"));
    const prevOk = check.results.filter((x) => x.result === "ok" && x.count < f.count).reduce((m, x) => (x.count > m ? x.count : m), 0n);
    const body = {
      "head-mismatch": `Every record passes its own checks, but receipt ${f.index}, signed by the key you trust after ${plural(f.count, "record")}, pins a different chain head: the log was rewritten after the receipt was issued, or these receipts belong to another log sealed with the same key. If they are this log's receipts, something in records ${n(prevOk)} to ${n(f.count - 1n)} changed${prevOk ? ` (the receipt after ${plural(prevOk, "record")} still matches)` : ""}. A receipt mismatch cannot say which record in that range was edited.`,
      "log-shorter": `Every record passes its own checks, but receipt ${f.index}, signed by the key you trust, says ${plural(f.count, "record")} had been written and this log has ${n(scan.records)}: records were removed from the end, or these receipts belong to another log sealed with the same key.`,
    }[f.result];
    return { kind: "bad", head: `Tampered: receipt ${f.index} does not match the log`, body: [body] };
  }

  // 4. Receipts not validly signed by the key you trust: anyone could have made them, so they prove nothing.
  if (summary.untrusted > 0) {
    const u = lowestCount(check.results.filter((x) => x.result === "wrong-key" || x.result === "bad-signature"));
    return { kind: "warn", head: scan.status === "torn-tail" ? "Incomplete; receipts not valid for the key you trust" : "Chain intact; receipts not valid for the key you trust", body: [
      scan.status === "torn-tail"
        ? `Records 0 to ${n(scan.records - 1)} pass every check; the last ${n(scan.size - scan.goodBytes)} bytes are an unfinished record, as a crash leaves it.`
        : `${allPass(scan.records)} their checksum, sequence and hash-chain checks.`,
      `${plural(summary.untrusted, "receipt")} ${summary.untrusted === 1 ? "is" : "are"} not validly signed by the key you entered (the lowest is receipt ${u.index}, after ${plural(u.count, "record")}: ${u.result === "wrong-key" ? "it names a different signing key" : "its signature does not verify"}). Anyone can write such a receipt, so it is no evidence that the log was or was not changed. Check the key with the operator, or ask the witness for the receipts they kept.`,
    ] };
  }

  // 5. A torn final record (a crash leaves one); the CLI reports TAMPERED for it whenever receipts are given.
  if (scan.status === "torn-tail") {
    return { kind: "warn", head: "Incomplete: the final record is cut short", body: [
      `Records 0 to ${n(scan.records - 1)} pass every check${check ? `, and ${summary.matched} of ${summary.receipts} receipts match` : ""}. Record ${n(p.record)} is cut short (the last ${n(scan.size - scan.goodBytes)} bytes), as a crash while writing leaves it. fseal recover trims only that record.`,
      ...(check ? [`fseal verify reports TAMPERED whenever receipts are given and the log has any problem, including this one; run fseal recover and verify again.`] : []),
    ] };
  }

  if (scan.records === 0) return { kind: "warn", head: "The log has no records", body: ["The file is a FlightSeal log header with no records after it, so there is nothing to check."] };
  if (check) {
    return { kind: "ok", head: "Intact", body: [
      `${allPass(scan.records)} their checksum, sequence and hash-chain checks, and ${summary.receipts === 1 ? "the receipt" : `all ${summary.receipts} receipts`}, signed by the key you trust, match${summary.receipts === 1 ? "es" : ""} the log.`,
      summary.uncovered > 0n
        ? `The last ${plural(summary.uncovered, "record")}, from record ${n(summary.covered)} on, come after the last receipt: no receipt protects them, so whoever holds the file could have changed them.`
        : "The last receipt covers the final record, so every record is protected by a receipt.",
    ] };
  }
  return { kind: "warn", head: "Chain intact; no receipts checked", body: [
    `${allPass(scan.records)} their checksum, sequence and hash-chain checks. Without receipts this shows only that the file is self-consistent.`,
  ] };
}

function render() {
  const r = state.result;
  const { scan, check, summary } = r;
  const v = verdictFor(r);
  const line = $("verdict-line");
  line.className = `verdict-line ${v.kind}`;
  line.replaceChildren(icon(v.kind), el("span", { text: v.head }));
  $("verdict-detail").replaceChildren(...v.body.map((t) => el("p", { text: t })));

  // Facts.
  const chain = scan.status === "ok" ? `consistent: ${plural(scan.records, "record")} pass${scan.records === 1 ? "es" : ""}`
    : scan.status === "bad-header" ? "not checked: not a FlightSeal log"
    : `${plural(scan.records, "record")} pass${scan.records === 1 ? "es" : ""}, then ${scan.status === "torn-tail" ? "a cut-short record" : `a break at record ${n(scan.problem.record)}`} [${scan.status}]`;
  let receiptsText = r.emptyReceipts ? "file loaded, 0 receipts" : "none loaded";
  if (check && !summary.authenticated) receiptsText = `${summary.receipts} loaded, NOT authenticated (signatures not checked in this browser)`;
  else if (check) {
    receiptsText = `${summary.matched} of ${summary.receipts} signed by the key you trust and match`;
    if (summary.untrusted) receiptsText += `; ${summary.untrusted} not validly signed by that key`;
    if (summary.unchecked) receiptsText += `; ${summary.unchecked} cannot be checked past the first problem`;
  }
  const coverage = !check || !summary.authenticated ? `none: no checked record has an authenticated receipt`
    : summary.failed ? "not established: a receipt does not match"
    : scan.status !== "ok" ? (summary.covered > 0n ? `records 0 to ${n(summary.covered - 1n)}; nothing from the problem at record ${n(scan.problem.record)} on` : `none before the problem at record ${n(scan.problem.record)}`)
    : summary.covered === 0n ? `none: no receipt signed by the key you trust matches`
    : summary.uncovered > 0n ? `records 0 to ${n(summary.covered - 1n)}; the last ${plural(summary.uncovered, "record")} ${summary.uncovered === 1n ? "is" : "are"} not covered`
    : `all ${plural(scan.records, "record")}`;
  const facts = [
    ["Log", state.log.name],
    ["Hash chain", chain],
    ["Receipts", receiptsText],
    ["Covered by a receipt", coverage],
    ["Chain head", code(Array.from(scan.head, (b) => b.toString(16).padStart(2, "0")).join(""))],
    ["Time order", `${n(scan.timeReversals)} backward timestamp(s) (counted, not trusted)`],
  ];
  $("facts").replaceChildren(...facts.flatMap(([k, val]) => [el("dt", { text: k }), el("dd", {}, val)]));

  renderBreak(r);
  renderNotes(r);
  renderStrip(r);
  renderReceipts(r);

  $("report").textContent = cliReport(state.log.name, scan, check);
  $("report-wrap").hidden = false;

  $("show-break").hidden = !scan.problem || scan.status === "bad-header";
  const want = state.selected != null ? state.selected : scan.problem ? scan.problem.record : 0;
  goToRecord(want, state.selected != null || !!scan.problem);
}

function renderBreak(r) {
  const { scan, check, summary } = r;
  const box = $("break");
  const p = scan.problem;
  const pair = (title, a, b, la, lb) =>
    el("div", { class: "compare" },
      el("h3", { text: title }),
      el("dl", {}, el("dt", { text: la }), el("dd", {}, code(a)), el("dt", { text: lb }), el("dd", {}, code(b, "hash actual"))));
  if (p && p.expected != null && scan.status !== "bad-header") {
    const labels = {
      "bad-link": ["Expected link (SHA-256 of the previous link and this record)", "Link stored in the record"],
      "bad-crc": ["Expected CRC-32 (computed from the record's bytes)", "CRC-32 stored in the record"],
      "bad-seq": ["Expected sequence number", "Sequence number in the record"],
      "bad-length": ["Allowed payload length", "Length field in the record"],
    }[p.token];
    box.replaceChildren(pair(`First break: record ${n(p.record)}, byte ${n(p.offset)} [${p.token}]`, p.expected, p.actual, ...labels));
  } else if (summary.authenticated && summary.failed > 0
    && lowestCount(r.check.results.filter((x) => x.result === "head-mismatch" || x.result === "log-shorter")).result === "head-mismatch") {
    const f = lowestCount(r.check.results.filter((x) => x.result === "head-mismatch"));
    box.replaceChildren(pair(`Receipt ${f.index}, after ${n(f.count)} records`, f.receiptHead, f.logHead, "Head link in the receipt (signed when it was issued)", `Link of record ${n(f.count - 1n)} in this log`));
  } else if (p && p.detail) {
    box.replaceChildren(el("div", { class: "compare" }, el("h3", { text: `First problem: record ${n(p.record)}, byte ${n(p.offset)} [${p.token}]` }), el("p", { text: p.detail })));
  } else box.replaceChildren();
}

function renderNotes(r) {
  const out = [];
  const note = (kind, text) => out.push(el("p", { class: `note ${kind}` }, icon(kind), el("span", { text })));
  if (r.receiptError) note("warn", r.receiptError);
  if (!r.check) note("warn", "No receipts loaded. Truncation of the tail (records deleted from the end) is only caught with receipts, and so is a log its holder rebuilt with every link recomputed. Load the receipts and the public key to check for both.");
  if (r.check && !r.check.signaturesChecked)
    note("warn", "This browser's WebCrypto cannot verify Ed25519 signatures, so the receipt signatures were NOT checked and the receipts are not evidence. The checksums, sequence numbers and hash chain were still verified. Use a current version of Chrome, Edge, Firefox or Safari, or the fseal CLI.");
  if (r.scan.rowsTruncated) note("warn", `Only the first ${n(MAX_ROWS)} records are listed below; all ${n(r.scan.records)} were verified.`);
  $("notes").replaceChildren(...out);
}

function renderStrip(r) {
  const { scan, check } = r;
  if (!scan.size) return;
  const pct = (b) => `${Math.max(0, Math.min(100, (100 * b) / scan.size))}%`;
  const strip = $("strip");
  const ok = el("span", { class: "seg verified" });
  ok.style.width = pct(scan.goodBytes);
  const kids = [ok];
  if (scan.goodBytes < scan.size) {
    const rest = el("span", { class: "seg unchecked" });
    rest.style.width = pct(scan.size - scan.goodBytes);
    const mark = el("span", { class: "break-mark" });
    mark.style.left = pct(scan.goodBytes);
    kids.push(rest, mark);
  }
  if (check) {
    const rows = scan.rows;
    for (const x of check.results) {
      if (x.result === "unchecked" || x.count === 0n) continue;
      const c = Number(x.count);
      const at = c <= rows.count ? rows.offset[c - 1] + 56 + rows.len[c - 1] : scan.size;
      const proof = r.summary.authenticated && (x.result === "head-mismatch" || x.result === "log-shorter");
      const t = el("span", { class: `tick ${proof ? "bad" : "ok"}` });
      t.style.left = pct(at);
      kids.push(t);
    }
  }
  strip.replaceChildren(...kids);
  const legend = [`Bytes 0 to ${n(scan.goodBytes)} of ${n(scan.size)} verified.`];
  if (scan.goodBytes < scan.size) legend.push(`The rest was not checked.`);
  if (check && r.summary.authenticated) legend.push(r.summary.untrusted
    ? "Marks above the bar are receipts: thin marks match or were not checked against your key (not signed by it), thick marks are receipts signed by your key that do not match."
    : "Marks above the bar are receipts (thin: matches, thick: does not match).");
  else if (check) legend.push("Marks above the bar are receipts that could not be authenticated.");
  $("strip-legend").textContent = legend.join(" ");
  $("strip-wrap").hidden = false;
}

function renderReceipts(r) {
  if (!r.check) return;
  const authenticated = r.summary.authenticated;
  const rows = r.check.results.map((x) => {
    let kind = x.result === "ok" ? "ok" : x.result === "unchecked" || x.result === "wrong-key" || x.result === "bad-signature" ? "warn" : "bad";
    let label = x.result === "unchecked" ? "not checked: past the first problem" : RECEIPT_TEXT[x.result];
    if (x.result === "wrong-key" || x.result === "bad-signature") label = `${RECEIPT_TEXT[x.result].split(" (")[0]}: not evidence either way`;
    if (!authenticated && x.result !== "unchecked") {
      kind = "warn";
      label = x.result === "ok" ? "agrees with the log, but not authenticated" : `disagrees with the log, but not authenticated (${RECEIPT_TEXT[x.result].split(" (")[0]})`;
    }
    const sig = x.result === "unchecked" || x.result === "wrong-key" ? "not checked" : x.sigChecked ? (x.result === "bad-signature" ? "invalid" : "valid") : "not checked (no Ed25519 in this browser)";
    return el("tr", { class: kind === "bad" ? "row-bad" : null },
      el("td", { text: String(x.index) }),
      el("td", { text: n(x.count) }),
      el("td", {}, el("span", { class: `label ${kind}` }, icon(kind), el("span", { text: label }))),
      el("td", { text: sig }),
      el("td", {}, code(x.receiptHead)));
  });
  $("receipts-body").replaceChildren(...rows);
  $("receipts-area").hidden = false;
}

// ---- records table ------------------------------------------------------------------------------
function totalRows() {
  const s = state.result.scan;
  return s.rows.count + (s.problem && s.status !== "bad-header" ? 1 : 0);
}
function pages() {
  return Math.max(1, Math.ceil(totalRows() / PAGE));
}
function rowIndexFor(record) {
  const s = state.result.scan;
  if (s.problem && record === s.problem.record) return s.rows.count; // the broken record is the last row
  return record < s.rows.count ? record : null;
}

function goToRecord(record, select) {
  const idx = rowIndexFor(record);
  state.page = idx == null ? 0 : Math.floor(idx / PAGE);
  if (select && idx != null) state.selected = record;
  renderPage();
  if (select && idx != null) showDetail(record);
}

function renderPage() {
  const { scan } = state.result;
  $("records-area").hidden = false;
  const total = totalRows();
  const start = state.page * PAGE, end = Math.min(total, start + PAGE);
  const body = [];
  for (let i = start; i < end; i++) {
    if (i < scan.rows.count) {
      body.push(recordRow(i, String(i), scan.rows.ts[i].toString(), scan.rows.len[i], scan.rows.offset[i], null));
    } else {
      const p = scan.problem;
      body.push(recordRow(p.record, p.token === "bad-seq" ? p.actual : "", "", null, p.offset, p.token));
    }
  }
  $("rec-body").replaceChildren(...body);
  if (scan.problem && scan.status !== "bad-header" && end === total) fillProblemRow();
  // After a break the table holds the records checked, not the whole log, so the count says so.
  const range = end - start === 1 ? `Record ${n(start)}` : `Records ${n(start)} to ${n(end - 1)}`;
  const of = scan.problem && scan.status !== "bad-header"
    ? `${n(total)} checked (verification stopped at record ${n(scan.problem.record)})`
    : n(total);
  $("pg-label").textContent = total ? `${range} of ${of}, page ${n(state.page + 1)} of ${n(pages())}` : "No records";
  $("rec-caption").textContent = `Records, page ${state.page + 1} of ${pages()}`;
  $("pg-first").disabled = $("pg-prev").disabled = state.page === 0;
  $("pg-next").disabled = $("pg-last").disabled = state.page >= pages() - 1;
  const notChecked = scan.size - scan.goodBytes;
  $("rec-note").textContent = scan.problem
    ? `Verification stopped at record ${n(scan.problem.record)}. The ${n(notChecked)} bytes from there to the end of the file were not checked.`
    : `${n(scan.records)} records, every one checked.`;
}

function recordRow(record, seq, ts, len, offset, token) {
  const selected = state.selected === record;
  const btn = el("button", { type: "button", class: "linklike", "aria-label": `Show record ${record}`, onclick: () => { state.selected = record; syncUrl(); renderPage(); focusRow(record); showDetail(record); } }, String(record));
  const check = token
    ? el("span", { class: "label bad" }, icon("bad"), el("span", { text: token === "bad-link" ? "chain breaks here" : PROBLEM_TEXT[token].split(" (")[0] }))
    : el("span", { class: "label ok" }, icon("ok"), el("span", { text: "ok" }));
  const tr = el("tr", { class: [token ? "row-bad" : "", selected ? "row-selected" : ""].join(" ").trim() || null, "aria-current": selected ? "true" : null, "data-record": String(record) },
    el("th", { scope: "row" }, btn),
    el("td", { class: "num", text: seq }),
    el("td", { class: "num", text: ts }),
    el("td", { class: "num", text: len == null ? "" : n(len) }),
    el("td", { class: "num", text: n(offset) }),
    el("td", {}, check));
  return tr;
}

async function fillProblemRow() {
  const result = state.result;
  const { scan, source } = result;
  const rec = await readRecord(source, scan.problem.offset);
  if (result !== state.result) return; // another log or run replaced this one while reading
  const tr = document.querySelector(`#rec-body tr[data-record="${scan.problem.record}"]`);
  if (!rec || !tr) return;
  const cells = tr.querySelectorAll("td");
  cells[0].textContent = rec.seq == null ? "" : rec.seq.toString();
  cells[1].textContent = rec.ts == null ? "" : rec.ts.toString();
  cells[2].textContent = n(rec.length);
}

let detailToken = 0;
async function showDetail(record) {
  const result = state.result;
  const { scan, source } = result;
  const idx = rowIndexFor(record);
  if (idx == null) return;
  const token = ++detailToken;
  const offset = idx < scan.rows.count ? scan.rows.offset[idx] : scan.problem.offset;
  const rec = await readRecord(source, offset);
  if (token !== detailToken || result !== state.result) return; // a newer selection or log replaced this one
  const box = $("detail");
  $("detail-h").textContent = `Record ${n(record)}`;
  if (!rec) {
    box.replaceChildren(el("p", { text: `Only ${n(scan.size - offset)} bytes are left at offset ${n(offset)}: not enough for a record header.` }));
    return;
  }
  const isBroken = scan.problem && record === scan.problem.record;
  const items = [
    ["Check", isBroken ? `${PROBLEM_TEXT[scan.problem.token]} [${scan.problem.token}]` : "passes checksum, sequence and link"],
    ["File offset", n(offset)],
    ["Payload bytes", n(rec.length)],
    ["Sequence", rec.seq == null ? "missing" : rec.seq.toString()],
    ["Timestamp (µs)", rec.ts == null ? "missing" : rec.ts.toString()],
    ["Stored link", rec.link ? code(rec.link) : "missing (record cut short or impossible length)"],
    ["Stored CRC-32", rec.crc ? code(rec.crc) : "missing"],
  ];
  const shown = rec.payload.subarray(0, 4096);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(shown);
  box.replaceChildren(
    el("dl", { class: "kv" }, ...items.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", {}, v)])),
    el("h3", { text: rec.payload.length > shown.length ? `Payload (first ${n(shown.length)} of ${n(rec.payload.length)} bytes)` : "Payload" }),
    el("pre", { class: "payload mono", tabindex: "0", "aria-label": "Payload" }, text || "(empty)"),
  );
}

// On one column (phones) the Result box sits below the Files column, about 1,000 px under the sample buttons, so a
// tap would change nothing on screen. Scroll it to the top then; focus stays on the button. No smooth scrolling
// (DESIGN.md motion: none by default), and nothing moves when the result is already on screen.
function revealVerdict() {
  const box = $("verdict");
  const top = box.getBoundingClientRect().top;
  if (top < 0 || top > innerHeight - 80) box.scrollIntoView({ block: "start", behavior: "instant" });
}

// ---- events ---------------------------------------------------------------------------------
function wire() {
  // The native file inputs stay hidden: their own text says "No file chosen" even while a sample is loaded.
  $("log-choose").addEventListener("click", () => $("log-file").click());
  $("rec-choose").addEventListener("click", () => $("rec-file").click());
  $("log-file").addEventListener("change", (e) => e.target.files[0] && addFiles([e.target.files[0]]));
  $("rec-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await setReceipts(f, f.name);
    syncUrl();
    verify();
  });
  $("pubkey").addEventListener("change", () => { setKey($("pubkey").value); state.sample = null; syncUrl(); verify(); });
  $("log-clear").addEventListener("click", () => {
    state.log = null; state.sample = null; $("log-file").value = ""; $("log-name").textContent = NO_FILE; $("log-clear").hidden = true;
    syncUrl(); verify(); $("log-choose").focus();
  });
  $("rec-clear").addEventListener("click", () => {
    state.receipts = null; state.sample = null; $("rec-file").value = ""; $("rec-name").textContent = NO_FILE; $("rec-clear").hidden = true;
    syncUrl(); verify(); $("rec-choose").focus();
  });
  for (const b of document.querySelectorAll("[data-sample]")) b.addEventListener("click", () => { revealVerdict(); loadSample(b.dataset.sample); });
  $("cancel").addEventListener("click", () => state.abort && state.abort.abort());
  // Changing page re-renders the table; if the button that was used is now disabled (first or last page), keep
  // keyboard focus on the enabled button on the other side instead of losing it to the page body.
  const page = (p) => {
    const from = document.activeElement;
    state.page = Math.max(0, Math.min(pages() - 1, p));
    renderPage();
    if (from && from.disabled) {
      const other = { "pg-first": "pg-next", "pg-prev": "pg-next", "pg-next": "pg-prev", "pg-last": "pg-prev" }[from.id];
      if (other && !$(other).disabled) $(other).focus();
    }
  };
  $("pg-first").addEventListener("click", () => page(0));
  $("pg-prev").addEventListener("click", () => page(state.page - 1));
  $("pg-next").addEventListener("click", () => page(state.page + 1));
  $("pg-last").addEventListener("click", () => page(pages() - 1));
  $("jump").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = Number($("jump-to").value);
    if (!state.result || !Number.isInteger(v) || v < 0) return;
    if (rowIndexFor(v) == null) {
      $("rec-note").textContent = `Record ${n(v)} is not in the verified part of this log.`;
      return;
    }
    goToRecord(v, true);
    syncUrl();
    focusRow(v);
  });
  $("show-break").addEventListener("click", () => {
    const p = state.result && state.result.scan.problem;
    if (!p) return;
    goToRecord(p.record, true);
    syncUrl();
    focusRow(p.record);
  });
  $("copy-report").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("report").textContent);
      $("copy-status").textContent = "Copied.";
    } catch {
      $("copy-status").textContent = "Copy is blocked here; select the text above instead.";
    }
  });
  // Drop files anywhere on the page.
  addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
  addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
  addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
  });
}
function focusRow(record) {
  const b = document.querySelector(`#rec-body tr[data-record="${record}"] button`);
  if (b) b.focus();
}

wire();
ed25519Supported(); // start the probe early
// Offline use after one visit (sw.js). Scope is this folder; a failure only means no offline copy.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
const params = new URLSearchParams(location.search);
const sample = ["intact", "tampered", "rewritten", "truncated"].includes(params.get("sample")) ? params.get("sample") : "tampered";
const rec = /^\d{1,15}$/.test(params.get("record") || "") ? Number(params.get("record")) : null;
loadSample(sample, rec);
