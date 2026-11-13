// UI for the FlightSeal verifier. All checking is in verifier.js; this file reads files, renders the screens and
// keeps the screen and the loaded example in the URL hash (#/records/150?sample=tampered) so a view can be shared.
import {
  scanLog, parseReceipts, checkReceipts, summarize, cliReport, blobSource, readRecord, parseHex, ed25519Supported,
  decodeReceipts, PROBLEM_TEXT, RECEIPT_TEXT, MAGIC,
} from "./verifier.js";

const $ = (id) => document.getElementById(id);
const PAGE = 50;
const MAX_RECEIPTS_BYTES = 16 << 20;
const MAX_KEY_FILE_BYTES = 4096;
const MAX_ROWS = 2_000_000; // records kept for the list (about 40 MB); verification itself has no limit
const fmt = new Intl.NumberFormat("en-US");
const n = (x) => fmt.format(x);

// Examples: a log, the receipts a witness kept and the sealer's public key (docs/samples/).
const SAMPLES = {
  intact: { log: "intact.fseal", receipts: "flight.receipts", key: "pubkey.txt" },
  tampered: { log: "tampered.fseal", receipts: "flight.receipts", key: "pubkey.txt" },
  rewritten: { log: "rewritten.fseal", receipts: "flight.receipts", key: "pubkey.txt" },
  truncated: { log: "truncated.fseal", receipts: "flight.receipts", key: "pubkey.txt" },
  px4: { log: "px4-intact.fseal", receipts: "px4-flight.receipts", key: "px4-pubkey.txt" },
  "px4-tampered": { log: "px4-tampered.fseal", receipts: "px4-flight.receipts", key: "px4-pubkey.txt" },
};

// Screens. `back` is where the header's Back link goes on a screen that depends on a run.
const SCREENS = {
  verify: { title: "Verify a file" },
  findings: { title: "Findings", back: "verify" },
  records: { title: "Records", back: "findings", ids: true },
  receipts: { title: "Receipts", back: "findings", ids: true },
  help: { title: "Trust help" },
  examples: { title: "Examples" },
  notfound: { title: "Not found" },
};

