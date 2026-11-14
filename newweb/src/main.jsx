import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { verifyFile, sealFile, SEAL_MAX_BYTES } from '../../docs/wasm/client.mjs';
import { blobSource, checkReceipts, crc32, HEADER, parseHex, parseReceipts, readRecord, scanLog, summarize } from '../../docs/verifier.js';
import './style.css';

const MAX_UI_BYTES = 64 * 1024 * 1024;
const PAGE_SIZE = 50;
const NAV = [
  ['sandbox', 'Sandbox', '01'], ['verify', 'Verify', '02'], ['records', 'Records', '03'],
  ['receipts', 'Receipts', '04'], ['video', 'Video', '05'], ['help', 'Trust help', '06'],
];
const asBig = (value) => typeof value === 'bigint' ? value : BigInt(value ?? 0);
const fmtBig = (value) => new Intl.NumberFormat('en-US').format(asBig(value));
const fmtBytes = (value) => {
  const n = Number(value);
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
};
const humanStatus = (status) => ({
  intact: ['Intact', 'ok'], 'bad-link': ['Hash chain break', 'bad'], 'bad-crc': ['Checksum mismatch', 'bad'],
  'bad-seq': ['Sequence break', 'bad'], 'bad-length': ['Invalid record length', 'bad'],
  'bad-header': ['Not a FlightSeal log', 'bad'], 'torn-tail': ['Torn final record', 'warn'],
  incomplete: ['Incomplete', 'warn'], tampered: ['Tampered', 'bad'], unverified: ['Unverified', 'warn'],
}[status] || [String(status || 'Unknown'), 'warn']);
const titleFor = (screen) => NAV.find(([key]) => key === screen)?.[1] || 'Not found';

