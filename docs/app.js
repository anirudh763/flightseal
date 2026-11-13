// UI for the FlightSeal verifier. All checking is in verifier.js; this file reads files, renders and keeps the
// view in the URL (?sample=...&record=N) so a sample view can be shared.
import {
  scanLog, parseReceipts, checkReceipts, summarize, cliReport, blobSource, readRecord, parseHex, ed25519Supported,
  PROBLEM_TEXT, RECEIPT_TEXT, MAGIC,
} from "./verifier.js";

const $ = (id) => document.getElementById(id);
const PAGE = 100;
const MAX_RECEIPTS_BYTES = 16 << 20;
const MAX_KEY_FILE_BYTES = 4096;
const MAX_ROWS = 2_000_000; // records kept for the table (about 40 MB); verification itself has no limit
const fmt = new Intl.NumberFormat("en-US");
const n = (x) => fmt.format(x);

const state = {
  log: null, // { blob, name }
  receipts: null, // { text, name }
  pubkey: "",
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
async function setLog(blob, name, fromSample = false) {
  state.log = { blob, name };
  if (!fromSample) state.sample = null;
  $("log-name").textContent = `${name}, ${n(blob.size)} bytes`;
  $("log-clear").hidden = false;
}
async function setReceipts(blob, name, fromSample = false) {
  if (!fromSample) state.sample = null;
  if (blob.size > MAX_RECEIPTS_BYTES) {
    state.receipts = { error: `${name} is ${n(blob.size)} bytes; a receipts file over 16 MB is not read here. Use the fseal CLI.`, name };
  } else {
    state.receipts = { text: await blob.text(), name };
  }
  $("rec-name").textContent = `${name}, ${n(blob.size)} bytes`;
  $("rec-clear").hidden = false;
}
function setKey(text) {
  state.pubkey = text.trim().toLowerCase();
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
      else setKey(await f.text());
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
    setKey(await key.text());
    $("log-file").value = "";
    $("rec-file").value = "";
    state.selected = record;
    state.page = 0;
    syncUrl();
    await verify();
  } catch (e) {
    showError(String(e.message || e));
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
  let receipts = null, key = null, receiptError = null;
  if (state.receipts) {
    if (state.receipts.error) receiptError = state.receipts.error;
    else {
      const parsed = parseReceipts(state.receipts.text);
      if (parsed.error) receiptError = `${state.receipts.name}, line ${parsed.error.line}: not a receipt. Nothing was checked against the receipts.`;
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
  $("progress-wrap").hidden = state.log.blob.size < (4 << 20);
  $("progress").value = 0;
  let last = 0;
  try {
    const scan = await scanLog(source, {
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
    const check = receipts && key ? await checkReceipts(receipts, key, scan) : null;
    if (run !== state.run) return;
    const summary = summarize(scan, check);
    state.result = { scan, check, summary, source, receiptError, receiptsLoaded: !!state.receipts };
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
function verdictFor(r) {
  const { scan, check, summary } = r;
  const sigs = check && check.signaturesChecked;
  const p = scan.problem;
  if (scan.status === "bad-header") return { kind: "bad", head: "Not a FlightSeal log", body: [`The file does not start with the FlightSeal header. Nothing in it was checked.`] };
  if (scan.status === "torn-tail" && summary.result === "INCOMPLETE") {
    return { kind: "warn", head: `Incomplete: the final record is cut short`, body: [
      `Records 0 to ${n(scan.records - 1)} pass every check. The last ${n(scan.size - scan.goodBytes)} bytes are an unfinished record, which is what a crash while writing leaves. fseal recover trims only that record.`,
    ] };
  }
  if (scan.status !== "ok") {
    const what = {
      "bad-crc": `the checksum of record ${n(p.record)} does not match its bytes: they were changed or damaged`,
      "bad-seq": `record ${n(p.record)} has sequence number ${p.actual}, not ${p.expected}: a record was deleted, reordered or duplicated`,
      "bad-link": `the contents of record ${n(p.record)} changed after sealing: its link does not match the record and the one before it`,
      "bad-length": `record ${n(p.record)} claims a length of ${n(Number(p.actual))} bytes, more than any record can have: the file is corrupt`,
      "torn-tail": `record ${n(p.record)} is cut short, and the receipts expected more`,
    }[scan.status];
    return { kind: "bad", head: `Tampered: the chain breaks at record ${n(p.record)}`, body: [
      `At byte ${n(p.offset)}, ${what}. ${scan.records ? `Records 0 to ${n(scan.records - 1)} are intact.` : "No record before it passed."}`,
      `A hash chain pinpoints the first record where the chain breaks, not every altered record. Records after ${n(p.record)} were not checked and may also have been changed.`,
    ] };
  }
  if (summary.failed > 0) {
    const f = summary.firstFailure;
    const prevOk = check.results.filter((x) => x.result === "ok" && x.count < f.count).reduce((m, x) => (x.count > m ? x.count : m), 0n);
    const body = {
      "head-mismatch": `Every record passes its own checks, but receipt ${f.index}, issued after ${n(f.count)} records, pins a different chain head: the log was rewritten after the receipt was issued. The change is in records ${n(prevOk)} to ${n(f.count - 1n)}, because ${prevOk ? `the receipt after ${n(prevOk)} records still matches` : "no earlier receipt narrows it down"}.`,
      "log-shorter": `Every record passes its own checks, but receipt ${f.index} says ${n(f.count)} records had been written and this log has ${n(scan.records)}: records were removed from the end.`,
      "wrong-key": `Receipt ${f.index} was signed by a different key than the one you entered. Check the key with the operator.`,
      "bad-signature": `Receipt ${f.index} has an invalid signature: the receipt itself was altered.`,
    }[f.result];
    return { kind: "bad", head: `Tampered: receipt ${f.index} does not match the log`, body: [body] };
  }
  if (check && !sigs) {
    return { kind: "warn", head: "Chain intact; receipt signatures not checked", body: [
      `All ${n(scan.records)} records pass, and the counts and head links in all ${summary.receipts} receipts match, but this browser could not check their signatures.`,
    ] };
  }
  if (check) {
    return { kind: "ok", head: "Intact", body: [
      `All ${n(scan.records)} records pass their checksum, sequence and hash-chain checks, and all ${summary.receipts} receipts match the log. ${n(summary.uncovered)} record(s) after the last receipt are not covered by any receipt.`,
    ] };
  }
  return { kind: "warn", head: "Chain intact; no receipts checked", body: [
    `All ${n(scan.records)} records pass their checksum, sequence and hash-chain checks.`,
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
  const facts = [
    ["Log", state.log.name],
    ["Records checked", scan.status === "ok" ? `${n(scan.records)}, all intact` : `${n(scan.records)} intact before the problem`],
    ["Chain head", code(Array.from(scan.head, (b) => b.toString(16).padStart(2, "0")).join(""))],
    ["Time order", `${n(scan.timeReversals)} backward timestamp(s) (counted, not trusted)`],
  ];
  if (check) {
    let t = `${summary.matched} of ${summary.receipts} match`;
    if (summary.unchecked) t += `; ${summary.unchecked} cannot be checked past the first problem`;
    else if (summary.failed === 0) t += `; ${n(summary.uncovered)} record(s) after the last receipt are not covered`;
    facts.push(["Receipts", t]);
  }
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
  } else if (summary.firstFailure && summary.firstFailure.result === "head-mismatch") {
    const f = summary.firstFailure;
    box.replaceChildren(pair(`Receipt ${f.index}, after ${n(f.count)} records`, f.receiptHead, f.logHead, "Head link in the receipt (signed when it was issued)", `Link of record ${n(f.count - 1n)} in this log`));
  } else if (p && p.detail) {
    box.replaceChildren(el("div", { class: "compare" }, el("h3", { text: `First problem: record ${n(p.record)}, byte ${n(p.offset)} [${p.token}]` }), el("p", { text: p.detail })));
  } else box.replaceChildren();
}

function renderNotes(r) {
  const out = [];
  const note = (kind, text) => out.push(el("p", { class: `note ${kind}` }, icon(kind), el("span", { text })));
  if (r.receiptError) note("warn", r.receiptError);
  if (!r.receiptsLoaded) note("warn", "No receipts loaded. Truncation of the tail (records deleted from the end) is only caught with receipts, and so is a log its holder rebuilt with every link recomputed. Load the receipts and the public key to check for both.");
  if (r.check && !r.check.signaturesChecked)
    note("warn", "This browser's WebCrypto cannot verify Ed25519 signatures, so the receipt signatures were not checked. The checksums, sequence numbers and hash chain were still verified, and each receipt's count and head were compared with the log, but a forged receipt would not be detected. Use a current version of Chrome, Edge, Firefox or Safari, or the fseal CLI.");
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
      const t = el("span", { class: `tick ${x.result === "ok" ? "ok" : "bad"}` });
      t.style.left = pct(at);
      kids.push(t);
    }
  }
  strip.replaceChildren(...kids);
  const legend = [`Bytes 0 to ${n(scan.goodBytes)} of ${n(scan.size)} verified.`];
  if (scan.goodBytes < scan.size) legend.push(`The rest was not checked.`);
  if (check) legend.push("Marks above the bar are receipts (thin: matches, thick: does not match).");
  $("strip-legend").textContent = legend.join(" ");
  $("strip-wrap").hidden = false;
}

function renderReceipts(r) {
  if (!r.check) return;
  const rows = r.check.results.map((x) => {
    const kind = x.result === "ok" ? "ok" : x.result === "unchecked" ? "warn" : "bad";
    const label = x.result === "unchecked" ? "not checked: past the first problem" : RECEIPT_TEXT[x.result];
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
  $("pg-label").textContent = total ? `Records ${n(start)} to ${n(Math.max(start, end - 1))} of ${n(total)}, page ${n(state.page + 1)} of ${n(pages())}` : "No records";
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
  const btn = el("button", { type: "button", class: "linklike", "aria-label": `Show record ${record}`, onclick: () => { state.selected = record; syncUrl(); renderPage(); showDetail(record); } }, String(record));
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
  const { scan, source } = state.result;
  const rec = await readRecord(source, scan.problem.offset);
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

// ---- events ---------------------------------------------------------------------------------
function wire() {
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
    state.log = null; state.sample = null; $("log-file").value = ""; $("log-name").textContent = ""; $("log-clear").hidden = true;
    syncUrl(); verify(); $("log-file").focus();
  });
  $("rec-clear").addEventListener("click", () => {
    state.receipts = null; state.sample = null; $("rec-file").value = ""; $("rec-name").textContent = ""; $("rec-clear").hidden = true;
    syncUrl(); verify(); $("rec-file").focus();
  });
  for (const b of document.querySelectorAll("[data-sample]")) b.addEventListener("click", () => loadSample(b.dataset.sample));
  $("cancel").addEventListener("click", () => state.abort && state.abort.abort());
  const page = (p) => { state.page = Math.max(0, Math.min(pages() - 1, p)); renderPage(); };
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
const params = new URLSearchParams(location.search);
const sample = ["intact", "tampered", "rewritten", "truncated"].includes(params.get("sample")) ? params.get("sample") : "tampered";
const rec = /^\d{1,15}$/.test(params.get("record") || "") ? Number(params.get("record")) : null;
loadSample(sample, rec);
