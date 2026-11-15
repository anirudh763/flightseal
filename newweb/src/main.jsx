import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronDown, CircleHelp, FileCheck2, FileUp, FlaskConical, List, MapPin, ShieldCheck, Stamp, Video } from 'lucide-react';
import { importFile, IMPORT_MAX_BYTES, VERIFY_MAX_BYTES, verifyFile, sealFile, SEAL_MAX_BYTES, recoverTemporaryOutputs } from '../../docs/wasm/client.mjs';
import { blobSource, checkReceipts, decodeReceipts, parseHex, parseReceipts, readRecord, scanLog, summarize } from '../../docs/verifier.js';
import { mutateFile, readIndexedRecords, recordAt } from '../../docs/records.mjs';
import './style.css';

const MAX_UI_BYTES = VERIFY_MAX_BYTES;
const PAGE_SIZE = 50;
const NAV = [
  ['sandbox', 'Workbench', FlaskConical], ['verify', 'Verify file', ShieldCheck], ['records', 'Records', List],
  ['receipts', 'Receipts', Stamp], ['video', 'Video sync', Video], ['help', 'Trust limits', CircleHelp],
];
const asBig = (value) => typeof value === 'bigint' ? value : BigInt(value ?? 0);
function nearestTelemetryIndex(points, record, timestamp) {
  if (timestamp == null) return null;
  const target = asBig(timestamp);
  let bestIndex = null;
  let bestDistance = null;
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (Number(point.record) !== Number(record)) continue;
    const time = asBig(point.timestampUs);
    const distance = time >= target ? time - target : target - time;
    if (bestDistance == null || distance < bestDistance) { bestIndex = index; bestDistance = distance; }
  }
  if (bestIndex != null) return bestIndex;
  for (let index = 0; index < points.length; index++) {
    const time = asBig(points[index].timestampUs);
    const distance = time >= target ? time - target : target - time;
    if (bestDistance == null || distance < bestDistance) { bestIndex = index; bestDistance = distance; }
  }
  return bestIndex;
}
const fmtBig = (value) => new Intl.NumberFormat('en-US').format(asBig(value));
const fmtBytes = (value) => {
  const n = Number(value);
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n / 1024 / 1024)} MiB`;
};
const humanStatus = (status) => ({
  intact: ['Intact', 'ok'], 'bad-link': ['Hash chain break', 'bad'], 'bad-crc': ['Checksum mismatch', 'bad'],
  'bad-seq': ['Sequence break', 'bad'], 'bad-length': ['Invalid record length', 'bad'],
  'bad-header': ['Not a supported .fseal log', 'bad'], 'torn-tail': ['Torn final record', 'warn'],
  incomplete: ['Incomplete', 'warn'], tampered: ['Tampered', 'bad'], unverified: ['Unverified', 'warn'],
}[status] || [String(status || 'Unknown'), 'warn']);
const titleFor = (screen) => NAV.find(([key]) => key === screen)?.[1] || 'Not found';

function download(name, content, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const problemLabel = (token) => ({
  'bad-link': 'Hash link mismatch', 'bad-crc': 'CRC mismatch', 'bad-seq': 'Sequence mismatch',
  'bad-length': 'Invalid record length', 'bad-header': 'Invalid file header', 'torn-tail': 'Incomplete record data',
}[token] || String(token || 'Unknown failure'));

function App() {
  const [screen, setScreen] = useState(() => location.hash.slice(2).split(/[/?]/)[0] || 'sandbox');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [logFile, setLogFile] = useState(null);
  const [receiptText, setReceiptText] = useState('');
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptSelected, setReceiptSelected] = useState(false);
  const [receiptInputError, setReceiptInputError] = useState('');
  const [keyText, setKeyText] = useState('');
  const [selectedRecord, setSelectedRecord] = useState(0);
  const [recordDetail, setRecordDetail] = useState(null);
  const [recordError, setRecordError] = useState('');
  const [pageRows, setPageRows] = useState([]);
  const [firstRecord, setFirstRecord] = useState(null);
  const [telemetry, setTelemetry] = useState([]);
  const [selectedTelemetryIndex, setSelectedTelemetryIndex] = useState(null);
  const [hasImportedOutput, setHasImportedOutput] = useState(false);
  const [page, setPage] = useState(0);
  const [sealFileInput, setSealFileInput] = useState(null);
  const [sealInterval, setSealInterval] = useState(1000);
  const [sealOutput, setSealOutput] = useState(null);
  const [videoInfo, setVideoInfo] = useState(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoOffset, setVideoOffset] = useState('0');
  const [demoLabel, setDemoLabel] = useState('');
  const [operationStatus, setOperationStatus] = useState('');
  const [offlineStatus, setOfflineStatus] = useState('');
  const runRef = useRef(0);
  const controllerRef = useRef(null);
  const recordRef = useRef(0);
  const receiptReadRef = useRef(0);
  const receiptInputRef = useRef(null);
  const receiptInvalidRef = useRef(false);
  const receiptInvalidMessageRef = useRef('');
  const telemetrySelectionRef = useRef(0);
  const videoRef = useRef(null);
  const videoUrlRef = useRef(null);
  const routeEpochRef = useRef(0);
  const workbenchFileRef = useRef(null);
  const tsvFileRef = useRef(null);
  const importDisposeRef = useRef(null);
  const focusedRouteRef = useRef(null);

  const navigate = useCallback((next) => {
    const route = NAV.some(([key]) => key === next) ? next : 'help';
    location.hash = `/${route}`;
    setScreen(route);
    setError('');
  }, []);

  useEffect(() => {
    const update = () => {
      const next = location.hash.slice(2).split(/[/?]/)[0] || 'sandbox';
      setScreen(NAV.some(([key]) => key === next) ? next : 'help');
    };
    addEventListener('hashchange', update);
    return () => removeEventListener('hashchange', update);
  }, []);

  useEffect(() => {
    document.title = `${titleFor(screen)} · HashWing`;
    if (focusedRouteRef.current !== null && focusedRouteRef.current !== screen) {
      requestAnimationFrame(() => document.getElementById(`page-${screen}`)?.focus());
    }
    focusedRouteRef.current = screen;
  }, [screen]);

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

  const disposeImportedOutput = async () => {
    const dispose = importDisposeRef.current;
    importDisposeRef.current = null;
    setHasImportedOutput(false);
    if (typeof dispose !== 'function') return;
    try { await dispose(); }
    catch (cause) { setError(cause?.message || 'Could not remove the previous temporary import output.'); }
  };

  const runVerify = useCallback(async (file, receipts = '', trustedKey = '', label = file?.name || 'local file', source = null) => {
    if (receiptInvalidRef.current) {
      setError(receiptInvalidMessageRef.current || 'Remove the invalid receipts file or choose a valid one before checking.');
      return null;
    }
    if (!file) { invalidateCheck(); setError('Choose a sealed log first.'); return null; }
    if (file.size > MAX_UI_BYTES) { invalidateCheck(); setError(`This workbench accepts sealed logs up to ${fmtBytes(MAX_UI_BYTES)}. Use the command-line tool for larger files.`); return null; }
    const operation = ++runRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy('Checking the log locally…');
    setError(''); setOperationStatus('');
    setResult(null); setRecordDetail(null); setRecordError('');
    try {
      const parsedReceipts = receipts ? parseReceipts(receipts) : null;
      if (parsedReceipts?.error) {
        const message = `Receipts line ${parsedReceipts.error.line} is not valid. Remove receipts or choose a valid receipt file.`;
        receiptInvalidRef.current = true; receiptInvalidMessageRef.current = message; setReceiptInputError(message);
        throw new Error(message);
      }
      const needsTrustedKey = !!receipts && !trustedKey.trim();
      const engineReceipts = needsTrustedKey ? '' : receipts;
      const engineKey = needsTrustedKey ? '' : trustedKey;
      const [native, indexed] = await Promise.all([
        verifyFile(file, engineReceipts, engineKey, { signal: controller.signal }),
        scanLog(blobSource(file), { maxRows: 65536, sparse: true, signal: controller.signal, linksAt: parsedReceipts?.receipts.map((receipt) => receipt.count) || [] }),
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
        native, indexed, receiptIndex, receiptChecks, file, receipts, key: trustedKey, label, source,
        overallVerdict,
        receiptCoverage: needsTrustedKey ? { covered: '0', uncovered: String(native.records) } : { covered: native.covered, uncovered: native.uncovered },
        needsTrustedKey,
      };
      setResult(completed);
      const rowCount = Number(native.records) + Number(!!indexed.problem && indexed.problem.record === Number(native.records));
      const initialRecord = indexed.problem?.record ?? Math.max(0, rowCount - 1);
      const displayRecord = initialRecord < rowCount ? initialRecord : Math.max(0, rowCount - 1);
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
    setTelemetry([]); setSelectedTelemetryIndex(null);
    setReceiptText(''); setKeyText('');
    const operation = ++runRef.current;
    controllerRef.current?.abort();
    receiptReadRef.current++;
    setReceiptLoading(false); setReceiptSelected(false); setReceiptInputError('');
    receiptInvalidRef.current = false; receiptInvalidMessageRef.current = '';
    if (receiptInputRef.current) receiptInputRef.current.value = '';
    const controller = new AbortController(); controllerRef.current = controller;
    const aliases = {
      intact: { log: 'intact.fseal', receipts: 'flight.receipts', key: 'pubkey.txt', label: '800-record included demo' },
      tampered: { log: 'tampered.fseal', receipts: 'flight.receipts', key: 'pubkey.txt', label: 'Tampered included sample' },
      rewritten: { log: 'rewritten.fseal', receipts: 'flight.receipts', key: 'pubkey.txt', label: 'Rewritten included sample' },
      truncated: { log: 'truncated.fseal', receipts: 'flight.receipts', key: 'pubkey.txt', label: 'Truncated included sample' },
      px4: { log: 'px4-intact.fseal', receipts: 'px4-flight.receipts', key: 'px4-pubkey.txt', label: '2,422-record PX4 example' },
      'px4-tampered': { log: 'px4-tampered.fseal', receipts: 'px4-flight.receipts', key: 'px4-pubkey.txt', label: 'Tampered PX4 sample' },
      'px4-full': { log: 'px4-full.fseal', receipts: 'px4-full.receipts', key: 'px4-full-pubkey.txt', label: 'full PX4 example' },
    };
    const sampleKey = sample === false ? 'intact' : sample === true ? 'px4' : sample === 'full' ? 'px4-full' : sample;
    const chosen = aliases[sampleKey] || aliases.intact;
    const size = chosen.label;
    const { log: logName, receipts: receiptName, key: keyName } = chosen;
    setBusy(`Loading ${size} from the included sample…`); setError(''); setResult(null); setRecordDetail(null); setRecordError('');
    await disposeImportedOutput();
    if (operation !== runRef.current) return;
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
      const verified = await runVerify(file, receipts, key, size);
      if (verified) {
        const params = new URLSearchParams(location.hash.split('?')[1] || '');
        const requestedRecord = params.get('record');
        if (requestedRecord && /^\d+$/.test(requestedRecord)) {
          const index = Number(requestedRecord);
          const available = Number(verified.native.records) + Number(!!verified.indexed.problem && Number(verified.indexed.problem.record) === Number(verified.native.records));
          if (Number.isSafeInteger(index) && index >= 0 && index < available) {
            setSelectedRecord(index); setPage(Math.floor(index / PAGE_SIZE));
          }
        }
      }
    } catch (cause) {
      if (operation !== runRef.current || cause?.name === 'AbortError') return;
      setBusy(''); setError(cause?.message || 'Could not load the included sample. Reload and retry.');
    }
  }, [runVerify]);

  useEffect(() => {
    if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/sandbox`);
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const allowed = new Set(['intact', 'tampered', 'rewritten', 'truncated', 'px4', 'px4-tampered', 'px4-full']);
    const requested = params.get('sample');
    loadDemo(allowed.has(requested) ? requested : false);
  }, [loadDemo]);

  useEffect(() => {
    let active = true;
    recoverTemporaryOutputs()
      .then((removed) => { if (active && removed > 0) setOperationStatus(`Cleared ${removed} abandoned temporary import output${removed === 1 ? '' : 's'} from an earlier session.`); })
      .catch((cause) => { if (active) setError(cause?.message || 'Could not clean up earlier temporary import outputs. Verification remains available.'); });
    return () => { active = false; };
  }, []);

  const cancel = () => {
    runRef.current++;
    controllerRef.current?.abort();
    setBusy(''); setOperationStatus('Verification cancelled. Choose Run check to retry.');
  };

  const clearImportedSession = async () => {
    invalidateCheck(); setResult(null); setRecordDetail(null); setTelemetry([]); setSelectedTelemetryIndex(null); setLogFile(null); setDemoLabel('');
    receiptReadRef.current++;
    setReceiptText(''); setReceiptLoading(false); setReceiptSelected(false); setReceiptInputError(''); setKeyText('');
    receiptInvalidRef.current = false; receiptInvalidMessageRef.current = '';
    if (receiptInputRef.current) receiptInputRef.current.value = '';
    const operation = runRef.current;
    await disposeImportedOutput();
    if (operation !== runRef.current) return;
    setOperationStatus('Imported session and temporary sealed output cleared.');
  };

  const verifyPicked = async () => {
    await runVerify(logFile, receiptText, receiptText ? keyText : '', logFile?.name || 'local file');
  };

  const chooseLog = async (file) => {
    const replacingImportedSession = hasImportedOutput;
    const clearAttachedEvidence = replacingImportedSession || !receiptSelected || receiptLoading;
    invalidateCheck();
    const operation = runRef.current;
    setResult(null); setRecordDetail(null);
    await disposeImportedOutput();
    if (operation !== runRef.current) return;
    setTelemetry([]); setSelectedTelemetryIndex(null);
    if (clearAttachedEvidence) {
      setReceiptText(''); setReceiptLoading(false); setReceiptSelected(false); setReceiptInputError(''); setKeyText('');
      receiptInvalidRef.current = false; receiptInvalidMessageRef.current = '';
      if (receiptInputRef.current) receiptInputRef.current.value = '';
    }
    receiptReadRef.current++;
    setReceiptLoading(false);
    setLogFile(file);
    if (file && file.size > MAX_UI_BYTES) setError(`This workbench accepts sealed logs up to ${fmtBytes(MAX_UI_BYTES)}. Use the command-line tool for larger files.`);
    else if (file) setError('');
  };
  const importUlog = async (file, { label = `${file.name} · native ULog import`, synthetic = false } = {}) => {
    if (file.size > IMPORT_MAX_BYTES) {
      setError(`This workbench accepts source files up to ${fmtBytes(IMPORT_MAX_BYTES)}. Use the command-line tool for larger captures.`);
      return;
    }
    invalidateCheck(); setResult(null); setRecordDetail(null); setTelemetry([]); setSelectedTelemetryIndex(null);
    receiptReadRef.current++;
    setReceiptText(''); setReceiptLoading(false); setReceiptSelected(false); setReceiptInputError(''); setKeyText('');
    receiptInvalidRef.current = false; receiptInvalidMessageRef.current = '';
    if (receiptInputRef.current) receiptInputRef.current.value = '';
    const op = ++runRef.current;
    await disposeImportedOutput();
    if (op !== runRef.current) return;
    const controller = new AbortController(); controllerRef.current = controller;
    setBusy('Importing and sealing the local ULog…'); setError('');
    try {
      const imported = await importFile(file, { every: Number(sealInterval), signal: controller.signal });
      if (op !== runRef.current) { await imported.dispose?.(); return; }
      setTelemetry(imported.telemetry || []);
      setReceiptSelected(false); setReceiptInputError('');
      receiptInvalidRef.current = false; receiptInvalidMessageRef.current = '';
      if (receiptInputRef.current) receiptInputRef.current.value = '';
      setReceiptText(imported.receipts); setKeyText(imported.publicKey);
      const verified = await runVerify(imported.log, imported.receipts, imported.publicKey, label, imported.source);
      if (!verified) { setTelemetry([]); setSelectedTelemetryIndex(null); await imported.dispose?.(); return; }
      importDisposeRef.current = typeof imported.dispose === 'function' ? imported.dispose.bind(imported) : null;
      setHasImportedOutput(true);
      const lastPointIndex = (imported.telemetry?.length || 0) - 1;
      if (lastPointIndex >= 0) {
        const point = imported.telemetry[lastPointIndex];
        telemetrySelectionRef.current++;
        setSelectedTelemetryIndex(lastPointIndex); setSelectedRecord(Number(point.record)); setPage(Math.floor(Number(point.record) / PAGE_SIZE));
      }
      setOperationStatus(synthetic
        ? 'Synthetic telemetry demonstration imported locally. Its plotted values illustrate decoder support and are not flight evidence.'
        : 'ULog bytes were preserved and checked locally. The sealed copy stays in temporary browser storage until you clear the imported session; abandoned copies are removed on your next visit.');
      navigate('sandbox');
    } catch (cause) {
      if (op !== runRef.current || cause?.name === 'AbortError') return;
      setError(cause?.message || 'Native ULog import failed. Check the capture and try again.');
    } finally { if (op === runRef.current) setBusy(''); }
  };
  const loadTelemetrySample = async () => {
    invalidateCheck(); setResult(null); setRecordDetail(null); setTelemetry([]); setSelectedTelemetryIndex(null);
    const operation = ++runRef.current;
    await disposeImportedOutput();
    if (operation !== runRef.current) return;
    const controller = new AbortController(); controllerRef.current = controller;
    setBusy('Loading the bundled synthetic ULog…'); setError('');
    try {
      const response = await fetch('/flightseal/samples/telemetry-demo.ulg', { signal: controller.signal });
      if (!response.ok) throw new Error('The bundled telemetry ULog could not be loaded.');
      const file = new File([await response.blob()], 'telemetry-demo.ulg', { type: 'application/octet-stream' });
      if (operation !== runRef.current) return;
      await importUlog(file, { label: 'Synthetic telemetry demonstration', synthetic: true });
    } catch (cause) {
      if (operation !== runRef.current || cause?.name === 'AbortError') return;
      setError(cause?.message || 'Could not load the bundled synthetic ULog.');
    } finally { if (operation === runRef.current) setBusy(''); }
  };
  const chooseWorkbenchFile = async (file) => {
    if (!file) return;
    const extension = file.name.toLowerCase().split('.').pop();
    if (extension === 'fseal') {
      await chooseLog(file);
      navigate('verify');
      return;
    }
    if (extension === 'tsv' || extension === 'txt') {
      invalidateCheck(); const operation = runRef.current; setResult(null); setTelemetry([]); setSelectedTelemetryIndex(null); await disposeImportedOutput();
      if (operation !== runRef.current) return;
      setSealFileInput(file); setSealOutput(null); setError(''); navigate('sandbox');
      return;
    }
    if (extension !== 'ulg') {
      setError('Unsupported source format. Choose a FlightSeal-compatible .fseal log, a PX4 .ulg capture, or a timestamped TSV/TXT file.');
      return;
    }
    await importUlog(file);
  };
  const chooseReceipts = async (file) => {
    const token = ++receiptReadRef.current;
    invalidateCheck();
    setReceiptText(''); setReceiptLoading(false); setReceiptSelected(!!file); setReceiptInputError('');
    receiptInvalidRef.current = false; receiptInvalidMessageRef.current = '';
    if (!file) return;
    setReceiptLoading(true);
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('Receipt file is larger than 4 MiB. Remove receipts or choose a smaller file.');
      const text = decodeReceipts(new Uint8Array(await file.arrayBuffer()));
      if (token !== receiptReadRef.current) return;
      if (!text.trim()) throw new Error('The selected receipts file is empty. Remove receipts to verify the chain without witness evidence.');
      setReceiptText(text); setError('');
    } catch (cause) {
      if (token !== receiptReadRef.current) return;
      const message = cause?.message === 'The selected receipts file is empty. Remove receipts to verify the chain without witness evidence.' || cause?.message?.startsWith('Receipt file is larger')
        ? cause.message
        : 'Could not read the receipts file. Remove receipts or choose the file again to retry.';
      setReceiptText(''); setReceiptInputError(message); setError(message);
      receiptInvalidRef.current = true; receiptInvalidMessageRef.current = message;
    } finally { if (token === receiptReadRef.current) setReceiptLoading(false); }
  };
  const removeReceipts = () => {
    receiptReadRef.current++;
    invalidateCheck();
    setReceiptText(''); setReceiptLoading(false); setReceiptSelected(false); setReceiptInputError(''); setError('');
    receiptInvalidRef.current = false; receiptInvalidMessageRef.current = '';
    if (receiptInputRef.current) receiptInputRef.current.value = '';
  };

  const doMutation = async (kind) => {
    if (!result) return;
    const operation = runRef.current;
    const selectedResult = result;
    try {
      const { file, indexed, receipts, key, label } = selectedResult;
      const changed = await mutateFile(file, indexed, kind, {});
      if (operation !== runRef.current || selectedResult !== result) return;
      setTelemetry([]); setSelectedTelemetryIndex(null);
      await runVerify(changed.file, receipts, key, `${label} · ${changed.description}`);
      // The bounded mutation may be a Blob assembled from slices of the imported
      // OPFS-backed file. Keep that source alive until the whole session is cleared.
    } catch (cause) {
      setError(cause?.message || 'Could not prepare a bounded sandbox copy. Choose the file again and retry.');
    }
  };

  const loadRecord = useCallback(async (index, runId = runRef.current) => {
    const total = result ? Number(result.native.records) + Number(!!result.indexed.problem && result.indexed.problem.record === Number(result.native.records)) : 0;
    if (!result || index < 0 || index >= total) return;
    const token = ++recordRef.current;
    const telemetrySelection = telemetrySelectionRef.current;
    setSelectedRecord(index); setRecordError(''); setRecordDetail(null);
    try {
      const source = blobSource(result.file);
      const indexedRow = await recordAt(source, result.indexed, index);
      if (token !== recordRef.current || runId !== runRef.current) return;
      if (telemetrySelection === telemetrySelectionRef.current) {
        setSelectedTelemetryIndex((current) => current != null && Number(telemetry[current]?.record) === Number(index)
          ? current
          : nearestTelemetryIndex(telemetry, index, indexedRow.ts));
      }
      const row = await readRecord(source, indexedRow.offset);
      row.index = indexedRow.index;
      if (token !== recordRef.current || runId !== runRef.current) return;
      setRecordDetail(row);
    } catch {
      if (token !== recordRef.current || runId !== runRef.current) return;
      setRecordError(`Could not read record ${index}. Retry loading this record.`);
    }
  }, [result, telemetry]);

  useEffect(() => {
    if (result && (result.indexed.records > 0 || result.indexed.problem)) loadRecord(selectedRecord);
  }, [result, selectedRecord, loadRecord]);

  useEffect(() => {
    if (!result) { setPageRows([]); setFirstRecord(null); return; }
    const epoch = ++routeEpochRef.current;
    const source = blobSource(result.file);
    const controller = new AbortController();
    readIndexedRecords(source, result.indexed, page * PAGE_SIZE, PAGE_SIZE, { signal: controller.signal })
      .then((rows) => { if (epoch === routeEpochRef.current) setPageRows(rows); })
      .catch((cause) => { if (cause?.name !== 'AbortError' && epoch === routeEpochRef.current) setRecordError('Could not load this record page. Retry by changing pages.'); });
    recordAt(source, result.indexed, 0, { signal: controller.signal })
      .then((row) => { if (epoch === routeEpochRef.current) setFirstRecord(row); })
      .catch(() => { if (epoch === routeEpochRef.current) setFirstRecord(null); });
    return () => { controller.abort(); routeEpochRef.current++; };
  }, [result, page]);

  const runSeal = async () => {
    setTelemetry([]); setSelectedTelemetryIndex(null);
    receiptReadRef.current++; setReceiptLoading(false);
    invalidateCheck(); setResult(null); setRecordDetail(null); setSealOutput(null);
    const op = ++runRef.current;
    await disposeImportedOutput();
    if (op !== runRef.current) return;
    if (!sealFileInput) { setError('Choose a tab-separated timestamp and payload file first.'); return; }
    if (sealFileInput.size > SEAL_MAX_BYTES) { setError('The C++ sealer accepts source files up to 16 MiB.'); return; }
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    setBusy('Sealing the local TSV file…'); setError(''); setSealOutput(null);
    try {
      const sealed = await sealFile(sealFileInput, { every: Number(sealInterval), signal: controller.signal });
      if (op !== runRef.current) return;
      const output = { ...sealed, filename: sealFileInput.name };
      setSealOutput(output);
      setReceiptText(''); setReceiptSelected(false); setReceiptInputError('');
      receiptInvalidRef.current = false; receiptInvalidMessageRef.current = '';
      if (receiptInputRef.current) receiptInputRef.current.value = '';
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
    videoUrlRef.current = null; setVideoUrl(''); setVideoInfo(null);
    if (videoRef.current) { videoRef.current.removeAttribute('src'); videoRef.current.load(); }
  };
  const inspectVideo = (file) => {
    clearVideo();
    if (!file) return;
    const url = URL.createObjectURL(file); videoUrlRef.current = url;
    setVideoUrl(url);
    setVideoOffset('0');
    setVideoInfo({ url, name: file.name, size: file.size, state: 'Reading browser media metadata…' });
  };

  const resultTitle = result ? humanStatus(result.overallVerdict || result.native.verdict) : null;
  const evidenceSummary = result ? (result.needsTrustedKey
    ? 'Receipt signatures are unchecked because no trusted key was supplied.'
    : result.receiptChecks.length === 0
      ? 'No receipts were supplied; only the native hash chain was checked.'
      : result.receiptChecks.some((receipt) => receipt.check !== 'ok')
        ? 'One or more receipt checks are unverified or failed.'
        : 'The supplied receipt signatures were checked by the native verifier.') : '';
  const selectedTelemetryPoint = selectedTelemetryIndex == null ? null : telemetry[selectedTelemetryIndex];
  const selectedTimestamp = selectedTelemetryPoint?.timestampUs ?? recordDetail?.ts ?? null;
  const firstTimestamp = telemetry[0]?.timestampUs ?? firstRecord?.ts ?? null;
  const syncVideo = () => {
    const media = videoRef.current;
    const feedback = (message) => setVideoInfo((current) => current && ({ ...current, syncMessage: message }));
    if (!media || selectedTimestamp == null || firstTimestamp == null) {
      setError('Load a flight record and choose a local video before syncing.');
      return;
    }
    if (media.error || media.readyState < 1 || !Number.isFinite(media.duration)) {
      feedback('Wait for playable video metadata, or choose another clip. H.264/AAC MP4 is supported by most browsers.');
      return;
    }
    const offset = Number(videoOffset);
    const delta = asBig(selectedTimestamp) - asBig(firstTimestamp);
    if (!Number.isFinite(offset) || delta > BigInt(Number.MAX_SAFE_INTEGER) || delta < BigInt(Number.MIN_SAFE_INTEGER)) {
      feedback('The timestamp gap or offset cannot be aligned safely. Select a closer record and enter a finite offset.');
      return;
    }
    const target = Number(delta) / 1_000_000 + offset;
    if (!Number.isFinite(target) || target < 0 || target > media.duration) {
      feedback('The calculated time is outside this video. Adjust the manual offset.');
      return;
    }
    try {
      media.currentTime = target;
      feedback(`Video positioned at ${target.toFixed(3)} seconds for record ${fmtBig(selectedRecord)}${selectedTelemetryPoint ? ` using telemetry from record ${fmtBig(selectedTelemetryPoint.record)} at ${fmtBig(selectedTelemetryPoint.timestampUs)} µs` : ''}.`);
    } catch {
      feedback('This clip could not seek to the selected record. Reload the clip or convert it to H.264/AAC MP4.');
    }
  };
  const reportText = result ? [
    `HashWing verification report: ${result.label}`,
    `Engine: ${result.native.engine}`,
    `Native chain result: ${result.native.verdict.toUpperCase()} (${result.native.status})`,
    `Overall evidence status: ${(result.overallVerdict || result.native.verdict).toUpperCase()}`,
    `Application evidence: ${evidenceSummary}`,
    `Records checked: ${String(result.native.records)}`,
    `Good bytes: ${String(result.native.goodBytes)}`,
    `Head: ${result.native.head}`,
    `Time reversals: ${String(result.native.timeReversals)}`,
    `Receipt coverage: ${String(result.receiptCoverage?.covered ?? result.native.covered)} covered; ${String(result.receiptCoverage?.uncovered ?? result.native.uncovered)} uncovered`,
    ...(result.receiptChecks.length ? ['', 'Receipt checks:', ...result.receiptChecks.map((r, i) => `  ${i + 1}. after ${r.count}: ${r.description} [${r.check}]`)] : ['Receipts: none supplied']),
    ...(result.source ? ['', 'Imported source:', `  Format: ${result.source.format}`, `  Bytes: ${String(result.source.bytes)}`, `  SHA-256: ${result.source.sha256}`] : []),
    ...(result.indexed.problem ? ['', `First failure: ${problemLabel(result.indexed.problem.token)} (${result.indexed.problem.token}) at record ${result.indexed.problem.record}`, `Byte offset: ${result.indexed.problem.offset}`, ...(result.indexed.problem.expected != null ? [`Expected: ${String(result.indexed.problem.expected)}`] : []), ...(result.indexed.problem.actual != null ? [`Actual: ${String(result.indexed.problem.actual)}`] : []), result.indexed.problem.detail || ''] : []),
    '', 'This integrity result does not establish that recorded sensor data was true.',
  ].filter((line) => line !== undefined).join('\n') + '\n' : '';
  const reportJson = result ? JSON.stringify({
    engine: result.native.engine, nativeVerdict: result.native.verdict, overallVerdict: result.overallVerdict || result.native.verdict, status: result.native.status,
    records: String(result.native.records), goodBytes: String(result.native.goodBytes), head: result.native.head,
    covered: String(result.receiptCoverage?.covered ?? result.native.covered), uncovered: String(result.receiptCoverage?.uncovered ?? result.native.uncovered),
    receiptChecks: result.receiptChecks.map((r) => ({ ...r, count: String(r.count) })),
    source: result.source || null,
    firstFailure: result.indexed.problem ? { type: problemLabel(result.indexed.problem.token), token: result.indexed.problem.token, record: String(result.indexed.problem.record), offset: String(result.indexed.problem.offset), expected: result.indexed.problem.expected ?? null, actual: result.indexed.problem.actual ?? null } : null,
    report: reportText,
  }, null, 2) : '';
  const downloadPdf = async () => {
    if (!result) return;
    try {
      const { createIntegrityPdf, fingerprintPublicKey } = await import('./report-pdf.mjs');
      const fingerprint = await fingerprintPublicKey(result.key);
      const issue = result.indexed.problem;
      const pdf = await createIntegrityPdf({
        title: 'HashWing integrity report',
        lines: [
          `File: ${result.label}`,
          `Native engine: ${result.native.engine}`,
          `Native chain result: ${result.native.verdict.toUpperCase()} (${result.native.status})`,
          `Overall evidence status: ${(result.overallVerdict || result.native.verdict).toUpperCase()}`,
          `Records checked: ${String(result.native.records)}`,
          `Good bytes: ${String(result.native.goodBytes)}`,
          `Full chain head: ${result.native.head}`,
          `Public key SHA-256 fingerprint: ${fingerprint}`,
          `Receipt coverage: ${String(result.receiptCoverage?.covered ?? result.native.covered)} covered; ${String(result.receiptCoverage?.uncovered ?? result.native.uncovered)} uncovered`,
          '## Receipt checks',
          ...(result.receiptChecks.length ? result.receiptChecks.map((receipt) => `After ${receipt.count}: ${receipt.check} - ${receipt.description}; head ${receipt.head}; key ${receipt.key}`) : ['No receipts were supplied.']),
          ...(result.source ? ['## Imported source', `Format: ${result.source.format}`, `Bytes: ${String(result.source.bytes)}`, `Source SHA-256: ${result.source.sha256}`] : []),
          ...(issue ? ['## First failure', `Type: ${problemLabel(issue.token)} (${issue.token})`, `Record: ${String(issue.record)}`, `Byte offset: ${String(issue.offset)}`, ...(issue.expected != null ? [`Expected: ${String(issue.expected)}`] : []), ...(issue.actual != null ? [`Actual: ${String(issue.actual)}`] : []), issue.detail || ''] : ['First failure: none reported.']),
          'Receipt v1 has no signed issue timestamp.',
          'This integrity report is not a legal guarantee, court-admissible certificate, or claim that sensor data is true.',
        ],
      });
      download('hashwing-integrity-report.pdf', pdf, 'application/pdf');
    } catch (cause) {
      setError(cause?.message || 'Could not create the PDF report. Download the text or JSON report instead.');
    }
  };
  const totalRows = result ? Number(result.native.records) + Number(!!result.indexed.problem && result.indexed.problem.record === Number(result.native.records)) : 0;
  const pageCount = result ? Math.max(1, Math.ceil(totalRows / PAGE_SIZE)) : 1;
  const rowStart = page * PAGE_SIZE;
  const activeReceiptChecks = result?.receiptChecks || [];

  return <div className="app-shell">
    <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.querySelector('.commandbar h1')?.focus(); }}>Skip to content</a>
    <aside className="workbench-rail" aria-label="HashWing workspace">
      <a className="brand" href="#/sandbox" onClick={(e) => { e.preventDefault(); navigate('sandbox'); }}><span className="brand-mark" aria-hidden="true">H</span><span>HashWing</span></a>
      <div className="rail-heading">WORKSPACE</div>
      <nav id="primary-nav" className="nav" aria-label="Workbench sections">
        {NAV.map(([key, label, Icon]) => <a key={key} href={`#/${key}`} aria-current={screen === key ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate(key); }}><Icon size={16} strokeWidth={1.8} aria-hidden="true" />{label}</a>)}
      </nav>
      <div className="rail-foot"><span className="local-dot" aria-hidden="true" />Local processing</div>
    </aside>
    <div className="workspace">
    <header className="topbar commandbar">
      <h1 id={`page-${screen}`} tabIndex="-1">{titleFor(screen)}</h1>
      <div className="command-actions">
        <button className="button secondary command-file" type="button" onClick={() => workbenchFileRef.current?.click()} disabled={!!busy}><FileUp size={16} aria-hidden="true" />Choose file</button>
        <input id="workbench-file" ref={workbenchFileRef} className="visually-hidden" tabIndex="-1" aria-hidden="true" type="file" accept=".fseal,.ulg,.tsv,.txt,application/octet-stream,text/plain" onChange={(e) => { chooseWorkbenchFile(e.target.files?.[0] || null); e.target.value = ''; }} />
        <button className="button secondary command-seal" type="button" onClick={() => { if (sealFileInput) runSeal(); else tsvFileRef.current?.click(); }} disabled={!!busy}><FileCheck2 size={16} aria-hidden="true" />Seal new log</button>
        <input ref={tsvFileRef} className="visually-hidden" tabIndex="-1" aria-hidden="true" type="file" accept=".tsv,.txt,text/plain" onChange={(e) => { const file = e.target.files?.[0] || null; e.target.value = ''; if (file) { setSealFileInput(file); navigate('sandbox'); setError(''); } }} />
        {result && <button className="button primary command-export" type="button" onClick={downloadPdf} disabled={!!busy}>Export PDF</button>}
      </div>
    </header>
    <section className="session-strip" aria-label="Current session">
      <span className="session-name" title={result?.label || 'No file selected'}>{result?.label || logFile?.name || 'No active file'}</span>
      {result && <button type="button" className="hash-copy" title={`Copy full chain head ${result.native.head}`} onClick={async () => { try { await navigator.clipboard.writeText(result.native.head); setOperationStatus('Full chain head copied to clipboard.'); } catch { setError('Clipboard access is unavailable. Select the full hash in the report.'); } }}><span>Head</span><code>{`${result.native.head.slice(0, 10)}…${result.native.head.slice(-8)}`}</code></button>}
      {hasImportedOutput && <button type="button" className="clear-session" onClick={clearImportedSession}>Clear imported session</button>}
    </section>
    <main id="main" className="page-wrap">

      {error && <div role="alert" className="alert error-alert"><strong>Could not finish</strong><p>{error}</p><button type="button" className="button secondary" onClick={() => setError('')}>Dismiss</button></div>}
      {busy && <div className="busy-card" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" />{busy}<button className="button secondary" type="button" onClick={cancel}>Cancel</button></div>}
      {operationStatus && !busy && <p className="operation-status" role="status">{operationStatus}</p>}
      {offlineStatus && <p className="offline-note" role="status">{offlineStatus}</p>}

      {screen === 'sandbox' && <section className="screen" aria-label="Local flight workbench">
        <section className="sandbox-tools" aria-label="Local verification workspace">
          <div className="sample-toolbar"><strong>Load a sample</strong><button className="button primary" type="button" onClick={() => loadDemo(false)}>Load 800-record demo</button><button className="button secondary" type="button" onClick={() => loadDemo(true)}>Open 2,422-record PX4 example</button><button className="button secondary" type="button" onClick={() => loadDemo('full')}>Open full PX4 example (64,542 records · 28.9 MiB)</button><button className="button secondary" type="button" onClick={loadTelemetrySample}>Load telemetry sample</button><span className="sample-current"><span>Current</span><strong>{demoLabel || 'No sample loaded'}</strong>{result && <span>{fmtBig(result.native.records)} records · {fmtBytes(result.file.size)}</span>}</span><span className="trust-note">Files stay on this device.</span></div>
        </section>
        {demoLabel.includes('PX4') && <p className="sample-note">The PX4 example contains selected decoded records; it does not authenticate every byte of the original ULog. The bundled public key verifies this demonstration fixture only.{demoLabel.includes('full') && <> <a href="/flightseal/samples/px4-full-provenance.json">View source and sealing provenance</a>.</>}</p>}
        {result?.source && demoLabel.includes('Synthetic telemetry') && <p className="sample-note">This bundled ULog is synthetic. It demonstrates native telemetry decoding and is not flight evidence.</p>}
        {result && <ResultPanel result={result} resultTitle={resultTitle} reportText={reportText} onDownloadText={() => download('hashwing-verification-report.txt', reportText)} onDownloadJson={() => download('hashwing-verification-report.json', reportJson, 'application/json')} onNavigate={navigate} />}
        {result?.source && <FlightTelemetry source={result.source} points={telemetry} selectedPointIndex={selectedTelemetryIndex} onSelectPoint={(pointIndex) => { const point = telemetry[pointIndex]; if (!point) return; telemetrySelectionRef.current++; setSelectedTelemetryIndex(pointIndex); setSelectedRecord(Number(point.record)); setPage(Math.floor(Number(point.record) / PAGE_SIZE)); navigate('records'); }} />}
        <div className="section-grid">
          <section className="panel"><div className="panel-head"><FlaskConical aria-hidden="true" size={18} /><h2>Sandbox mutations</h2></div><div className="panel-body"><p>Each action creates a copy of the loaded log, changes only that copy, then runs the real native verifier.</p><div className="mutation-list"><button className="mutation" type="button" disabled={!result || !!busy} onClick={() => doMutation('flip')}><span>Flip one payload byte</span><small>Shows the first checksum or chain failure</small></button><button className="mutation" type="button" disabled={!result || !!busy} onClick={() => doMutation('delete')}><span>Remove one middle record</span><small>Shows where sequence checking stops</small></button><button className="mutation" type="button" disabled={!result || !!busy} onClick={() => doMutation('truncate')}><span>Trim seven tail bytes</span><small>Distinguishes a torn final record</small></button></div></div></section>
          <section className="panel"><div className="panel-head"><FileCheck2 aria-hidden="true" size={18} /><h2>Seal a new local file</h2></div><div className="panel-body"><p>Input rows use <code>timestamp_us&lt;TAB&gt;payload</code>. The native sealer creates a new log, witness receipts, and a public key.</p><label className="field-label" htmlFor="tsv-file">Timestamp and payload file</label><input id="tsv-file" type="file" accept=".tsv,.txt,text/plain" onChange={(e) => { invalidateCheck(); setSealFileInput(e.target.files?.[0] || null); setSealOutput(null); setError(''); }} /><label className="field-label" htmlFor="receipt-interval">Receipt every N records</label><input id="receipt-interval" type="number" min="1" max="1000000" value={sealInterval} onChange={(e) => { invalidateCheck(); setSealInterval(e.target.value); setSealOutput(null); }} /><button className="button primary" type="button" disabled={!sealFileInput || !!busy} onClick={runSeal}>Seal and verify</button>{sealOutput && <div className="seal-outputs"><button className="button secondary" onClick={() => download('sealed.fseal', sealOutput.log, 'application/octet-stream')}>Download sealed log</button><button className="button secondary" onClick={() => download('sealed.receipts', sealOutput.receipts)}>Download receipts</button><button className="button secondary" onClick={() => download('sealed-public-key.txt', sealOutput.publicKey + '\n')}>Download public key</button><p>Keep the public key and receipts through a separate witness. The private key is not returned.</p></div>}</div></section>
        </div>
      </section>}

      {screen === 'verify' && <section className="screen" aria-labelledby="verify-title"><div className="panel verify-panel"><div className="panel-head"><ShieldCheck aria-hidden="true" size={18} /><h2 id="verify-title">Choose local evidence</h2></div><div className="panel-body input-grid"><div><label className="field-label" htmlFor="log-input">HashWing / FlightSeal .fseal log <span>(up to {fmtBytes(MAX_UI_BYTES)})</span></label><input id="log-input" type="file" accept=".fseal,application/octet-stream" onChange={(e) => chooseLog(e.target.files?.[0] || null)} /></div><div><label className="field-label" htmlFor="receipt-input">Witness receipts <span>(optional)</span></label><input id="receipt-input" ref={receiptInputRef} type="file" accept=".receipts,text/plain" aria-invalid={receiptInputError ? 'true' : undefined} aria-describedby={receiptInputError ? 'receipt-input-error' : undefined} onChange={(e) => chooseReceipts(e.target.files?.[0] || null)} />{receiptLoading && <p className="field-hint" role="status">Reading the selected receipts locally…</p>}{receiptInputError && <p id="receipt-input-error" className="field-hint receipt-error">{receiptInputError}</p>}{receiptSelected && <button className="button secondary remove-receipts" type="button" onClick={removeReceipts}>Remove receipts</button>}</div><div className="field-wide"><label className="field-label" htmlFor="trusted-key">Trusted public key <span>(64 lowercase hexadecimal digits)</span></label><input id="trusted-key" className="mono-input" value={keyText} onChange={(e) => { invalidateCheck(); setKeyText(e.target.value); }} autoComplete="off" spellCheck="false" /></div><div className="field-wide actions-row"><button className="button primary" type="button" disabled={!logFile || logFile.size > MAX_UI_BYTES || receiptLoading || !!receiptInputError || !!busy} onClick={verifyPicked}>Run check</button><button className="button secondary" type="button" onClick={() => loadDemo(false)}>Load included 800-record demo</button></div></div></div>{result && <ResultPanel result={result} resultTitle={resultTitle} reportText={reportText} onDownloadText={() => download('hashwing-verification-report.txt', reportText)} onDownloadJson={() => download('hashwing-verification-report.json', reportJson, 'application/json')} onNavigate={navigate} />}</section>}

      {screen === 'records' && <section className="screen"><p className="lede">Every listed row comes from the checked file index. A selected row is read again from the local file.</p>{!result ? <EmptyState onNavigate={navigate} /> : <div className="records-layout"><section className="panel records-panel"><div className="panel-head"><List aria-hidden="true" size={18} /><h2>Checked records <span className="subcount">{fmtBig(result.native.records)}</span></h2></div><ol className="record-list">{pageRows.map((row, localIndex) => { const index = Number(row.index ?? rowStart + localIndex); const broken = !!result.indexed.problem && index === Number(result.indexed.problem.record); return <li key={index} className={`${broken ? 'record-broken' : 'record-pass'} ${index === selectedRecord ? 'selected' : ''}`}><button type="button" aria-current={index === selectedRecord ? 'true' : undefined} onClick={() => setSelectedRecord(index)}><span className="record-index">{fmtBig(index)}</span><span className="record-status">{broken ? `${problemLabel(result.indexed.problem.token)} (${result.indexed.problem.token})` : 'Checked'}</span><span className="record-bytes">{row.len == null ? 'problem row' : fmtBytes(row.len)}</span></button></li>; })}</ol><div className="pagination"><button className="button secondary" disabled={page === 0} onClick={() => setPage(0)}>First</button><button className="button secondary" disabled={page === 0} onClick={() => setPage((v) => Math.max(0, v - 1))}>Previous</button><span>Page {page + 1} of {pageCount}</span><button className="button secondary" disabled={page >= pageCount - 1} onClick={() => setPage((v) => Math.min(pageCount - 1, v + 1))}>Next</button><button className="button secondary" disabled={page >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>Last</button></div></section><section className="panel detail-panel" aria-labelledby="record-detail-title"><div className="panel-head"><FileCheck2 aria-hidden="true" size={18} /><h2 id="record-detail-title">Record {fmtBig(selectedRecord)}</h2></div><div className="panel-body">{recordError ? <div role="alert" className="alert error-alert"><p>{recordError}</p><button className="button secondary" onClick={() => loadRecord(selectedRecord)}>Retry</button></div> : !recordDetail ? <p className="muted" role="status">Loading record…</p> : <><div className="detail-actions"><button className="button secondary" type="button" onClick={() => navigate('video')}>Jump to Video sync</button></div><RecordDetail record={recordDetail} /></>}</div></section></div>}</section>}

      {screen === 'receipts' && <section className="screen"><p className="lede">Receipts are checked by the C++ engine against the independently entered key. The rows below show counts and head links, never log payloads.</p>{!result ? <EmptyState onNavigate={navigate} /> : <section className="panel"><div className="panel-head"><Stamp aria-hidden="true" size={18} /><h2>Receipt register</h2></div><p className="receipt-overview">{fmtBig(result.receiptCoverage?.covered ?? result.native.covered)} records covered by a trusted receipt · {fmtBig(result.receiptCoverage?.uncovered ?? result.native.uncovered)} uncovered</p>{result.needsTrustedKey && <p className="muted">The native result below covers the hash chain only. Receipt signatures remain unchecked until a trusted public key is entered.</p>}{activeReceiptChecks.length ? <div className="table-scroll"><table><thead><tr><th scope="col">Receipt</th><th scope="col">After records</th><th scope="col">Check</th><th scope="col">Head</th><th scope="col">Signing key</th></tr></thead><tbody>{activeReceiptChecks.map((receipt, i) => <tr key={`${receipt.count}-${i}`}><td>{i + 1}</td><td className="numeric">{fmtBig(receipt.count)}</td><td><span className={`status-label ${receipt.check === 'ok' ? 'ok' : receipt.check === 'wrong-key' || receipt.check === 'bad-signature' ? 'bad' : 'warn'}`}>{receipt.description}</span></td><td><code>{receipt.head}</code></td><td><code>{receipt.key}</code></td></tr>)}</tbody></table></div> : <div className="panel-body"><p>{result.receipts ? 'No receipts were authenticated in this run.' : 'No receipts were provided. Load the demo or add a receipts file and trusted key.'}</p></div>}</section>}</section>}

      {screen === 'video' && <section className="screen"><p className="lede">Choose a local clip and align it manually to the selected record. Flight timestamps may be boot-relative or untrusted; this is a playback aid, not proof of provenance.</p><section className="panel"><div className="panel-head"><Video aria-hidden="true" size={18} /><h2>Video sync</h2></div><div className="panel-body video-grid"><label className="field-label" htmlFor="video-input">Choose a local video</label><input id="video-input" type="file" accept="video/*" onChange={(e) => inspectVideo(e.target.files?.[0] || null)} /><video ref={videoRef} src={videoUrl || undefined} controls playsInline aria-label="Selected local video preview" onLoadedMetadata={(e) => { const media = e.currentTarget; const url = videoUrlRef.current; const metadata = { duration: media.duration, width: media.videoWidth, height: media.videoHeight }; if (!url || media.currentSrc !== url) return; setVideoInfo((v) => v && v.url === url ? { ...v, ...metadata, state: 'Browser metadata available. Codec identification is unknown.' } : v); }} onCanPlay={() => setVideoInfo((v) => v && ({ ...v, playable: true }))} onError={() => setVideoInfo((v) => v && ({ ...v, playable: false, state: 'The browser could not read metadata or play this stream. Codec identification is unknown.' }))} />{result && <div className="video-sync-controls"><label className="field-label" htmlFor="video-record-range">Select record for video alignment</label><input id="video-record-range" type="range" min="0" max={Math.max(0, totalRows - 1)} value={Math.min(selectedRecord, Math.max(0, totalRows - 1))} disabled={totalRows < 2} onChange={(e) => { const next = Number(e.target.value); setSelectedRecord(next); setPage(Math.floor(next / PAGE_SIZE)); }} /><p><strong>Selected record {fmtBig(selectedRecord)}</strong>{selectedTelemetryPoint ? ` · telemetry from record ${fmtBig(selectedTelemetryPoint.record)} at ${fmtBig(selectedTelemetryPoint.timestampUs)} µs` : selectedTimestamp == null ? ' · timestamp unavailable' : ` · ${fmtBig(selectedTimestamp)} µs`}{selectedTelemetryPoint?.sourceOffset == null ? '' : ` · source byte ${selectedTelemetryPoint.sourceOffset}`}</p><p>Time base: {firstTimestamp == null ? 'unavailable' : `${fmtBig(firstTimestamp)} µs at first telemetry sample`}</p><label className="field-label" htmlFor="video-offset">Manual offset (seconds)</label><input id="video-offset" type="number" step="any" value={videoOffset} onChange={(e) => setVideoOffset(e.target.value)} /><button className="button primary" type="button" disabled={!videoInfo?.duration || selectedTimestamp == null || firstTimestamp == null} onClick={syncVideo}>Sync to selected record</button></div>}{videoInfo && <div className="video-meta" role="status"><strong>{videoInfo.name}</strong><span>{fmtBytes(videoInfo.size)}</span>{videoInfo.duration != null && <span>{Number.isFinite(videoInfo.duration) ? `${videoInfo.duration.toFixed(2)} seconds` : 'Duration unavailable'}</span>}{videoInfo.width && <span>{videoInfo.width} × {videoInfo.height} pixels</span>}<p>{videoInfo.state}</p>{videoInfo.syncMessage && <p>{videoInfo.syncMessage}</p>}<p>Video bytes stay local. No codec name is inferred when the browser does not expose one.</p></div>}{!result && <p className="muted">Verify or load a flight record before syncing a clip.</p>}</div></section></section>}

      {screen === 'help' && <section className="screen help-layout"><section className="panel"><div className="panel-head"><CircleHelp aria-hidden="true" size={18} /><h2>What a result means</h2></div><div className="panel-body prose"><h3>File compatibility</h3><p>HashWing reads .fseal logs, FlightSeal witness receipt v1 files, and supported PX4 ULog captures. New sealed output remains compatible with existing FlightSeal .fseal tooling.</p><h3>Integrity and authenticity are different.</h3><p>An intact result means this file agrees with its own hash chain. With receipts, the native verifier checks signed checkpoints against the public key you enter. Neither result proves that sensor data was true when recorded or that every byte of the original PX4 ULog was preserved. The PX4 examples contain selected decoded records; they do not authenticate every byte of the original ULog.</p><h3>Keep the witness separate.</h3><p>Receipts protect against a shortened or rebuilt log only when someone other than the log holder kept them. Confirm the public key with that witness through a separate channel.</p><h3>Read the first failure.</h3><p>Verification stops at the first record that cannot be trusted. A hash-chain break locates the first inconsistent link, not every changed record. A torn tail may reflect a writer interruption; other failures require investigation. HashWing does not repair or overwrite the supplied file.</p><h3>Navigation</h3><p>Use the workspace rail with Tab and Enter. Route changes move focus to the page heading.</p><h3>Local limits.</h3><p>Files and payloads stay in this browser. Reports contain verdicts, counts and hashes, not record payloads. This is an AI-assisted project; generated code and documentation require human review.</p><p><a href="https://github.com/anirudh763/flightseal" target="_blank" rel="noreferrer">Review source and report an issue on GitHub</a></p></div></section><section className="panel limits-panel"><div className="panel-head"><h2>Current browser boundaries</h2></div><div className="panel-body"><dl><dt>Verify file size</dt><dd>{fmtBytes(MAX_UI_BYTES)}</dd><dt>Native import limit</dt><dd>{fmtBytes(IMPORT_MAX_BYTES)}</dd><dt>Seal source file</dt><dd>16 MiB</dd><dt>Receipt text</dt><dd>4 MiB</dd><dt>Record paging</dt><dd>50 rows per view with sparse checkpoints</dd><dt>Telemetry plot</dt><dd>At most 1,000 visually sampled points</dd><dt>Payload display</dt><dd>First 4 KiB per selected record</dd></dl></div></section></section>}
    </main>
    <footer className="footer"><span>HashWing · local browser workspace</span><span>Integrity does not establish sensor truth.</span></footer>
    </div>
  </div>;
}

function EmptyState({ onNavigate }) { return <div className="empty-state"><h2>No verified file yet</h2><p>Choose a local file to inspect its integrity and available evidence.</p><button className="button primary" onClick={() => onNavigate('sandbox')}>Open workbench</button></div>; }
function FlightTelemetry({ source, points, selectedPointIndex, onSelectPoint }) {
  const maxDisplayPoints = 1000;
  const stride = Math.max(1, Math.ceil(points.length / maxDisplayPoints));
  const displayPoints = [];
  for (let index = 0; index < points.length; index++) {
    if (index % stride === 0 || index === selectedPointIndex) displayPoints.push({ point: points[index], index });
  }
  const gps = displayPoints.filter(({ point }) => Number.isFinite(point.latitudeDeg) && Number.isFinite(point.longitudeDeg));
  const extent = (rows, field) => rows.reduce((bounds, entry) => ({
    min: Math.min(bounds.min, entry.point[field]), max: Math.max(bounds.max, entry.point[field]),
  }), { min: Infinity, max: -Infinity });
  const gpsLat = gps.length ? extent(gps, 'latitudeDeg') : null;
  const gpsLon = gps.length ? extent(gps, 'longitudeDeg') : null;
  const gx = (value) => gpsLon && gpsLon.max !== gpsLon.min ? 18 + (value - gpsLon.min) / (gpsLon.max - gpsLon.min) * 444 : 240;
  const gy = (value) => gpsLat && gpsLat.max !== gpsLat.min ? 86 - (value - gpsLat.min) / (gpsLat.max - gpsLat.min) * 68 : 52;
  const gpsPath = gps.map(({ point }, index) => `${index ? 'L' : 'M'} ${gx(point.longitudeDeg).toFixed(1)} ${gy(point.latitudeDeg).toFixed(1)}`).join(' ');
  const selectedGps = gps.find(({ index }) => index === selectedPointIndex);
  const series = [
    ['Altitude', 'altitudeM', 'm'], ['Speed', 'speedMps', 'm/s'], ['Battery', 'batteryV', 'V'],
  ].map(([label, field, unit]) => ({ label, field, unit, rows: displayPoints.filter(({ point }) => Number.isFinite(point[field])) }));
  const sampleX = (index, count) => count > 1 ? 20 + index / (count - 1) * 440 : 240;
  const positionsFor = ({ rows, field }) => {
    const bounds = extent(rows, field);
    return rows.map(({ point, index }, rowIndex) => ({
      point, index, x: sampleX(rowIndex, rows.length),
      y: 82 - (bounds.max !== bounds.min ? (point[field] - bounds.min) / (bounds.max - bounds.min) * 64 : 32),
    }));
  };
  if (!points.length) return <section className="telemetry-panel" aria-labelledby="telemetry-title"><div className="panel-head"><MapPin aria-hidden="true" size={17} /><h2 id="telemetry-title">Flight telemetry</h2></div><SourceMetadata source={source} /><p className="telemetry-empty">No native telemetry fields are available for this verified file.</p></section>;
  const selectedPoint = selectedPointIndex == null ? null : points[selectedPointIndex];
  const pointControl = (index, label) => ({
    role: 'button', tabIndex: 0, 'aria-label': label, 'data-telemetry-index': index,
    onClick: () => onSelectPoint(index),
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectPoint(index); }
    },
  });
  return <section className="telemetry-panel" aria-labelledby="telemetry-title">
    <div className="panel-head"><MapPin aria-hidden="true" size={17} /><h2 id="telemetry-title">Flight telemetry</h2><span className="subcount">{points.length.toLocaleString()} decoded points</span></div>
    <p className="telemetry-note">Values follow supported PX4 field types and unit conventions; custom units and sensor accuracy are not verified. Missing fields are not inferred. Plots show at most 1,000 sampled points; several points can share one source record with chunk-level integrity checks.</p>
    <SourceMetadata source={source} />
    <div className="telemetry-grid">
      <section className="telemetry-plot" aria-labelledby="gps-heading"><h3 id="gps-heading">GPS path <small>offline · latitude / longitude</small></h3>{gps.length ? <svg className="gps-plot" viewBox="0 0 480 104" role="group" aria-label={`${gps.length} visually sampled GPS points plotted offline`}><path d={gpsPath} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />{gps.map(({ point, index }) => <circle {...pointControl(index, `Select GPS point at record ${point.record}, ${point.timestampUs} microseconds`)} key={index} cx={gx(point.longitudeDeg)} cy={gy(point.latitudeDeg)} r={index === selectedPointIndex ? 5 : 2.5} className={index === selectedPointIndex ? 'selected-dot' : ''}><title>Record {point.record}: {point.latitudeDeg}, {point.longitudeDeg} at {point.timestampUs} µs</title></circle>)}{selectedGps && <text x={gx(selectedGps.point.longitudeDeg) + 8} y={gy(selectedGps.point.latitudeDeg) - 8}>Selected {selectedGps.point.timestampUs} µs</text>}</svg> : <p className="plot-empty">GPS coordinates are not present in the decoded telemetry.</p>}</section>
      <div className="series-plots">{series.map((item) => {
        const positions = positionsFor(item);
        const path = positions.map(({ x, y }, index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
        return <section className="telemetry-plot series-plot" key={item.field} aria-label={`${item.label} telemetry`}><h3>{item.label} <small>{item.unit}</small></h3>{item.rows.length ? <svg viewBox="0 0 480 100" role="group" aria-label={`${item.rows.length} ${item.label.toLowerCase()} samples by sample order`}><path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />{positions.map(({ point, index, x, y }) => <circle {...pointControl(index, `Select ${item.label.toLowerCase()} sample at record ${point.record}, ${point.timestampUs} microseconds`)} key={index} cx={x} cy={y} r={index === selectedPointIndex ? 4.5 : 2.2} className={index === selectedPointIndex ? 'selected-dot' : ''}><title>Record {point.record}: {point[item.field]} {item.unit} at {point.timestampUs} µs</title></circle>)}</svg> : <p className="plot-empty">No decoded {item.label.toLowerCase()} values.</p>}</section>;
      })}</div>
    </div>
    <div className="telemetry-selection"><label htmlFor="telemetry-point">Selected telemetry point</label><select id="telemetry-point" value={selectedPointIndex ?? ''} onChange={(event) => onSelectPoint(Number(event.target.value))}><option value="" disabled>Select a telemetry point</option>{displayPoints.map(({ point, index }) => <option key={index} value={index}>Record {point.record} · {point.timestampUs} µs{point.sourceOffset == null ? '' : ` · source byte ${point.sourceOffset}`}</option>)}</select>{selectedPoint && <span>Record {selectedPoint.record} · {selectedPoint.timestampUs} µs{selectedPoint.sourceOffset == null ? '' : ` · source byte ${selectedPoint.sourceOffset}`}</span>}<button type="button" className="button secondary" disabled={!selectedPoint} onClick={() => selectedPoint && onSelectPoint(selectedPointIndex)}>Inspect selected point</button></div>
  </section>;
}
function SourceMetadata({ source }) { return <dl className="source-metadata"><dt>Source</dt><dd>{source.format} · {fmtBytes(source.bytes)} · SHA-256 <code>{source.sha256}</code></dd></dl>; }
function RecordDetail({ record }) {
  const payload = record.payload || new Uint8Array();
  const flightRaw = new TextDecoder().decode(payload.subarray(0, 8)) === 'FSRAW001';
  const preview = flightRaw ? Array.from(payload.subarray(0, 64), (byte) => byte.toString(16).padStart(2, '0')).join(' ') : new TextDecoder().decode(payload.subarray(0, 4096)) || '(empty)';
  return <><dl className="detail-grid"><dt>File offset</dt><dd className="numeric">{fmtBig(record.offset)}</dd><dt>Payload length</dt><dd>{fmtBytes(record.length)}</dd><dt>Raw sequence</dt><dd className="numeric">{record.seq == null ? 'Missing' : fmtBig(record.seq)}</dd><dt>Timestamp</dt><dd className="numeric">{record.ts == null ? 'Missing' : `${fmtBig(record.ts)} µs`}</dd><dt>Stored link</dt><dd><code>{record.link || 'Unavailable'}</code></dd><dt>Stored CRC-32</dt><dd><code>{record.crc || 'Unavailable'}</code></dd></dl><h3>{flightRaw ? 'Source payload bytes · FSRAW001' : 'Payload excerpt'}</h3>{flightRaw && <p className="field-hint">This record preserves original source bytes. Telemetry is a separate native projection.</p>}<pre className="payload mono">{preview}</pre></>;
}
function ResultPanel({ result, resultTitle, reportText, onDownloadText, onDownloadJson, onNavigate }) {
  const { native, indexed } = result;
  const [label, kind] = resultTitle;
  const problem = indexed.problem;
  const overallVerdict = result.overallVerdict || native.verdict;
  const nativeChainVerdict = native.status === 'intact' ? 'intact' : native.status === 'torn-tail' ? 'incomplete' : 'tampered';
  const chainDiffers = nativeChainVerdict !== overallVerdict;
  const nativeChainCondition = humanStatus(native.status === 'intact' ? 'intact' : native.status)[0];
  const applicationEvidence = result.needsTrustedKey ? 'Receipt signatures unchecked: trusted key missing.' : result.receiptChecks.length === 0 ? 'No receipts supplied; only the native hash chain was checked.' : result.receiptChecks.some((receipt) => receipt.check !== 'ok') ? 'Receipt evidence needs review.' : 'Supplied receipt signatures checked by the native verifier.';
  const summary = chainDiffers
    ? `Native chain: ${nativeChainCondition}. Application evidence: ${applicationEvidence}`
    : native.status === 'intact'
      ? `${fmtBig(native.records)} records checked; ${fmtBig(result.receiptCoverage?.covered ?? native.covered)} receipt-covered; ${fmtBig(result.receiptCoverage?.uncovered ?? native.uncovered)} uncovered; ${fmtBig(native.timeReversals)} timestamp reversals. ${applicationEvidence}`
      : native.description || indexed.description || 'The first failure is shown below.';
  return <section className="result-panel panel" aria-labelledby="result-heading"><div className="result-top"><div><p className="eyebrow">VERIFICATION RESULT</p><h2 id="result-heading"><span className={`status-shape ${kind}`} aria-hidden="true" />{label}</h2><p>{summary}</p></div><div className="result-stat"><strong>{fmtBig(native.records)}</strong><span>records checked</span></div></div><div className="stats-grid"><div><span>File</span><strong className="wrap">{result.label}</strong></div><div><span>Size</span><strong>{fmtBytes(result.file.size)}</strong></div><div><span>Good bytes</span><strong>{fmtBytes(native.goodBytes)}</strong></div><div><span>Chain head</span><code title={native.head}>{native.head.slice(0, 10)}…{native.head.slice(-8)}</code></div><div><span>Receipt coverage</span><strong>{fmtBig(result.receiptCoverage?.covered ?? native.covered)} covered · {fmtBig(result.receiptCoverage?.uncovered ?? native.uncovered)} uncovered</strong></div><div><span>Time reversals</span><strong>{fmtBig(native.timeReversals)}</strong></div></div>{problem && <div className={`first-failure ${kind}`}><span className="eyebrow">FIRST FAILURE</span><strong>Record {fmtBig(problem.record)} · {problemLabel(problem.token)} <code>({problem.token})</code></strong><span>{problem.detail || problem.description || 'Verification stopped at this first inconsistent record.'}</span>{problem.expected != null && <div className="hash-comparison"><span>Expected</span><code>{String(problem.expected)}</code>{problem.actual != null && <><span>Actual</span><code>{String(problem.actual)}</code></>}</div>}<span>Offset {fmtBig(problem.offset)} bytes</span></div>}<div className="result-actions"><button className="button secondary" onClick={() => onNavigate('records')}>Inspect records</button><button className="button secondary" onClick={() => onNavigate('receipts')}>Review receipts</button><button className="button secondary" onClick={onDownloadText}>Download text report</button><button className="button secondary" onClick={onDownloadJson}>Download JSON</button></div><details className="report-details" aria-label="Text verification report"><summary><span>Text verification report</span><ChevronDown size={17} aria-hidden="true" /></summary><pre className="report-text">{reportText}</pre></details></section>;
}

createRoot(document.getElementById('root')).render(<App />);