function download(name, content, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function App() {
  const [screen, setScreen] = useState(() => location.hash.slice(2).split(/[/?]/)[0] || 'sandbox');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [logFile, setLogFile] = useState(null);
  const [receiptText, setReceiptText] = useState('');
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [keyText, setKeyText] = useState('');
  const [selectedRecord, setSelectedRecord] = useState(0);
  const [recordDetail, setRecordDetail] = useState(null);
  const [recordError, setRecordError] = useState('');
  const [page, setPage] = useState(0);
  const [sealFileInput, setSealFileInput] = useState(null);
  const [sealInterval, setSealInterval] = useState(1000);
  const [sealOutput, setSealOutput] = useState(null);
  const [videoInfo, setVideoInfo] = useState(null);
  const [demoLabel, setDemoLabel] = useState('');
  const [operationStatus, setOperationStatus] = useState('');
  const [offlineStatus, setOfflineStatus] = useState('');
  const [mobileMenu, setMobileMenu] = useState(false);
  const runRef = useRef(0);
  const controllerRef = useRef(null);
  const recordRef = useRef(0);
  const receiptReadRef = useRef(0);
  const videoRef = useRef(null);
  const videoUrlRef = useRef(null);
  const teamDialogRef = useRef(null);
  const focusedRouteRef = useRef(null);

  const navigate = useCallback((next) => {
    const route = NAV.some(([key]) => key === next) ? next : 'help';
    location.hash = `/${route}`;
    setScreen(route);
    setMobileMenu(false);
    setError('');
  }, []);

  useEffect(() => {
    const onShortcut = (event) => {
      if (teamDialogRef.current?.open || event.defaultPrevented || event.isComposing || !event.altKey || !event.shiftKey ||
          event.ctrlKey || event.metaKey || event.getModifierState('AltGraph')) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const match = /^Digit([1-6])$/.exec(event.code);
      if (!match) return;
      event.preventDefault();
      navigate(NAV[Number(match[1]) - 1][0]);
    };
    addEventListener('keydown', onShortcut);
    return () => removeEventListener('keydown', onShortcut);
  }, [navigate]);

  useEffect(() => {
    const update = () => {
      const next = location.hash.slice(2).split(/[/?]/)[0] || 'sandbox';
      setScreen(NAV.some(([key]) => key === next) ? next : 'help');
      setMobileMenu(false);
    };
    addEventListener('hashchange', update);
    return () => removeEventListener('hashchange', update);
  }, []);

  useEffect(() => {
    document.title = `${titleFor(screen)} · FlightSeal Console`;
    if (focusedRouteRef.current !== null && focusedRouteRef.current !== screen) {
      requestAnimationFrame(() => document.getElementById(`page-${screen}`)?.focus());
    }
    focusedRouteRef.current = screen;
  }, [screen]);

  useEffect(() => {
    if (!mobileMenu) return undefined;
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape' || teamDialogRef.current?.open) return;
      setMobileMenu(false);
      requestAnimationFrame(() => document.querySelector('.menu-toggle')?.focus());
    };
    addEventListener('keydown', closeOnEscape);
    return () => removeEventListener('keydown', closeOnEscape);
  }, [mobileMenu]);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) {
      setOfflineStatus('Offline caching is available in the built preview. Live development stays online.');
      return;
    }
    if (!('serviceWorker' in navigator)) {
      setOfflineStatus('Offline caching is unavailable in this browser. Files loaded during this visit can still be checked.');
      return;
    }
    let active = true;
    const onWorkerMessage = ({ data }) => {
      if (data?.type === 'flightseal-cache-warning') setOfflineStatus('Offline copies could not be saved. Keep this page online or use the CLI.');
    };
    navigator.serviceWorker.addEventListener('message', onWorkerMessage);
    navigator.serviceWorker.register('/flightseal/sw.js', { scope: '/flightseal/' })
      .then(() => { if (active) setOfflineStatus('Offline worker registered. Visit once online before relying on offline access.'); })
      .catch(() => { if (active) setOfflineStatus('Offline caching could not be started here. Files loaded during this visit can still be checked.'); });
    return () => { active = false; navigator.serviceWorker.removeEventListener('message', onWorkerMessage); };
  }, []);

  const invalidateCheck = () => {
    runRef.current++;
    controllerRef.current?.abort();
    setBusy(''); setResult(null); setRecordDetail(null); setRecordError('');
    setOperationStatus('');
  };

  const runVerify = useCallback(async (file, receipts = '', trustedKey = '', label = file?.name || 'local file') => {
    if (!file) { invalidateCheck(); setError('Choose a sealed log first.'); return null; }
    if (file.size > MAX_UI_BYTES) { invalidateCheck(); setError('This console accepts files up to 64 MiB. Use the command-line tool for larger files.'); return null; }
    const operation = ++runRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy('Checking the log with C++ / OpenSSL WebAssembly…');
    setError(''); setOperationStatus('');
    setResult(null); setRecordDetail(null); setRecordError('');
    try {
      const parsedReceipts = receipts ? parseReceipts(receipts) : null;
      if (parsedReceipts?.error) throw new Error(`Receipts line ${parsedReceipts.error.line} is not valid.`);
      const needsTrustedKey = !!receipts && !trustedKey.trim();
      const engineReceipts = needsTrustedKey ? '' : receipts;
      const engineKey = needsTrustedKey ? '' : trustedKey;
      const [native, indexed] = await Promise.all([
        verifyFile(file, engineReceipts, engineKey, { signal: controller.signal }),
        scanLog(blobSource(file), { maxRows: 100000, signal: controller.signal, linksAt: parsedReceipts?.receipts.map((receipt) => receipt.count) || [] }),
      ]);
      if (operation !== runRef.current) return null;
      const indexedStatus = native.status === 'intact' ? 'ok' : native.status;
      if (indexedStatus !== indexed.status || asBig(native.records) !== BigInt(indexed.records)) {
        throw new Error('The native result and record index disagree. Do not treat this run as complete.');
      }
      let receiptIndex = null;
      if (receipts && !needsTrustedKey) {
        const trusted = parseHex(trustedKey.trim().toLowerCase(), 32);
        receiptIndex = trusted ? await checkReceipts(parsedReceipts.receipts, trusted, indexed, controller.signal) : null;
      }
      if (operation !== runRef.current) return null;
      const oracle = summarize(indexed, receiptIndex);
      if (!needsTrustedKey && receiptIndex?.signaturesChecked !== false && oracle.result !== native.verdict.toUpperCase()) {
        const checks = receiptIndex?.results?.map((r) => r.result).join(', ') || 'none';
        throw new Error(`The native verdict (${native.verdict}) and browser oracle (${oracle.result}; scan ${indexed.status}; signatures ${receiptIndex?.signaturesChecked}; receipts ${checks}) disagree. Do not treat this run as complete.`);
      }
      if (!needsTrustedKey && receiptIndex?.signaturesChecked && indexed.status === 'ok' && receiptIndex.results.some((receipt, i) => receipt.result !== native.receipts[i]?.check)) {
        throw new Error('The native receipt checks and browser oracle disagree. Do not treat this run as complete.');
      }
      const receiptChecks = needsTrustedKey ? parsedReceipts.receipts.map((receipt) => ({
          count: String(receipt.count), head: Array.from(receipt.head, (byte) => byte.toString(16).padStart(2, '0')).join(''),
          key: Array.from(receipt.key, (byte) => byte.toString(16).padStart(2, '0')).join(''),
          check: 'unverified', description: 'No trusted key entered; signature was not checked',
        })) : native.receipts;
      const overallVerdict = needsTrustedKey && native.verdict === 'intact' ? 'unverified' : native.verdict;
      const completed = {
        native, indexed, receiptIndex, receiptChecks, file, receipts, key: trustedKey, label,
        overallVerdict,
        receiptCoverage: needsTrustedKey ? { covered: '0', uncovered: String(native.records) } : { covered: native.covered, uncovered: native.uncovered },
        needsTrustedKey,
      };
      setResult(completed);
      const initialRecord = indexed.problem?.record ?? Math.max(0, indexed.records - 1);
      const displayRecord = initialRecord < indexed.rows.count + Number(!!indexed.problem) ? initialRecord : Math.max(0, indexed.rows.count - 1);
      setSelectedRecord(displayRecord);
      setPage(Math.floor(displayRecord / PAGE_SIZE));
      setDemoLabel(label);
      setOperationStatus(needsTrustedKey
        ? 'Enter and verify a trusted public key before treating these receipts as evidence.'
        : receiptIndex && !receiptIndex.signaturesChecked
        ? 'Native C++ verified the receipts. This browser cannot check Ed25519 signatures for the separate JavaScript oracle. The file was not uploaded.'
        : 'Verification finished locally. The file and report were not uploaded.');
      return completed;
    } catch (cause) {
      if (operation !== runRef.current || cause?.name === 'AbortError') return null;
      setError(cause?.message || 'Could not verify this file. Choose it again and retry.');
      setOperationStatus('');
      return null;
    } finally {
      if (operation === runRef.current) setBusy('');
    }
  }, []);

  const loadDemo = useCallback(async (sample = false) => {
    const operation = ++runRef.current;
    controllerRef.current?.abort();
    receiptReadRef.current++;
    setReceiptLoading(false);
    const controller = new AbortController(); controllerRef.current = controller;
    const full = sample === 'full';
    const px4 = sample === true;
    const stem = full ? 'px4-full' : px4 ? 'px4-' : '';
    const logName = full ? `${stem}.fseal` : `${stem}intact.fseal`;
    const receiptName = full ? `${stem}.receipts` : `${stem}flight.receipts`;
    const keyName = full ? `${stem}-pubkey.txt` : `${stem}pubkey.txt`;
    const size = full ? 'full PX4 example' : px4 ? '2,422-record PX4 example' : '800-record included demo';
    setBusy(`Loading ${size} from the included sample…`); setError(''); setResult(null); setRecordDetail(null); setRecordError('');
    try {
      const [logResponse, receiptResponse, keyResponse] = await Promise.all([
        fetch(`/flightseal/samples/${logName}`, { signal: controller.signal }),
        fetch(`/flightseal/samples/${receiptName}`, { signal: controller.signal }),
        fetch(`/flightseal/samples/${keyName}`, { signal: controller.signal }),
      ]);
      if (operation !== runRef.current) return;
      if (![logResponse, receiptResponse, keyResponse].every((r) => r.ok)) throw new Error('Included sample files could not be loaded.');
      const [logBlob, receipts, key] = await Promise.all([logResponse.blob(), receiptResponse.text(), keyResponse.text()]);
      if (operation !== runRef.current || controller.signal.aborted) return;
      const file = new File([logBlob], logName, { type: 'application/octet-stream' });
      await runVerify(file, receipts, key, size);
    } catch (cause) {
      if (operation !== runRef.current || cause?.name === 'AbortError') return;
      setBusy(''); setError(cause?.message || 'Could not load the included sample. Reload and retry.');
    }
  }, [runVerify]);

  useEffect(() => { if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/sandbox`); loadDemo(); }, [loadDemo]);

  const cancel = () => {
    runRef.current++;
    controllerRef.current?.abort();
    setBusy(''); setOperationStatus('Verification cancelled. Choose Run check to retry.');
  };

  const verifyPicked = async () => {
    await runVerify(logFile, receiptText, receiptText ? keyText : '', logFile?.name || 'local file');
  };

  const chooseLog = (file) => {
    invalidateCheck();
    receiptReadRef.current++;
    setReceiptLoading(false);
    setLogFile(file);
    if (file && file.size > MAX_UI_BYTES) setError('This console accepts files up to 64 MiB. Use the command-line tool for larger files.');
    else if (file) setError('');
  };
  const chooseReceipts = async (file) => {
    const token = ++receiptReadRef.current;
    invalidateCheck();
    setReceiptText(''); setReceiptLoading(false);
    if (!file) return;
    setReceiptLoading(true);
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('Receipt file is larger than 4 MiB.');
      const text = await file.text();
      if (token !== receiptReadRef.current) return;
      setReceiptText(text); setError('');
    } catch {
      if (token !== receiptReadRef.current) return;
      setReceiptText(''); setError('Could not read the receipts file. Choose it again to retry.');
    } finally { if (token === receiptReadRef.current) setReceiptLoading(false); }
  };

  const doMutation = async (kind) => {
    if (!result) return;
    const operation = runRef.current;
    const selectedResult = result;
    try {
      const { file, indexed, receipts, key, label } = selectedResult;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (operation !== runRef.current || selectedResult !== result) return;
      if (kind === 'flip') {
        if (indexed.records < 1) { setError('There is no checked record to mutate.'); return; }
        const recordOffset = Number(indexed.rows.offset[0]);
        const payloadLength = Number(indexed.rows.len[0]);
        if (!payloadLength) { setError('The first record has no payload byte to flip.'); return; }
        bytes[recordOffset + HEADER] ^= 1;
        const crcOffset = recordOffset + HEADER + payloadLength + 32;
        new DataView(bytes.buffer).setUint32(crcOffset, crc32(bytes, recordOffset, crcOffset), true);
      } else if (kind === 'delete') {
        if (indexed.records < 3) { setError('At least three records are needed to remove a middle record.'); return; }
        const index = Math.floor(indexed.records / 2);
        if (index >= indexed.rows.count) { setError('This file exceeds the indexed-record sandbox boundary. The full native check is still available.'); return; }
        const start = Number(indexed.rows.offset[index]);
        const end = index + 1 < indexed.rows.count ? Number(indexed.rows.offset[index + 1]) : indexed.goodBytes;
        const changed = new Uint8Array(bytes.length - (end - start));
        changed.set(bytes.subarray(0, start)); changed.set(bytes.subarray(end), start);
        await runVerify(new File([changed], `${label}-record-removed.fseal`), receipts, key, `${label} · copied with record ${index} removed`);
        return;
      } else if (kind === 'truncate') {
        const end = Math.max(8, Number(indexed.goodBytes) - 7);
        await runVerify(new File([bytes.subarray(0, end)], `${label}-tail-truncated.fseal`), receipts, key, `${label} · copied with final seven bytes removed`);
        return;
      }
      await runVerify(new File([bytes], `${label}-byte-flipped.fseal`), receipts, key, `${label} · copied with one payload byte flipped`);
    } catch {
      setError('Could not read the source log to prepare a sandbox copy. Choose it again and retry.');
    }
  };

  const loadRecord = useCallback(async (index, runId = runRef.current) => {
    const hasProblemRow = !!result?.indexed.problem;
    if (!result || index < 0 || index >= result.indexed.rows.count + Number(hasProblemRow)) return;
    const token = ++recordRef.current;
    setSelectedRecord(index); setRecordError(''); setRecordDetail(null);
    try {
      const offset = index < result.indexed.rows.count ? result.indexed.rows.offset[index] : result.indexed.problem.offset;
      const row = await readRecord(blobSource(result.file), offset);
      if (token !== recordRef.current || runId !== runRef.current) return;
      setRecordDetail(row);
    } catch {
      if (token !== recordRef.current || runId !== runRef.current) return;
      setRecordError(`Could not read record ${index}. Retry loading this record.`);
    }
  }, [result]);

  useEffect(() => {
    if (result && result.indexed.records > 0) loadRecord(selectedRecord);
  }, [result, selectedRecord]);

  const runSeal = async () => {
    invalidateCheck(); setResult(null); setRecordDetail(null); setSealOutput(null);
    if (!sealFileInput) { setError('Choose a tab-separated timestamp and payload file first.'); return; }
    if (sealFileInput.size > SEAL_MAX_BYTES) { setError('The C++ sealer accepts source files up to 16 MiB.'); return; }
    const op = ++runRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    setBusy('Sealing the local TSV file with C++ / OpenSSL WebAssembly…'); setError(''); setSealOutput(null);
    try {
      const sealed = await sealFile(sealFileInput, { every: Number(sealInterval), signal: controller.signal });
      if (op !== runRef.current) return;
      const output = { ...sealed, filename: sealFileInput.name };
      setSealOutput(output);
      setReceiptText(sealed.receipts); setKeyText(sealed.publicKey);
      const verified = await runVerify(new File([sealed.log], 'sealed.fseal'), sealed.receipts, sealed.publicKey, 'newly sealed local file');
      if (!verified) return;
      setOperationStatus('Sealing and verification completed locally. Keep the public key and receipts with your separate witness.');
    } catch (cause) {
      if (op !== runRef.current || cause?.name === 'AbortError') return;
      setError(cause?.message || 'Could not seal this file. Check the TSV format and retry.');
    } finally { if (op === runRef.current) setBusy(''); }
  };

  const clearVideo = () => {
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    videoUrlRef.current = null; setVideoInfo(null);
    if (videoRef.current) { videoRef.current.removeAttribute('src'); videoRef.current.load(); }
  };
  const inspectVideo = (file) => {
    clearVideo();
    if (!file) return;
    const url = URL.createObjectURL(file); videoUrlRef.current = url;
    if (videoRef.current) videoRef.current.src = url;
    setVideoInfo({ name: file.name, size: file.size, state: 'Reading browser media metadata…' });
  };

  const resultTitle = result ? humanStatus(result.overallVerdict || result.native.verdict) : null;
  const reportText = result ? [
    `FlightSeal verification report: ${result.label}`,
    `Engine: ${result.native.engine}`,
    `Native chain result: ${result.native.verdict.toUpperCase()} (${result.native.status})`,
    `Overall evidence status: ${(result.overallVerdict || result.native.verdict).toUpperCase()}`,
    `Records checked: ${String(result.native.records)}`,
    `Good bytes: ${String(result.native.goodBytes)}`,
    `Head: ${result.native.head}`,
    `Time reversals: ${String(result.native.timeReversals)}`,
    `Receipt coverage: ${String(result.receiptCoverage?.covered ?? result.native.covered)} covered; ${String(result.receiptCoverage?.uncovered ?? result.native.uncovered)} uncovered`,
    ...(result.receiptChecks.length ? ['', 'Receipt checks:', ...result.receiptChecks.map((r, i) => `  ${i + 1}. after ${r.count}: ${r.description} [${r.check}]`)] : ['Receipts: none supplied']),
    ...(result.indexed.problem ? ['', `First failure: record ${result.indexed.problem.record}, byte ${result.indexed.problem.offset} [${result.indexed.problem.token}]`, result.indexed.problem.detail || ''] : []),
    '', 'This integrity result does not establish that recorded sensor data was true.',
  ].filter((line) => line !== undefined).join('\n') + '\n' : '';
  const reportJson = result ? JSON.stringify({
    engine: result.native.engine, nativeVerdict: result.native.verdict, overallVerdict: result.overallVerdict || result.native.verdict, status: result.native.status,
    records: String(result.native.records), goodBytes: String(result.native.goodBytes), head: result.native.head,
    covered: String(result.receiptCoverage?.covered ?? result.native.covered), uncovered: String(result.receiptCoverage?.uncovered ?? result.native.uncovered),
    receiptChecks: result.receiptChecks.map((r) => ({ ...r, count: String(r.count) })),
    report: reportText,
  }, null, 2) : '';
  const totalRows = result ? result.indexed.rows.count + Number(!!result.indexed.problem && result.indexed.problem.record === result.indexed.rows.count) : 0;
  const pageCount = result ? Math.max(1, Math.ceil(totalRows / PAGE_SIZE)) : 1;
  const currentRows = result ? Math.min(totalRows - page * PAGE_SIZE, PAGE_SIZE) : 0;
  const rowStart = page * PAGE_SIZE;
  const activeReceiptChecks = result?.receiptChecks || [];

  return <div className="app-shell">
    <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.querySelector('main h1')?.focus(); }}>Skip to content</a>
    <header className="topbar">
      <a className="brand" href="#/sandbox" onClick={(e) => { e.preventDefault(); navigate('sandbox'); }}><span className="brand-mark" aria-hidden="true">F</span><span>FlightSeal <b>Console</b></span></a>
      <button className="menu-toggle" type="button" aria-expanded={mobileMenu} aria-controls="primary-nav" onClick={() => setMobileMenu(!mobileMenu)}>Menu</button>
      <nav id="primary-nav" className={mobileMenu ? 'nav open' : 'nav'} aria-label="Console sections">
        {NAV.map(([key, label, number]) => <a key={key} href={`#/${key}`} aria-keyshortcuts={`Alt+Shift+${Number(number)}`} aria-current={screen === key ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate(key); }}><span>{number}</span>{label}</a>)}
      </nav>
      <span className="local-badge"><i aria-hidden="true" />Local files</span>
    </header>

    <main id="main" className="page-wrap">
      <div className="page-heading">
        <div><p className="eyebrow">FLIGHT EVIDENCE WORKSPACE</p><h1 id={`page-${screen}`} tabIndex="-1">{titleFor(screen)}</h1></div>
        {result && <div className={`status-pill ${resultTitle[1]}`}><span className="status-shape" aria-hidden="true" />{resultTitle[0]}</div>}
      </div>

      {error && <div role="alert" className="alert error-alert"><strong>Could not finish</strong><p>{error}</p><button type="button" className="button secondary" onClick={() => setError('')}>Dismiss</button></div>}
      {busy && <div className="busy-card" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" />{busy}<button className="button secondary" type="button" onClick={cancel}>Cancel</button></div>}
      {operationStatus && !busy && <p className="operation-status" role="status">{operationStatus}</p>}
      {offlineStatus && <p className="offline-note" role="status">{offlineStatus}</p>}

      {screen === 'sandbox' && <section className="screen" aria-labelledby="sandbox-title">
        <section className="hero-card">
          <div className="hero-copy"><p className="eyebrow">A LOCAL CHECK, WITH RECEIPTS</p><h2 id="sandbox-title">Know what the log proves.</h2><p>Load a prepared log, change a copy, and inspect what verification detects. Files stay on this device.</p><div className="hero-actions"><button className="button primary" type="button" onClick={() => loadDemo(false)}>Load 800-record demo</button><button className="button secondary" type="button" onClick={() => loadDemo(true)}>Open 2,422-record PX4 example</button><button className="button secondary" type="button" onClick={() => loadDemo('full')}>Open full PX4 example (64,542 records · 28.9 MiB)</button></div></div>
          <div className="hero-fact"><span className="eyebrow">CURRENT SAMPLE</span><strong>{demoLabel || 'Included demo'}</strong><span>{result ? `${fmtBig(result.native.records)} checked records · ${fmtBytes(result.file.size)}` : 'Included source fixture'}</span><span className="trust-note">A chain pass is an integrity result, not proof that sensor data was true.</span></div>
        </section>
        {demoLabel.includes('PX4') && <p className="sample-note">The PX4 example contains selected decoded records; it does not authenticate every byte of the original ULog. The bundled public key verifies this demonstration fixture only.{demoLabel.includes('full') && <> <a href="/flightseal/samples/px4-full-provenance.json">View source and sealing provenance</a>.</>}</p>}
        {result && <ResultPanel result={result} resultTitle={resultTitle} reportText={reportText} reportJson={reportJson} onDownloadText={() => download('flightseal-verification-report.txt', reportText)} onDownloadJson={() => download('flightseal-verification-report.json', reportJson, 'application/json')} onNavigate={navigate} />}
        <div className="section-grid">
          <section className="panel"><div className="panel-head"><span className="section-no">01</span><h2>Sandbox mutations</h2></div><div className="panel-body"><p>Each action creates a copy of the loaded log, changes only that copy, then runs the real native verifier.</p><div className="mutation-list"><button className="mutation" type="button" disabled={!result || !!busy} onClick={() => doMutation('flip')}><span>Flip one payload byte</span><small>Shows the first checksum or chain failure</small></button><button className="mutation" type="button" disabled={!result || !!busy} onClick={() => doMutation('delete')}><span>Remove one middle record</span><small>Shows where sequence checking stops</small></button><button className="mutation" type="button" disabled={!result || !!busy} onClick={() => doMutation('truncate')}><span>Trim seven tail bytes</span><small>Distinguishes a torn final record</small></button></div></div></section>
          <section className="panel"><div className="panel-head"><span className="section-no">02</span><h2>Seal a new local file</h2></div><div className="panel-body"><p>Input rows use <code>timestamp_us&lt;TAB&gt;payload</code>. The native sealer creates a new log, witness receipts, and a public key.</p><label className="field-label" htmlFor="tsv-file">Timestamp and payload file</label><input id="tsv-file" type="file" accept=".tsv,.txt,text/plain" onChange={(e) => { invalidateCheck(); setSealFileInput(e.target.files?.[0] || null); setSealOutput(null); setError(''); }} /><label className="field-label" htmlFor="receipt-interval">Receipt every N records</label><input id="receipt-interval" type="number" min="1" max="1000000" value={sealInterval} onChange={(e) => { invalidateCheck(); setSealInterval(e.target.value); setSealOutput(null); }} /><button className="button primary" type="button" disabled={!sealFileInput || !!busy} onClick={runSeal}>Seal and verify</button>{sealOutput && <div className="seal-outputs"><button className="button secondary" onClick={() => download('sealed.fseal', sealOutput.log, 'application/octet-stream')}>Download sealed log</button><button className="button secondary" onClick={() => download('sealed.receipts', sealOutput.receipts)}>Download receipts</button><button className="button secondary" onClick={() => download('sealed-public-key.txt', sealOutput.publicKey + '\n')}>Download public key</button><p>Keep the public key and receipts through a separate witness. The private key is not returned.</p></div>}</div></section>
        </div>
      </section>}

      {screen === 'verify' && <section className="screen" aria-labelledby="verify-title"><div className="panel verify-panel"><div className="panel-head"><span className="section-no">01</span><h2 id="verify-title">Choose local evidence</h2></div><div className="panel-body input-grid"><div><label className="field-label" htmlFor="log-input">FlightSeal log <span>(up to 64 MiB in this console)</span></label><input id="log-input" type="file" accept=".fseal,application/octet-stream" onChange={(e) => chooseLog(e.target.files?.[0] || null)} /></div><div><label className="field-label" htmlFor="receipt-input">Witness receipts <span>(optional)</span></label><input id="receipt-input" type="file" accept=".receipts,text/plain" onChange={(e) => chooseReceipts(e.target.files?.[0] || null)} />{receiptLoading && <p className="field-hint" role="status">Reading the selected receipts locally…</p>}</div><div className="field-wide"><label className="field-label" htmlFor="trusted-key">Trusted public key <span>(64 lowercase hexadecimal digits)</span></label><input id="trusted-key" className="mono-input" value={keyText} onChange={(e) => { invalidateCheck(); setKeyText(e.target.value); }} autoComplete="off" spellCheck="false" /></div><div className="field-wide actions-row"><button className="button primary" type="button" disabled={!logFile || logFile.size > MAX_UI_BYTES || receiptLoading || !!busy} onClick={verifyPicked}>Run C++ check</button><button className="button secondary" type="button" onClick={() => loadDemo(false)}>Load included 800-record demo</button></div></div></div>{result && <ResultPanel result={result} resultTitle={resultTitle} reportText={reportText} reportJson={reportJson} onDownloadText={() => download('flightseal-verification-report.txt', reportText)} onDownloadJson={() => download('flightseal-verification-report.json', reportJson, 'application/json')} onNavigate={navigate} />}</section>}

      {screen === 'records' && <section className="screen"><p className="lede">Every listed row comes from the checked file index. A selected row is read again from the local file.</p>{!result ? <EmptyState onNavigate={navigate} /> : <div className="records-layout"><section className="panel records-panel"><div className="panel-head"><span className="section-no">03</span><h2>Checked records <span className="subcount">{fmtBig(result.native.records)}</span></h2></div>{result.indexed.rowsTruncated && <p className="muted index-limit">The record list stops at 100,000 rows; the native check covered the full file.</p>}<ol className="record-list">{Array.from({ length: currentRows }, (_, localIndex) => { const index = rowStart + localIndex; const broken = !!result.indexed.problem && index === result.indexed.problem.record; const rowLength = index < result.indexed.rows.count ? result.indexed.rows.len[index] : null; return <li key={index} className={`${broken ? 'record-broken' : 'record-pass'} ${index === selectedRecord ? 'selected' : ''}`}><button type="button" aria-current={index === selectedRecord ? 'true' : undefined} onClick={() => setSelectedRecord(index)}><span className="record-index">{fmtBig(index)}</span><span className="record-status">{broken ? result.indexed.problem.token : 'Checked'}</span><span className="record-bytes">{rowLength == null ? 'problem row' : fmtBytes(rowLength)}</span></button></li>; })}</ol><div className="pagination"><button className="button secondary" disabled={page === 0} onClick={() => setPage(0)}>First</button><button className="button secondary" disabled={page === 0} onClick={() => setPage((v) => Math.max(0, v - 1))}>Previous</button><span>Page {page + 1} of {pageCount}</span><button className="button secondary" disabled={page >= pageCount - 1} onClick={() => setPage((v) => Math.min(pageCount - 1, v + 1))}>Next</button><button className="button secondary" disabled={page >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>Last</button></div></section><section className="panel detail-panel" aria-labelledby="record-detail-heading"><div className="panel-head"><span className="section-no">→</span><h2 id="record-detail-heading">Record {fmtBig(selectedRecord)}</h2></div><div className="panel-body">{recordError ? <div role="alert" className="alert error-alert"><p>{recordError}</p><button className="button secondary" onClick={() => loadRecord(selectedRecord)}>Retry</button></div> : !recordDetail ? <p className="muted" role="status">Loading record…</p> : <RecordDetail record={recordDetail} />}</div></section></div>}</section>}

      {screen === 'receipts' && <section className="screen"><p className="lede">Receipts are checked by the C++ engine against the independently entered key. The rows below show counts and head links, never log payloads.</p>{!result ? <EmptyState onNavigate={navigate} /> : <section className="panel"><div className="panel-head"><span className="section-no">04</span><h2>Receipt register</h2></div><p className="receipt-overview">{fmtBig(result.receiptCoverage?.covered ?? result.native.covered)} records covered by a trusted receipt · {fmtBig(result.receiptCoverage?.uncovered ?? result.native.uncovered)} uncovered</p>{result.needsTrustedKey && <p className="muted">The native result below covers the hash chain only. Receipt signatures remain unchecked until a trusted public key is entered.</p>}{activeReceiptChecks.length ? <div className="table-scroll"><table><thead><tr><th scope="col">Receipt</th><th scope="col">After records</th><th scope="col">Check</th><th scope="col">Head</th><th scope="col">Signing key</th></tr></thead><tbody>{activeReceiptChecks.map((receipt, i) => <tr key={`${receipt.count}-${i}`}><td>{i + 1}</td><td className="numeric">{fmtBig(receipt.count)}</td><td><span className={`status-label ${receipt.check === 'ok' ? 'ok' : receipt.check === 'wrong-key' || receipt.check === 'bad-signature' ? 'bad' : 'warn'}`}>{receipt.description}</span></td><td><code>{receipt.head}</code></td><td><code>{receipt.key}</code></td></tr>)}</tbody></table></div> : <div className="panel-body"><p>{result.receipts ? 'No receipts were authenticated in this run.' : 'No receipts were provided. Load the demo or add a receipts file and trusted key.'}</p></div>}</section>}</section>}

      {screen === 'video' && <section className="screen"><p className="lede">Inspect a local video file with the browser media element. This reads metadata and playback capability only; there is no upload or conversion.</p><section className="panel"><div className="panel-head"><span className="section-no">05</span><h2>Local video inspection</h2></div><div className="panel-body video-grid"><label className="field-label" htmlFor="video-input">Choose a local video</label><input id="video-input" type="file" accept="video/*" onChange={(e) => inspectVideo(e.target.files?.[0] || null)} /><video ref={videoRef} controls playsInline aria-label="Selected local video preview" onLoadedMetadata={(e) => setVideoInfo((v) => v && ({ ...v, duration: e.currentTarget.duration, width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight, state: 'Browser metadata available. Codec identification is unknown.' }))} onCanPlay={() => setVideoInfo((v) => v && ({ ...v, playable: true }))} onError={() => setVideoInfo((v) => v && ({ ...v, playable: false, state: 'The browser could not read metadata or play this stream. Codec identification is unknown.' }))} />{videoInfo && <div className="video-meta" role="status"><strong>{videoInfo.name}</strong><span>{fmtBytes(videoInfo.size)}</span>{videoInfo.duration != null && <span>{Number.isFinite(videoInfo.duration) ? `${videoInfo.duration.toFixed(2)} seconds` : 'Duration unavailable'}</span>}{videoInfo.width && <span>{videoInfo.width} × {videoInfo.height} pixels</span>}<p>{videoInfo.state}</p><p>Video bytes stay local. No codec name is inferred when the browser does not expose one.</p></div>}</div></section></section>}

      {screen === 'help' && <section className="screen help-layout"><section className="panel"><div className="panel-head"><span className="section-no">06</span><h2>What a result means</h2></div><div className="panel-body prose"><h3>Integrity and authenticity are different.</h3><p>An intact result means this file agrees with its own hash chain. With receipts, the native verifier checks signed checkpoints against the public key you enter. Neither result proves that sensor data was true when recorded or that every byte of the original PX4 ULog was preserved. The PX4 examples contain selected decoded records; they do not authenticate every byte of the original ULog.</p><h3>Keep the witness separate.</h3><p>Receipts protect against a shortened or rebuilt log only when someone other than the log holder kept them. Confirm the public key with that witness through a separate channel.</p><h3>Read the first failure.</h3><p>Verification stops at the first record that cannot be trusted. A hash-chain break locates the first inconsistent link, not every changed record. A torn tail may reflect a writer interruption; other failures require investigation. The console does not repair or overwrite the supplied file.</p><h3>Keyboard shortcuts</h3><p>Alt+Shift+1 through Alt+Shift+6 open the six sections in navigation order. Tab and Enter work throughout; Escape closes the menu or team dialog.</p><h3>Local limits.</h3><p>Files and payloads stay in this browser. Reports contain verdicts, counts and hashes, not record payloads. This is an AI-assisted project; generated code and documentation require human review.</p><p><a href="https://github.com/anirudh763/flightseal" target="_blank" rel="noreferrer">Review source and report an issue on GitHub</a></p><p><a href="/flightseal/" rel="noopener">Open the existing verifier</a></p></div></section><section className="panel limits-panel"><div className="panel-head"><h2>Current browser boundaries</h2></div><div className="panel-body"><dl><dt>Verify file size</dt><dd>64 MiB console guard</dd><dt>Native worker limit</dt><dd>500 MiB</dd><dt>Seal source file</dt><dd>16 MiB</dd><dt>Receipt text</dt><dd>4 MiB</dd><dt>Record list index</dt><dd>At most 100,000 rows</dd><dt>Payload display</dt><dd>First 4 KiB per selected record</dd></dl></div></section></section>}
    </main>
    <dialog ref={teamDialogRef} className="team-dialog" aria-labelledby="team-title" aria-describedby="team-description">
      <h2 id="team-title">Team workflow options</h2>
      <p id="team-description">The local verifier is free. A hosted team plan is not available.</p>
      <p>A proposed $49/month plan would need to solve shared receipt custody and audit handoff. That price is a research question, not an offer or checkout.</p>
      <p>Tell the maintainer which workflow your team needs. Feedback is public on GitHub; no email is collected here.</p>
      <div className="actions-row"><a className="button primary" href="https://github.com/anirudh763/flightseal/issues/new?title=Team%20workflow%20feedback" target="_blank" rel="noreferrer">Share team requirements</a><button className="button secondary" type="button" autoFocus onClick={() => teamDialogRef.current?.close()}>Close</button></div>
    </dialog>
    <footer className="footer"><button className="button secondary" type="button" onClick={() => teamDialogRef.current?.showModal()}>Team options</button><span>FlightSeal Console · local browser workspace</span><a href="/flightseal/">Classic verifier</a><span>Integrity is not a claim about sensor truth.</span></footer>
  </div>;
}

function EmptyState({ onNavigate }) { return <div className="empty-state"><h2>No verified file yet</h2><p>Load the included demo or choose a local file to see this section.</p><button className="button primary" onClick={() => onNavigate('sandbox')}>Open sandbox</button></div>; }
function RecordDetail({ record }) { return <><dl className="detail-grid"><dt>File offset</dt><dd className="numeric">{fmtBig(record.offset)}</dd><dt>Payload length</dt><dd>{fmtBytes(record.length)}</dd><dt>Raw sequence</dt><dd className="numeric">{record.seq == null ? 'Missing' : fmtBig(record.seq)}</dd><dt>Timestamp</dt><dd className="numeric">{record.ts == null ? 'Missing' : `${fmtBig(record.ts)} µs`}</dd><dt>Stored link</dt><dd><code>{record.link || 'Unavailable'}</code></dd><dt>Stored CRC-32</dt><dd><code>{record.crc || 'Unavailable'}</code></dd></dl><h3>Payload excerpt</h3><pre className="payload mono">{new TextDecoder().decode(record.payload.subarray(0, 4096)) || '(empty)'}</pre></>; }
function ResultPanel({ result, resultTitle, reportText, reportJson, onDownloadText, onDownloadJson, onNavigate }) {
  const { native, indexed } = result;
  const [label, kind] = resultTitle;
  const problem = indexed.problem;
  return <section className="result-panel panel" aria-labelledby="result-heading"><div className="result-top"><div><p className="eyebrow">NATIVE RESULT · {native.engine}</p><h2 id="result-heading"><span className={`status-shape ${kind}`} aria-hidden="true" />{label}</h2><p>{result.needsTrustedKey ? `The native hash-chain result is ${native.verdict}. Receipt signatures were not checked because no trusted key was supplied.` : native.description || indexed.description || 'The checked log matches the current verdict.'}</p></div><div className="result-stat"><strong>{fmtBig(native.records)}</strong><span>records checked</span></div></div><div className="stats-grid"><div><span>File</span><strong className="wrap">{result.label}</strong></div><div><span>Size</span><strong>{fmtBytes(result.file.size)}</strong></div><div><span>Good bytes</span><strong>{fmtBytes(native.goodBytes)}</strong></div><div><span>Head link</span><code className="wrap">{native.head}</code></div><div><span>Receipt coverage</span><strong>{fmtBig(result.receiptCoverage?.covered ?? native.covered)} covered · {fmtBig(result.receiptCoverage?.uncovered ?? native.uncovered)} uncovered</strong></div><div><span>Time reversals</span><strong>{fmtBig(native.timeReversals)}</strong></div></div>{problem && <div className={`first-failure ${kind}`}><span className="eyebrow">FIRST FAILURE</span><strong>Record {fmtBig(problem.record)} · {problem.token}</strong><span>{problem.detail || problem.description || 'Verification stopped at this first inconsistent record.'}</span>{problem.expected && problem.actual && <div className="hash-comparison"><span>Expected link</span><code>{problem.expected}</code><span>Stored link</span><code>{problem.actual}</code></div>}<span>Offset {fmtBig(problem.offset)} bytes</span></div>}<div className="result-actions"><button className="button secondary" onClick={() => onNavigate('records')}>Inspect records</button><button className="button secondary" onClick={() => onNavigate('receipts')}>Review receipts</button><button className="button secondary" onClick={onDownloadText}>Download text report</button><button className="button secondary" onClick={onDownloadJson}>Download JSON summary</button></div><details className="report-details"><summary>Read text report</summary><pre className="report-text">{reportText}</pre></details></section>;
}

createRoot(document.getElementById('root')).render(<App />);