const state = {
  log: null, // { blob, name, fromSample }
  receipts: null, // { text, name, fromSample } or { error, name }
  pubkey: "",
  pubkeyFromSample: false,
  sample: null,
  result: null, // { scan, check, summary, source, ... }
  busy: false,
  error: null,
  page: 0,
  selected: null,
  receiptSel: null,
  route: null,
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
const ICONS = { ok: "M3 8.5l3 3 7-7", bad: "M4 4l8 8M12 4l-8 8", warn: "M8 2.5v7M8 12.5v1" };
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

// ---- routing ---------------------------------------------------------------------------------
// #/screen[/id][?sample=name]. Anything else after "#/" is Not found; a hash without "/" is an in-page anchor.
function parseHash(h = location.hash) {
  if (!h || h === "#" || h === "#/") return { screen: "verify", id: null, sample: null };
  if (!h.startsWith("#/")) return null;
  const [path, query] = h.slice(2).split("?");
  const parts = path.split("/").filter(Boolean);
  const q = new URLSearchParams(query || "");
  const sample = Object.hasOwn(SAMPLES, q.get("sample") || "") ? q.get("sample") : null;
  const screen = parts[0] || "verify";
  if (!Object.hasOwn(SCREENS, screen) || screen === "notfound" || parts.length > 2) return { screen: "notfound", id: null, sample: null };
  let id = null;
  if (parts.length === 2) {
    if (!SCREENS[screen].ids || !/^\d{1,15}$/.test(parts[1])) return { screen: "notfound", id: null, sample: null };
    id = Number(parts[1]);
  }
  return { screen, id, sample };
}
function hrefFor(screen, id = null) {
  return `#/${screen}${id != null ? `/${id}` : ""}${state.sample ? `?sample=${state.sample}` : ""}`;
}
function navigate(hash) {
  if (location.hash === hash) onRoute(false);
  else location.hash = hash;
}
// The URL always names the loaded example (or none) for the current screen; replaced, not a new history entry.
function syncUrl() {
  const r = state.route;
  if (!r || r.screen === "notfound") return;
  const want = hrefFor(r.screen, r.id);
  if (location.hash !== want) history.replaceState(history.state, "", want);
}

function onRoute(initial) {
  const r = parseHash();
  if (!r) return; // an in-page anchor
  const prev = state.route;
  const sameScreen = prev && prev.screen === r.screen;
  state.route = r;
  closeMenu(false);
  for (const s of document.querySelectorAll("main .screen")) s.hidden = s.dataset.screen !== r.screen;
  const meta = SCREENS[r.screen];
  document.title = `${meta.title} – FlightSeal`;
  $("crumb").textContent = `FlightSeal / ${meta.title}`;
  for (const a of document.querySelectorAll("#rail .nav-list a")) {
    if (a.getAttribute("href") === `#/${r.screen}`) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const back = $("back");
  back.hidden = !meta.back || (r.screen !== "findings" && r.id == null && !state.result);
  if (meta.back) back.setAttribute("href", hrefFor(r.id != null ? r.screen : meta.back));

  if (r.screen === "records" && r.id != null) state.selected = r.id;
  if (r.screen === "receipts") state.receiptSel = r.id;
  if (r.sample && r.sample !== state.sample) {
    loadSample(r.sample);
  } else {
    syncUrl();
    if (state.result) {
      if (r.screen === "records") r.id != null ? goToRecord(r.id, true) : renderPage();
      if (r.screen === "receipts") renderReceipts(state.result);
    }
  }
  if (initial) return;
  if (sameScreen && r.screen === "records" && r.id != null) return focusRow(r.id);
  if (sameScreen && r.screen === "receipts" && r.id != null) return focusReceipt(r.id);
  if (!sameScreen) scrollTo(0, 0);
  const h1 = document.querySelector(`.screen[data-screen="${r.screen}"] h1`);
  if (h1) h1.focus({ preventScroll: true });
}

// ---- Menu sheet (below 1000 px) ------------------------------------------------------------------
const sheetMode = () => matchMedia("(max-width: 999px)").matches;
function openMenu() {
  $("rail").classList.add("open");
  $("scrim").hidden = false;
  $("menu-btn").setAttribute("aria-expanded", "true");
  for (const id of ["frame", "skip"]) $(id).inert = true;
  const cur = $("rail").querySelector('a[aria-current="page"]') || $("rail").querySelector("a");
  cur.focus();
}
function closeMenu(returnFocus = true) {
  if (!$("rail").classList.contains("open")) return;
  $("rail").classList.remove("open");
  $("scrim").hidden = true;
  $("menu-btn").setAttribute("aria-expanded", "false");
  for (const id of ["frame", "skip"]) $(id).inert = false;
  if (returnFocus) $("menu-btn").focus();
}
function trapTab(e) {
  if (e.key !== "Tab" || !$("rail").classList.contains("open")) return;
  const items = [...$("rail").querySelectorAll("a[href],button:not([disabled])")].filter((x) => x.offsetParent !== null);
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ---- theme: light unless the visitor chose dark ---------------------------------------------------
function setTheme(dark) {
  if (dark) document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  $("theme-toggle").setAttribute("aria-pressed", String(dark));
  try { localStorage.setItem("flightseal-theme", dark ? "dark" : "light"); } catch { /* storage blocked */ }
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
  $("log-error").textContent = "";
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
  state.receiptSel = null;
  state.page = 0;
  syncUrl();
  verify();
}

async function loadSample(name) {
  const def = SAMPLES[name];
  const run = ++state.run;
  if (state.abort) state.abort.abort();
  state.sample = name;
  state.busy = true;
  state.error = null;
  state.result = null;
  clearResult();
  renderStates();
  syncUrl();
  const get = async (p) => {
    const r = await fetch(`samples/${p}`);
    if (!r.ok) throw new Error(`could not load samples/${p} (HTTP ${r.status})`);
    return r.blob();
  };
  try {
    const [log, rec, key] = await Promise.all([get(def.log), get(def.receipts), get(def.key)]);
    if (run !== state.run) return;
    await setLog(log, `${def.log} (sample)`, true);
    await setReceipts(rec, `${def.receipts} (sample)`, true);
    setKey(await key.text(), true);
    $("log-file").value = "";
    $("rec-file").value = "";
    state.page = 0;
    await verify();
  } catch (e) {
    if (run !== state.run) return;
    state.busy = false;
    showError(`Could not load the ${name} sample: ${e.message || e}. Check your connection and reload, or choose your own files.`);
  }
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
  state.error = message;
  $("verdict-line").replaceChildren(icon("warn"), el("span", { text: message }));
  $("verdict-line").className = "verdict-line warn";
  $("verdict").className = "verdict warn";
  renderStates();
}

async function verify() {
  const run = ++state.run;
  if (state.abort) state.abort.abort();
  clearResult();
  state.error = null;
  if (!state.log) {
    state.busy = false;
    renderStates();
    return;
  }
  state.busy = true;
  renderStates();
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
  $("progress-label").textContent = `Verifying ${state.log.name}`;
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
    if (run === state.run && receipts && key) $("progress-label").textContent = `Checking ${n(receipts.length)} receipt signatures`;
    const check = receipts && key ? await checkReceipts(receipts, key, scan, abort.signal) : null;
    if (run !== state.run) return;
    if (abort.signal.aborted) throw new DOMException("verification cancelled", "AbortError"); // never a verdict after Cancel
    const summary = summarize(scan, check);
    state.busy = false;
    state.result = { scan, check, summary, source, receiptError, emptyReceipts };
    render();
  } catch (e) {
    if (run !== state.run) return;
    state.busy = false;
    showError(e.name === "AbortError" ? "Verification cancelled." : `Could not check this file: ${e.message || e}`);
  } finally {
    if (run === state.run) $("progress-wrap").hidden = true;
  }
}

function clearResult() {
  state.result = null;
  for (const id of ["verdict-detail", "facts", "break", "notes", "rec-body", "receipts-body", "chain-summary", "chain-legend", "next-actions", "next-text"]) $(id).replaceChildren();
  $("verdict-line").replaceChildren();
  $("verdict-line").className = "verdict-line";
  $("records-area").hidden = true;
  $("receipts-area").hidden = true;
  $("report-wrap").hidden = true;
  $("detail-h").textContent = "Record";
  $("detail").replaceChildren(el("p", { class: "muted", text: "Choose a record to see its fields." }));
  $("receipt-detail-h").textContent = "Receipt";
  $("receipt-detail").replaceChildren(el("p", { class: "muted", text: "Choose a receipt to compare it with the log." }));
}

// Empty, loading and error states for Findings, Records and Receipts, and the status card on Verify.
function renderStates() {
  const r = state.result;
  const name = state.log ? state.log.name : state.sample ? `the ${state.sample} example` : "";
  for (const box of document.querySelectorAll("[data-empty]")) {
    const screen = box.closest(".screen").dataset.screen;
    let kids = null;
    if (state.busy) kids = [el("p", { text: `Checking ${name}…` }), el("p", { class: "muted", text: "This screen fills in when the check finishes. Cancel stops it." })];
    else if (!r && state.error && screen !== "findings") kids = [el("p", { text: `The last check did not finish: ${state.error}` }), el("a", { class: "btn primary", href: "#/verify", text: "Verify a file" })];
    else if (!r && !state.error) kids = [
      el("p", { text: state.log ? "The chosen log has not been checked yet." : "No file has been verified yet. Verify a sealed log, or load an example, to see its findings, records and receipts here." }),
      el("div", { class: "actions" }, el("a", { class: "btn primary", href: "#/verify", text: "Verify a file" }), el("a", { href: "#/examples", text: "Open an example" })),
    ];
    if (kids) box.replaceChildren(...kids);
    else box.replaceChildren();
  }
  $("findings-body").hidden = !(r || (state.error && !state.busy));
  $("findings-cols").hidden = $("chain-panel").hidden = !r;
  $("findings-sub").textContent = r ? `${state.log.name}, ${n(r.scan.size)} bytes, checked in this browser. Nothing was uploaded.` : "Verdict, coverage and where to look first.";
  // Verify's status card.
  const st = $("run-status");
  if (state.busy) st.replaceChildren(el("p", { text: `Checking ${name}…` }));
  else if (r) {
    const v = verdictFor(r);
    st.replaceChildren(el("p", { class: `run-head ${v.kind}` }, icon(v.kind), el("span", { text: v.head })), el("p", { class: "muted", text: `${state.log.name}. Show findings for coverage and where to look first.` }));
  } else if (state.error) st.replaceChildren(el("p", { class: "run-head warn" }, icon("warn"), el("span", { text: state.error })));
  else st.replaceChildren(el("p", { text: state.log ? "Not checked yet." : "No file checked yet." }));
  const back = $("back");
  if (state.route && SCREENS[state.route.screen].back) back.hidden = state.route.screen !== "findings" && state.route.id == null && !r;
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
    const f = firstFailure(r);
    const prevOk = coverEnd(r);
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
function firstFailure(r) {
  return lowestCount(r.check.results.filter((x) => x.result === "head-mismatch" || x.result === "log-shorter"));
}
// Records 0..coverEnd-1 are pinned by an authenticated receipt that matches, below any receipt that does not.
function coverEnd(r) {
  const { check, summary, scan } = r;
  if (!check || !summary.authenticated) return 0n;
  let end = summary.covered;
  if (summary.failed > 0) {
    const f = firstFailure(r);
    end = check.results.filter((x) => x.result === "ok" && x.count < f.count).reduce((m, x) => (x.count > m ? x.count : m), 0n);
  }
  const max = BigInt(scan.records);
  return end > max ? max : end;
}

// What a receipt says about the log, in words, and its status kind.
function receiptLabel(x, authenticated) {
  let kind = x.result === "ok" ? "ok" : x.result === "unchecked" || x.result === "wrong-key" || x.result === "bad-signature" ? "warn" : "bad";
  let label = x.result === "unchecked" ? "not checked: past the first problem" : RECEIPT_TEXT[x.result];
  if (x.result === "wrong-key" || x.result === "bad-signature") label = `${RECEIPT_TEXT[x.result].split(" (")[0]}: not evidence either way`;
  if (!authenticated && x.result !== "unchecked") {
    kind = "warn";
    label = x.result === "ok" ? "agrees with the log, but not authenticated" : `disagrees with the log, but not authenticated (${RECEIPT_TEXT[x.result].split(" (")[0]})`;
  }
  return { kind, label };
}

// One next action per verdict, and the heading over the facts that support it.
function nextStep(r) {
  const { scan, summary, check } = r;
  const p = scan.problem;
  if (scan.status === "bad-header") return { h: "Check the file", text: "This file is not a FlightSeal log. Choose the .fseal file that the logger wrote.", href: "#/verify", label: "Verify another file" };
  if (p && scan.status !== "torn-tail") return { h: "Start at the first break", text: "Inspect the earliest failed link before reading later records.", href: hrefFor("records", p.record), label: `Inspect record ${n(p.record)}`, secondary: check ? [hrefFor("receipts"), "Review receipts"] : null };
  if (check && summary.authenticated && summary.failed > 0) {
    const f = firstFailure(r);
    return { h: "Start at the first receipt that does not match", text: `Something changed in the records before receipt ${f.index}, after the last receipt that still matches. A receipt cannot say which record.`, href: hrefFor("receipts", f.index), label: `Review receipt ${f.index}`, secondary: [hrefFor("records", Number(coverEnd(r))) , "Show the records it covers"] };
  }
  if (check && (!summary.authenticated || summary.untrusted > 0)) return { h: "Check the key and the receipts", text: "The receipts are not evidence for the key you entered. Confirm the key with the operator, or ask the witness for the receipts they kept.", href: hrefFor("receipts"), label: "Review receipts" };
  if (p) return { h: "Start at the cut-short record", text: "A crash while writing leaves the last record cut short. fseal recover trims only that record.", href: hrefFor("records", p.record), label: `Inspect record ${n(p.record)}` };
  if (!check) return { h: "Add receipts to check for truncation", text: "The chain is self-consistent. Only receipts a witness kept can show that the end was not removed or the log rebuilt.", href: "#/verify", label: "Add receipts and a key", secondary: [hrefFor("records"), "Browse records"] };
  return { h: "What the receipts cover", text: summary.uncovered > 0n ? "Records after the last receipt are not protected; read them with that in mind." : "Every record is covered by a receipt signed by the key you trust.", href: hrefFor("records", summary.uncovered > 0n ? Number(summary.covered) : 0), label: summary.uncovered > 0n ? `Inspect the first uncovered record` : "Browse records" };
}

function render() {
  const r = state.result;
  const { scan, check, summary } = r;
  const v = verdictFor(r);
  const line = $("verdict-line");
  line.className = `verdict-line ${v.kind}`;
  line.replaceChildren(icon(v.kind), el("span", { text: v.head }));
  $("verdict").className = `verdict ${v.kind}`;
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

  const next = nextStep(r);
  $("next-h").textContent = next.h;
  $("next-text").textContent = next.text;
  $("next-actions").replaceChildren(
    el("a", { class: "btn primary", href: next.href, text: next.label }),
    next.secondary ? el("a", { href: next.secondary[0], text: next.secondary[1] }) : null,
  );

  renderBreak(r);
  renderNotes(r);
  renderChainSummary(r);
  renderReceipts(r);

  $("report").textContent = cliReport(state.log.name, scan, check);
  $("report-wrap").hidden = false;

  $("show-break").hidden = !scan.problem || scan.status === "bad-header";
  renderStates();
  const want = state.selected != null ? state.selected : scan.problem ? scan.problem.record : 0;
  goToRecord(want, state.selected != null || !!scan.problem);
  syncUrl();
}

function renderBreak(r) {
  const { scan, summary } = r;
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
  } else if (summary.authenticated && summary.failed > 0 && firstFailure(r).result === "head-mismatch") {
    const f = firstFailure(r);
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
  if (r.scan.rowsTruncated) note("warn", `Only the first ${n(MAX_ROWS)} records are listed; all ${n(r.scan.records)} were verified.`);
  $("notes").replaceChildren(...out);
}

// ---- the evidence chain ------------------------------------------------------------------------
// Byte range of record i (0-based, inclusive end), when it is in the listed rows.
function bytesOf(scan, i) {
  if (i >= scan.rows.count) return null;
  const a = scan.rows.offset[i];
  return [a, a + 56 + scan.rows.len[i] - 1];
}
const byteText = (b) => (b ? `bytes ${n(b[0])} to ${n(b[1])}` : "");

// Receipts sorted by where they attach: after record count-1.
function pinsByCount(r) {
  const map = new Map();
  if (!r.check) return map;
  for (const x of r.check.results) {
    const k = x.count.toString();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return map;
}
function pinItem(x, r) {
  const { kind, label } = receiptLabel(x, r.summary.authenticated);
  return el("li", { class: `pin pin-${kind}` },
    el("span", { class: "pin-tag" },
      el("a", { class: "pin-link", href: hrefFor("receipts", x.index), text: `Receipt ${x.index}` }),
      el("span", { text: `after ${plural(x.count, "record")}:` }),
      el("span", { class: `label ${kind}` }, icon(kind), el("span", { text: label }))));
}
// Receipts past the end of what was checked: one link per run of receipts with the same result.
function pushBeyond(items, pins, r) {
  const beyond = [...pins].filter(([k]) => BigInt(k) > BigInt(r.scan.records)).flatMap(([, list]) => list).sort((a, b) => a.index - b.index);
  for (let i = 0; i < beyond.length;) {
    let j = i;
    const lab = receiptLabel(beyond[i], r.summary.authenticated).label;
    while (j + 1 < beyond.length && beyond[j + 1].index === beyond[j].index + 1 && receiptLabel(beyond[j + 1], r.summary.authenticated).label === lab) j++;
    items.push(j === i ? pinItem(beyond[i], r) : pinGroup(beyond.slice(i, j + 1), r));
    i = j + 1;
  }
}
function pinGroup(list, r) {
  const { kind, label } = receiptLabel(list[0], r.summary.authenticated);
  const a = list[0], b = list[list.length - 1];
  return el("li", { class: `pin pin-${kind}` },
    el("span", { class: "pin-tag" },
      el("a", { class: "pin-link", href: hrefFor("receipts", a.index), text: `Receipts ${a.index} to ${b.index}` }),
      el("span", { text: `after ${n(a.count)} to ${n(b.count)} records:` }),
      el("span", { class: `label ${kind}` }, icon(kind), el("span", { text: label }))));
}
function boundaryItem(text) {
  return el("li", { class: "boundary" }, el("span", { class: "boundary-line", text }));
}
function boundaryText(r, end) {
  const { scan, summary } = r;
  if (!r.check) return "No receipts: no record is covered. Truncation and rebuilding cannot be ruled out.";
  if (!summary.authenticated) return "No record is covered: the receipts are not authenticated in this browser.";
  if (end === 0n) return summary.untrusted ? "No record is covered: no receipt is validly signed by the key you trust." : "No record is covered by a receipt that matches.";
  const after = summary.failed > 0 ? `Below this line receipt ${firstFailure(r).index} does not match.` : scan.problem ? "Below this line nothing is covered." : `Below this line ${plural(BigInt(scan.records) - end, "record")} ${BigInt(scan.records) - end === 1n ? "is" : "are"} not covered by any receipt.`;
  return `Covered prefix ends after record ${n(end - 1n)}. ${after}`;
}

// Findings: the whole log as a few links (record ranges between receipts), the break and the boundary.
function renderChainSummary(r) {
  const { scan } = r;
  const items = [];
  if (scan.status === "bad-header") {
    $("chain-legend").textContent = "The file is not a FlightSeal log, so there is no chain to draw.";
    $("chain-summary").replaceChildren();
    return;
  }
  const end = coverEnd(r);
  const pins = pinsByCount(r);
  const counts = [...pins.keys()].map(BigInt).filter((c) => c > 0n && c <= BigInt(scan.records)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const range = (from, to) => {
    const covered = BigInt(to) < end;
    const a = bytesOf(scan, from), b = bytesOf(scan, to);
    const kind = covered ? "link-ok" : "link-uncovered";
    const status = covered ? "pass every check; covered by a matching receipt" : "pass every check; not covered by a receipt";
    items.push(el("li", { class: kind },
      el("div", { class: "link-main" },
        el("a", { class: "link-title", href: hrefFor("records", from), text: from === to ? `Record ${n(from)}` : `Records ${n(from)} to ${n(to)}` }),
        el("span", { class: "link-status", text: status })),
      a && b ? el("p", { class: "link-meta", text: `bytes ${n(a[0])} to ${n(b[1])}` }) : null));
  };
  let prev = 0;
  if (end === 0n) items.push(boundaryItem(boundaryText(r, end)));
  for (const c of counts) {
    const ci = Number(c);
    if (ci > prev) range(prev, ci - 1);
    for (const x of pins.get(c.toString())) items.push(pinItem(x, r));
    if (c === end && end > 0n) items.push(boundaryItem(boundaryText(r, end)));
    prev = ci;
  }
  if (prev < scan.records) range(prev, scan.records - 1);
  if (end > 0n && !counts.includes(end)) items.push(boundaryItem(boundaryText(r, end)));
  const p = scan.problem;
  if (p) {
    items.push(el("li", { class: "link-bad", "data-break": String(p.record) },
      el("div", { class: "link-main" },
        el("a", { class: "link-title", href: hrefFor("records", p.record), text: `Record ${n(p.record)}` }),
        el("span", { class: "link-status", text: scan.status === "torn-tail" ? "cut short here" : `chain breaks here [${p.token}]` })),
      el("p", { class: "link-meta", text: `starts at byte ${n(p.offset)}` })));
    const rest = scan.size - scan.goodBytes;
    if (rest > 0 && scan.status !== "torn-tail") items.push(el("li", { class: "link-unchecked" },
      el("div", { class: "link-main" }, el("span", { class: "link-title", text: `After record ${n(p.record)}` }), el("span", { class: "link-status", text: "not checked" })),
      el("p", { class: "link-meta", text: `${n(rest)} bytes from byte ${n(scan.goodBytes)} to the end of the file` })));
  }
  pushBeyond(items, pins, r);
  for (const [k, list] of pins) if (k === "0") for (const x of list) items.unshift(pinItem(x, r));
  $("chain-summary").replaceChildren(...items);
  const legend = [`Read from the top: each link is a run of records, filled dots pass and are covered by a receipt, hollow dots pass but no receipt covers them.`];
  if (p) legend.push(`The diamond marks the first break; nothing after it was checked.`);
  if (r.check) legend.push(r.summary.authenticated ? "Squares are receipts, attached after the record they pin." : "Squares are receipts that could not be authenticated.");
  if (r.check && r.summary.untrusted) legend.push("Receipts not validly signed by your key are not checked against your key and prove nothing either way.");
  legend.push("The dashed line is the end of the covered prefix.");
  $("chain-legend").textContent = legend.join(" ");
}

function renderReceipts(r) {
  const has = !!r.check;
  $("receipts-area").hidden = false;
  $("receipts-split").hidden = !has;
  $("receipts-none").hidden = has;
  if (!has) {
    $("receipts-none").replaceChildren(icon("warn"), el("span", {}, `No receipts were checked for ${state.log.name}${r.receiptError ? `: ${r.receiptError}` : "."} `, el("a", { href: "#/verify", text: "Add receipts and the key you trust" })));
    $("receipts-body").replaceChildren();
    return;
  }
  const authenticated = r.summary.authenticated;
  const rows = r.check.results.map((x) => {
    const { kind, label } = receiptLabel(x, authenticated);
    const sig = x.result === "unchecked" || x.result === "wrong-key" ? "not checked" : x.sigChecked ? (x.result === "bad-signature" ? "invalid" : "valid") : "not checked (no Ed25519 in this browser)";
    const selected = state.receiptSel === x.index;
    return el("tr", { class: [kind === "bad" ? "row-bad" : "", selected ? "selected" : ""].join(" ").trim() || null, "aria-current": selected ? "true" : null, "data-receipt": String(x.index) },
      el("td", {}, el("a", { class: "pin-link", href: hrefFor("receipts", x.index), "aria-label": `Show receipt ${x.index}`, text: String(x.index) })),
      el("td", { text: n(x.count) }),
      el("td", {}, el("span", { class: `label ${kind}` }, icon(kind), el("span", { text: label }))),
      el("td", { text: sig }),
      el("td", {}, code(x.receiptHead)));
  });
  $("receipts-body").replaceChildren(...rows);
  const x = r.check.results.find((y) => y.index === state.receiptSel);
  if (!x) return;
  const { kind, label } = receiptLabel(x, authenticated);
  $("receipt-detail-h").textContent = `Receipt ${x.index}`;
  const items = [
    ["Pins", `the chain head after ${plural(x.count, "record")}`],
    ["Result", el("span", { class: `label ${kind}` }, icon(kind), el("span", { text: label }))],
    ["Signature", x.sigChecked ? (x.result === "bad-signature" ? "invalid" : "valid for the key you trust") : "not checked"],
    ["Head link in the receipt", code(x.receiptHead)],
    ["Link in this log", x.logHead ? code(x.logHead) : "not available: the log does not reach this record, or the receipt was not checked against it"],
  ];
  $("receipt-detail").replaceChildren(
    el("dl", { class: "kv" }, ...items.flatMap(([k, val]) => [el("dt", { text: k }), el("dd", {}, val)])),
    x.count > 0n && x.count <= BigInt(r.scan.records) ? el("p", {}, el("a", { href: hrefFor("records", Number(x.count - 1n)), text: `Show record ${n(x.count - 1n)} on the chain` })) : null,
  );
}

// ---- records: the chain, one link per record ------------------------------------------------------
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
  else if (idx == null) $("rec-note").textContent = `Record ${n(record)} is not in the verified part of this log.`;
}

function renderPage() {
  const r = state.result;
  const { scan } = r;
  $("records-area").hidden = false;
  const total = totalRows();
  const start = state.page * PAGE, end = Math.min(total, start + PAGE);
  const cover = coverEnd(r);
  const pins = pinsByCount(r);
  const items = [];
  if (start === 0 && cover === 0n && scan.status !== "bad-header") items.push(boundaryItem(boundaryText(r, cover)));
  for (let i = start; i < end; i++) {
    if (i < scan.rows.count) {
      items.push(recordItem(i, cover));
      for (const x of pins.get(String(i + 1)) || []) items.push(pinItem(x, r));
      if (cover > 0n && BigInt(i + 1) === cover && (cover < BigInt(scan.records) || scan.problem || r.summary.failed)) items.push(boundaryItem(boundaryText(r, cover)));
    } else {
      const p = scan.problem;
      items.push(problemItem(p));
      const rest = scan.size - scan.goodBytes;
      if (rest > 0 && scan.status !== "torn-tail") items.push(el("li", { class: "link-unchecked" },
        el("div", { class: "link-main" }, el("span", { class: "link-title", text: `After record ${n(p.record)}` }), el("span", { class: "link-status", text: "not checked" })),
        el("p", { class: "link-meta", text: `${n(rest)} bytes from byte ${n(scan.goodBytes)} to the end of the file` })));
    }
  }
  if (end === total) pushBeyond(items, pins, r);
  $("rec-body").replaceChildren(...items);
  if (scan.problem && scan.status !== "bad-header" && end === total) fillProblemRow();
  // After a break the list holds the records checked, not the whole log, so the count says so.
  const range = end - start === 1 ? `Record ${n(start)}` : `Records ${n(start)} to ${n(end - 1)}`;
  const of = scan.problem && scan.status !== "bad-header"
    ? `${n(total)} checked (verification stopped at record ${n(scan.problem.record)})`
    : n(total);
  $("pg-label").textContent = total ? `${range} of ${of}, page ${n(state.page + 1)} of ${n(pages())}` : "No records";
  $("pg-first").disabled = $("pg-prev").disabled = state.page === 0;
  $("pg-next").disabled = $("pg-last").disabled = state.page >= pages() - 1;
  const notChecked = scan.size - scan.goodBytes;
  $("rec-note").textContent = scan.problem
    ? `Verification stopped at record ${n(scan.problem.record)}. The ${n(notChecked)} bytes from there to the end of the file were not checked.`
    : `${n(scan.records)} records, every one checked.`;
}

function recordButton(record) {
  return el("button", { type: "button", class: "linklike", "aria-label": `Show record ${record}`, onclick: () => navigate(hrefFor("records", record)) }, `Record ${record}`);
}
function recordItem(i, cover) {
  const { scan } = state.result;
  const covered = BigInt(i) < cover;
  const selected = state.selected === i;
  return el("li", { class: `${covered ? "link-ok" : "link-uncovered"}${selected ? " selected" : ""}`, "aria-current": selected ? "true" : null, "data-record": String(i) },
    el("div", { class: "link-main" }, recordButton(i),
      el("span", { class: "link-status", text: covered ? "passes; covered by a receipt" : "passes; not covered by a receipt" })),
    el("p", { class: "link-meta" },
      el("span", { text: `${byteText(bytesOf(scan, i))}, seq ` }), el("span", { class: "mono", text: String(i) }),
      el("span", { text: ", t " }), el("span", { class: "mono", text: `${scan.rows.ts[i].toString()} µs` })));
}
function problemItem(p) {
  const selected = state.selected === p.record;
  const torn = p.token === "torn-tail";
  return el("li", { class: `link-bad${selected ? " selected" : ""}`, "aria-current": selected ? "true" : null, "data-record": String(p.record), "data-break": "true" },
    el("div", { class: "link-main" }, recordButton(p.record),
      el("span", { class: "link-status" }, icon("bad"), el("span", { text: torn ? " cut short here" : p.token === "bad-link" ? " chain breaks here" : ` ${PROBLEM_TEXT[p.token].split(" (")[0]}` }))),
    el("p", { class: "link-meta" }, el("span", { text: `starts at byte ${n(p.offset)}` }), el("span", { class: "problem-fields" })));
}

async function fillProblemRow() {
  const result = state.result;
  const { scan, source } = result;
  const rec = await readRecord(source, scan.problem.offset);
  if (result !== state.result) return; // another log or run replaced this one while reading
  const span = document.querySelector(`#rec-body li[data-break] .problem-fields`);
  if (!rec || !span) return;
  span.textContent = `, ${n(rec.length)} payload bytes, seq ${rec.seq == null ? "missing" : rec.seq.toString()}, t ${rec.ts == null ? "missing" : `${rec.ts.toString()} µs`}`;
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
  const cover = coverEnd(result);
  const items = [
    ["Check", isBroken ? `${PROBLEM_TEXT[scan.problem.token]} [${scan.problem.token}]` : "passes checksum, sequence and link"],
    ["Receipt coverage", isBroken ? "not covered" : BigInt(record) < cover ? `covered (records 0 to ${n(cover - 1n)} are pinned by a matching receipt)` : "not covered by a receipt"],
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
    clearLog(); state.sample = null; state.selected = null;
    syncUrl(); verify(); $("log-choose").focus();
  });
  $("rec-clear").addEventListener("click", () => {
    clearReceipts(); state.sample = null;
    syncUrl(); verify(); $("rec-choose").focus();
  });
  $("show-findings").addEventListener("click", () => {
    if (!state.log && !state.busy) {
      $("log-error").textContent = "Choose a sealed log first, or open an example.";
      $("log-choose").focus();
      return;
    }
    navigate(hrefFor("findings"));
  });
  for (const b of document.querySelectorAll("[data-sample]")) b.addEventListener("click", () => {
    const name = b.dataset.sample;
    state.selected = null;
    state.receiptSel = null;
    if (name === state.sample && (state.result || state.busy)) return navigate(hrefFor("findings"));
    navigate(`#/findings?sample=${name}`);
  });
  $("cancel").addEventListener("click", () => state.abort && state.abort.abort());
  // Changing page re-renders the list; if the button that was used is now disabled (first or last page), keep
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
    navigate(hrefFor("records", v));
  });
  $("show-break").addEventListener("click", () => {
    const p = state.result && state.result.scan.problem;
    if (p) navigate(hrefFor("records", p.record));
  });
  $("copy-report").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("report").textContent);
      $("copy-status").textContent = "Copied.";
    } catch {
      $("copy-status").textContent = "Copy is blocked here; select the text above instead.";
    }
  });
  // Skip link: focus the current screen's H1 without changing the route.
  $("skip").addEventListener("click", (e) => {
    e.preventDefault();
    const h1 = document.querySelector("main .screen:not([hidden]) h1");
    if (h1) h1.focus();
  });
  $("menu-btn").addEventListener("click", openMenu);
  $("menu-close").addEventListener("click", () => closeMenu(true));
  $("scrim").addEventListener("click", () => closeMenu(true));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("rail").classList.contains("open")) { e.preventDefault(); closeMenu(true); }
    trapTab(e);
  });
  matchMedia("(max-width: 999px)").addEventListener("change", () => { if (!sheetMode()) closeMenu(false); });
  $("theme-toggle").addEventListener("click", () => setTheme($("theme-toggle").getAttribute("aria-pressed") !== "true"));
  addEventListener("hashchange", () => onRoute(false));
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
  const b = document.querySelector(`#rec-body li[data-record="${record}"] button`);
  if (b) b.focus();
}
function focusReceipt(index) {
  const a = document.querySelector(`#receipts-body tr[data-receipt="${index}"] a`);
  if (a) a.focus();
}

wire();
$("theme-toggle").setAttribute("aria-pressed", String(document.documentElement.getAttribute("data-theme") === "dark"));
ed25519Supported(); // start the probe early
// Offline use after one visit (sw.js). Scope is this folder; a failure only means no offline copy.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
// Old shared links (?sample=name&record=N, before the screens had their own addresses) open the same view.
const old = new URLSearchParams(location.search);
if (old.has("sample") && Object.hasOwn(SAMPLES, old.get("sample"))) {
  const rec = /^\d{1,15}$/.test(old.get("record") || "") ? Number(old.get("record")) : null;
  history.replaceState(null, "", `${location.pathname}${rec != null ? `#/records/${rec}` : "#/findings"}?sample=${old.get("sample")}`);
} else if (location.search) history.replaceState(null, "", location.pathname + location.hash);
renderStates();
onRoute(true);
