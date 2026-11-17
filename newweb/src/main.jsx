import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowRight, Check, Copy, Download, Gauge, ChevronDown, CircleHelp, FileCheck2, FileLock2, FileUp, Mail, FlaskConical, List, LockKeyhole, LogIn, MapPin, Menu, Pause, Play, ShieldCheck, Stamp, UserRound, Video } from 'lucide-react';
import { hashFile, importFile, IMPORT_MAX_BYTES, VERIFY_MAX_BYTES, verifyFile, sealFile, SEAL_MAX_BYTES, recoverTemporaryOutputs } from '../../docs/wasm/client.mjs';
import { compareFiles, encodeManifest, MANIFEST_LIMITS, MANIFEST_STATUS, manifestHandoverText, manifestRecordsBlob, newSalt, verifySealedManifest } from '../../docs/manifest.mjs';
import { blobSource, checkReceipts, decodeReceipts, parseHex, parseReceipts, readRecord, scanLog, summarize } from '../../docs/verifier.js';
import { mutateFile, readIndexedRecords, recordAt } from '../../docs/records.mjs';
import { parseLocation, parseRouteHash, productHref, routeHash, safeReturnRoute } from './routes.mjs';
import {
  announceLocalLogout, authenticateLocalProfile, clearLocalSession, createLocalProfile, getLocalSession,
  listLocalProfiles, readWorkspaceContext, removeLocalProfile, removeWorkspaceContext, saveWorkspaceContext, setLocalSession,
  subscribeToLocalLogout,
} from './local-auth.mjs';
import './style.css';
import './server-workspace.js';
import './server-workspace.css';
import { BenchmarkPage, SystemPage } from './product-pages.jsx';
import { SUITE_LINKS } from './suite.mjs';
import { FeedbackDialog, FooterLinks, InstallGuide, LegalPage, QuickStart, ShareDialog } from './pwa-ui.jsx';
import { detectInstallKind, invokeInstallPrompt, invokeNativeShare } from './platform.mjs';
import { convertTelemetryFile, inspectCsvFile } from './telemetry-import.mjs';
import { fileToRecords, handoverText, parseHandover, recordsToFile, RAW_MAX_BYTES } from '../../docs/rawfile.js';
import { generateEd25519SigningKey, validateEd25519PrivateKey } from './signing-keys.mjs';
import { createStoreZip } from './zip-store.mjs';
import { deliverEarlyAccessRequest } from './early-access.mjs';
import { createEncryptedProfileBackup, inspectEncryptedProfileBackup, commitBackupRestore, previewBackupRestore } from './profile-backup.mjs';
import { createSyncProvider } from './sync-provider.mjs';
import { listTrustedKeys, pinTrustedKey } from './trusted-keys.mjs';

const syncProvider = createSyncProvider({ supabaseUrl: import.meta.env.VITE_SUPABASE_URL, supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY });

const MAX_UI_BYTES = VERIFY_MAX_BYTES;
const PAGE_SIZE = 50;
function closeDisclosure(event) {
  if (event.key !== 'Escape' || !event.currentTarget.open) return; // a closed disclosure lets Escape reach the mobile menu
  event.preventDefault(); event.stopPropagation();
  event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus();
}
const PRIMARY_NAV = [['protect', 'Seal & send', FileLock2], ['verify', 'Verify', ShieldCheck], ['records', 'Records', List], ['receipts', 'Receipts', Stamp], ['help', 'Trust', CircleHelp]];
const MORE_NAV = [['sandbox', 'Samples', FlaskConical], ['video', 'Video', Video], ['benchmarks', 'Benchmarks', Gauge], ['system', 'System', Activity]];
const NAV = [...PRIMARY_NAV, ...MORE_NAV];
const CANONICAL_NAV = [['overview','Overview',Gauge],['workbench','Workbench',FlaskConical],['reports','Reports',List],['settings','Settings',Activity]];
const asBig = (value) => typeof value === 'bigint' ? value : BigInt(value ?? 0);
const csvMappingSummary = (mapping) => Object.entries(mapping || {}).filter(([key, value]) => key.endsWith('Column') && value).map(([key, value]) => {
  const field = key.slice(0, -6);
  const unit = mapping[`${field}Unit`];
  return `${field}: “${value}”${unit ? ` (${unit})` : ''}`;
}).join('; ');
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
const titleFor = (screen) => ({ landing: 'HashWing', signup: 'Create account', login: 'Log in', privacy: 'Privacy', terms: 'Terms of Use', security: 'Security & Offline Data', 'not-found': 'Page not found' }[screen] || NAV.find(([key]) => key === screen)?.[1] || 'Not found');
const loginHash = (returnTo = '') => `#/login${returnTo ? `?returnTo=${encodeURIComponent(safeReturnRoute(returnTo))}` : ''}`;
function activeLocalSession() {
  try { return getLocalSession(); } catch { return null; }
}
function localProfileFor(session) {
  if (session?.kind !== 'account') return null;
  try {
    const profile = listLocalProfiles().find((entry) => entry.id === session.userId);
    return profile ? { id: profile.id, email: profile.email } : null;
  }
  catch { return null; }
}

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
  const [route, setRoute] = useState(() => parseLocation(location));
  const screen = route.screen;
  const productMode = !location.pathname.startsWith('/flightseal/') && location.pathname !== '/console/';
  const canonicalPage = productMode ? route.canonical : null;
  const pageTitle = canonicalPage ? CANONICAL_NAV.find(([key])=>key===canonicalPage)?.[1] : route.direct ? ({sandbox:'Flight Log Uploader and Sealer',verify:'Tamper and Ed25519 Receipt Auditor',benchmarks:'Crash-Safety and Throughput Explorer',system:'Health and Metrics'}[screen]||titleFor(screen)) : titleFor(screen);
  const workspaceHref = (target, params = {}) => productMode ? productHref(target, params) : routeHash(target, params);
  const [activeSession, setActiveSession] = useState(activeLocalSession);
  const [localProfile, setLocalProfile] = useState(() => localProfileFor(activeLocalSession()));
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef(null);
  // Set the DOM directly: a <details> toggle event arrives late, so a mirrored state value can be stale.
  useLayoutEffect(() => { if (moreRef.current) moreRef.current.open = MORE_NAV.some(([key]) => key === screen); }, [screen]); // opens on a secondary page, tidies away on a primary one
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
  const [sealSourceMetadata, setSealSourceMetadata] = useState(null);
  const [protectFile, setProtectFile] = useState(null);
  const [protectMode, setProtectMode] = useState('embedded');
  const [manifestActive, setManifestActive] = useState(false);
  const [protectSealed, setProtectSealed] = useState(null);
  const [checkFile, setCheckFile] = useState(null);
  const [checkText, setCheckText] = useState('');
  const [protectResult, setProtectResult] = useState(null);
  const [restored, setRestored] = useState(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [sealSourceOriginal, setSealSourceOriginal] = useState(null);
  const [csvDraft, setCsvDraft] = useState(null);
  const [signingKey, setSigningKey] = useState(null);
  const [sealInterval, setSealInterval] = useState(1000);
  const [sealOutput, setSealOutput] = useState(null);
  const [sealOutputAcknowledged, setSealOutputAcknowledged] = useState(false);
  const [videoInfo, setVideoInfo] = useState(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoOffset, setVideoOffset] = useState('0');
  const [demoLabel, setDemoLabel] = useState('');
  const [operationStatus, setOperationStatus] = useState('');
  const [offlineStatus, setOfflineStatus] = useState('');
  const [offlineReady, setOfflineReady] = useState(false);
  const [waitingUpdate, setWaitingUpdate] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [privateResetVersion, setPrivateResetVersion] = useState(0);
  const [serviceWorkerRegistration, setServiceWorkerRegistration] = useState(null);
  const [currentSample, setCurrentSample] = useState(null);
  const [demoScenario, setDemoScenario] = useState(() => route.sample === 'byte-flip' ? 'byte-flip' : 'intact');
  const demoGuardRef = useRef(null);
  demoGuardRef.current = { sealOutput, sealOutputAcknowledged, logFile, receiptSelected, currentSample };
  const [profileMenuMessage, setProfileMenuMessage] = useState('');
  const [savedContext, setSavedContext] = useState(null);
  const [savedContextError, setSavedContextError] = useState('');
  const [quickStartDismissed, setQuickStartDismissed] = useState(false);
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
  const sealPickerRef = useRef(false);
  const importDisposeRef = useRef(null);
  const focusedRouteRef = useRef(null);
  const mutationFocusRef = useRef(null);
  const initialLegacyLoadedRef = useRef(false);
  const legacyGuestInitializedRef = useRef(false);
  const authEpochRef = useRef(0);
  const signingKeyReadRef = useRef(0);
  const workspaceScreenRef = useRef('sandbox');
  const authAttemptRef = useRef({ mode: null, email: null });
  const updateSafeRef = useRef(true);
  updateSafeRef.current = !busy && !manifestActive && !(sealOutput && !sealOutputAcknowledged);

  const navigate = useCallback((next, options = {}) => {
    const routeName = [...NAV,...CANONICAL_NAV].some(([key]) => key === next) ? next : 'not-found';
    const params = {
      sample: options.sample === undefined ? currentSample : options.sample,
      record: options.record === undefined ? selectedRecord : options.record,
    };
    const nextUrl = productMode ? productHref(routeName, params) : routeHash(routeName, params);
    history.pushState(null, '', nextUrl);
    setRoute(parseLocation(location));
    setMenuOpen(false);
    setError('');
    setOperationStatus('');
  }, [currentSample, selectedRecord, productMode]);

  useEffect(() => {
    const onInstallPrompt = (event) => { event.preventDefault(); setInstallPrompt(event); };
    addEventListener('beforeinstallprompt', onInstallPrompt);
    return () => removeEventListener('beforeinstallprompt', onInstallPrompt);
  }, []);

  useEffect(() => {
    const update = () => {
      setRoute(parseLocation(location));
      setMenuOpen(false);
    };
    addEventListener('hashchange', update);
    addEventListener('popstate', update);
    return () => { removeEventListener('hashchange', update); removeEventListener('popstate', update); };
  }, []);

  useEffect(() => {
    if (activeSession?.kind !== 'account') { setSavedContext(null); setSavedContextError(''); return; }
    try { setSavedContext(readWorkspaceContext(activeSession.userId)); setSavedContextError(''); }
    catch (cause) { setSavedContext(null); setSavedContextError(cause?.message || 'Saved view data is invalid. Remove it before saving another view.'); }
  }, [activeSession?.kind, activeSession?.userId]);

  useEffect(() => {
    const scope = activeSession?.kind === 'account' ? `profile_${activeSession.userId}` : `guest_${activeSession?.userId || 'anonymous'}`;
    try { setQuickStartDismissed(localStorage.getItem(`flightseal_quickstart_${scope}_v1`) === 'dismissed'); }
    catch { setQuickStartDismissed(false); }
  }, [activeSession?.kind, activeSession?.userId]);

  useEffect(() => { if (route.kind === 'workspace') workspaceScreenRef.current = route.screen; }, [route.kind, route.screen]);

  useEffect(() => {
    if (!sealOutput || sealOutputAcknowledged) return undefined;
    const warnBeforeUnload = (event) => { event.preventDefault(); event.returnValue = ''; };
    addEventListener('beforeunload', warnBeforeUnload);
    return () => removeEventListener('beforeunload', warnBeforeUnload);
  }, [sealOutput, sealOutputAcknowledged]);

  useEffect(() => {
    const input = workbenchFileRef.current;
    if (!input) return undefined;
    const resetSealPickerIntent = () => { sealPickerRef.current = false; };
    input.addEventListener('cancel', resetSealPickerIntent);
    return () => input.removeEventListener('cancel', resetSealPickerIntent);
  }, [route.kind]);

  useEffect(() => {
    document.title = `${pageTitle} · HashWing`;
    if (focusedRouteRef.current !== null && focusedRouteRef.current !== route.route) {
      requestAnimationFrame(() => document.getElementById(`page-${screen}`)?.focus());
    }
    focusedRouteRef.current = route.route;
  }, [screen, route.route, pageTitle]);

  useEffect(()=>{
    if(!menuOpen)return;
    const close=event=>{if(event.key==='Escape'&&!event.defaultPrevented){setMenuOpen(false);document.querySelector('.rail-menu')?.focus();event.preventDefault();}};
    addEventListener('keydown',close);document.querySelector('#primary-nav a')?.focus();return()=>removeEventListener('keydown',close);
  },[menuOpen]);

  useLayoutEffect(() => {
    if (busy) return;
    const restore = mutationFocusRef.current;
    mutationFocusRef.current = null;
    restore?.();
  }, [busy, result, error]);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      mutationFocusRef.current?.(false);
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
    setOfflineStatus('Checking offline readiness…');
    let active = true;
    const requestOfflineStatus = (worker=navigator.serviceWorker.controller) => worker?.postMessage({ type: 'GET_OFFLINE_STATUS' });
    const onControllerChange = () => { setWaitingUpdate(false); requestOfflineStatus(); };
    const onWorkerMessage = ({ data, ports }) => {
      if (data?.type === 'flightseal-cache-warning') setOfflineStatus('Offline copies could not be saved. Keep this page online or use the CLI.');
      if (data?.type === 'OFFLINE_STATUS') {
        setOfflineReady(data.ready === true);
        setOfflineStatus(data.ready ? 'Offline verifier and included sample are ready on this device.' : data.error || 'Offline setup is incomplete. Connect and prepare again.');
      }
      if (data?.type === 'UPDATE_CAN_ACTIVATE') ports?.[0]?.postMessage({ type: 'UPDATE_SAFE', safe: updateSafeRef.current });
      if (data?.type === 'UPDATE_DEFERRED') setOfflineStatus('Update deferred while another tab has active work or has not responded.');
      if (data?.type === 'CONTROLLER_ACTIVE') requestOfflineStatus();
    };
    navigator.serviceWorker.addEventListener('message', onWorkerMessage);
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    const workerBase = location.pathname.startsWith('/flightseal/') ? '/flightseal/' : '/';
    navigator.serviceWorker.register(`${workerBase}sw.js`, { scope: workerBase })
      .then((registration) => {
        if (!active) return;
        setServiceWorkerRegistration(registration);
        setWaitingUpdate(!!registration.waiting);
        const inspect = () => {
          const installing = registration.installing;
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) setWaitingUpdate(true);
          });
        };
        registration.addEventListener('updatefound', inspect);
        requestOfflineStatus();
        navigator.serviceWorker.ready.then(ready=>{if(active)requestOfflineStatus(ready.active);});
      })
      .catch(() => { if (active) setOfflineStatus('Offline caching could not be started here. Files loaded during this visit can still be checked.'); });
    return () => { active = false; navigator.serviceWorker.removeEventListener('message', onWorkerMessage); navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange); };
  }, []);

  const prepareOffline = () => {
    if (!navigator.serviceWorker?.controller) { setOfflineStatus('The worker is not controlling this page yet. Reload online, then prepare offline.'); return; }
    setOfflineStatus('Preparing the app shell, verifier and small included sample…');
    navigator.serviceWorker.controller.postMessage({ type: 'PREPARE_OFFLINE' });
  };
  const activateWaitingUpdate = () => {
    if (!serviceWorkerRegistration?.waiting) { setWaitingUpdate(false); return; }
    serviceWorkerRegistration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    setOfflineStatus('Checking whether open tabs can safely apply the update…');
  };
  const installApp = async () => {
    if (!installPrompt) { setInstallDialogOpen(true); return; }
    const outcome = await invokeInstallPrompt(installPrompt);
    setInstallPrompt(null);
    setOperationStatus(outcome === 'accepted' ? 'The browser accepted the install prompt. HashWing cannot confirm final installation.' : 'The browser install prompt was dismissed.');
  };
  const shareSummary = result ? `HashWing verification summary\nChain: ${humanStatus(result.native.status)[0]}\nReceipt signature status: ${result.needsTrustedKey ? 'unchecked: trusted key missing' : result.receiptChecks.length ? result.receiptChecks.map((receipt) => receipt.check).join(', ') : 'no receipts supplied'}\nReceipt coverage: ${fmtBig(result.receiptCoverage?.covered ?? result.native.covered)} covered / ${fmtBig(result.native.records)} records\nIntegrity does not establish sensor truth, capture time, identity or independent custody.` : '';
  const shareUrl = typeof location === 'undefined' ? '' : new URL(routeHash(screen === 'landing' ? 'sandbox' : screen, { sample: currentSample, record: selectedRecord }), location.href).toString();

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
    if (file.size > MAX_UI_BYTES) { invalidateCheck(); setError(`Files over ${fmtBytes(MAX_UI_BYTES)} are not supported here. Use the CLI for larger files.`); return null; }
    const operation = ++runRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy('Checking log…');
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
        : receiptIndex?.signaturesChecked === false
          ? 'C++ verified the receipts. The independent JavaScript signature check is unavailable.'
          : '');
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
    const pending = demoGuardRef.current;
    if (pending.sealOutput && !pending.sealOutputAcknowledged) {
      setError('Download the current sealed files or confirm you no longer need them before replacing them.');
      return;
    }
    if (!pending.currentSample && (pending.logFile || pending.receiptSelected) && !window.confirm('Switch to the included sample? This replaces the selected verification inputs in this tab. Your original files and signing key stay unchanged.')) return;
    setTelemetry([]); setSelectedTelemetryIndex(null);
    const selectedSample = sample === false ? 'intact' : sample === true ? 'px4' : sample === 'full' ? 'px4-full' : sample;
    setCurrentSample(['intact', 'byte-flip', 'tampered', 'rewritten', 'truncated', 'px4', 'px4-tampered', 'px4-full'].includes(selectedSample) ? selectedSample : 'intact');
    if (['intact', 'byte-flip'].includes(selectedSample)) setDemoScenario(selectedSample);
    // Only public fixture IDs and record positions enter the URL.
    const activeRoute = parseLocation(location);
    if (activeRoute.kind === 'workspace') {
      const params = { sample: selectedSample, record: activeRoute.params.get('record') || 0,receipt:activeRoute.params.get('receipt') || (activeRoute.screen==='receipts'?activeRoute.detail:undefined) };
      history.replaceState(null, '', activeRoute.direct ? productHref(activeRoute.screen, params) : routeHash(activeRoute.screen, params));
      setRoute(parseLocation(location));
    }
    setReceiptText(''); setKeyText('');
    let operation = ++runRef.current;
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
      let verified = await runVerify(file, receipts, key, size);
      if (!verified) return;
      operation = runRef.current;
      if (sampleKey === 'byte-flip') {
        const verificationRun = runRef.current;
        setBusy('Changing a copy of sample record 0…'); setResult(null);
        const changed = await mutateFile(file, verified.indexed, 'flip', { signal: controllerRef.current.signal });
        if (verificationRun !== runRef.current) return;
        verified = await runVerify(changed.file, receipts, key, `${size} · ${changed.description}`);
      }
      if (verified) {
        setLogFile(verified.file); setReceiptText(receipts); setKeyText(key);
        setReceiptSelected(true);

        const params = parseLocation(location).params;
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
    const initial = parseLocation(location);
    if (initial.kind !== 'workspace') return;
    let session = activeLocalSession();
    if (!session) {
      try { session = setLocalSession({ kind: 'guest' }); }
      catch {
        session = { app: 'hashwing', schema: 1, kind: 'guest', userId: crypto.randomUUID?.() || `${Date.now()}-guest` };
      }
      setActiveSession(session);
      setLocalProfile(null);
      if (initial.legacy) legacyGuestInitializedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (route.kind !== 'workspace' || !activeSession) return;
    if (route.sample && route.sample !== currentSample) {
      loadDemo(route.sample);
      return;
    }
    if (route.legacy && !initialLegacyLoadedRef.current && !route.sample) {
      initialLegacyLoadedRef.current = true;
      loadDemo(false);
    }
  }, [route.kind, route.legacy, route.sample, activeSession?.userId, currentSample, loadDemo]);

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
    if (workbenchFileRef.current) workbenchFileRef.current.value = '';
    const operation = runRef.current;
    await disposeImportedOutput();
    if (operation !== runRef.current) return;
    setOperationStatus('');
  };

  const verifyPicked = async () => {
    await runVerify(logFile, receiptText, receiptText ? keyText : '', logFile?.name || 'local file');
  };

  const chooseLog = async (file) => {
    const selectedRoute = parseLocation(location);
    if (selectedRoute.kind === 'workspace') {
      history.replaceState(null, '', selectedRoute.direct ? productHref(selectedRoute.screen) : routeHash(selectedRoute.screen));
      setRoute(parseLocation(location));
    }
    const replacingSample = !!currentSample; // a sample's bundled receipts and key must never carry over to the user's own log
    setCurrentSample(null);
    const replacingImportedSession = hasImportedOutput;
    const clearAttachedEvidence = replacingSample || replacingImportedSession || !receiptSelected || receiptLoading;
    invalidateCheck();
    const operation = runRef.current;
    setBusy('Preparing selected log…'); setResult(null); setRecordDetail(null);
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
    if (file && file.size > MAX_UI_BYTES) setError(`Files over ${fmtBytes(MAX_UI_BYTES)} are not supported here. Use the CLI for larger files.`);
    else if (file) setError('');
    setBusy('');
  };
  const importUlog = async (file, { label = `${file.name} · native ULog import`, synthetic = false } = {}) => {
    setCurrentSample(null);
    if (file.size > IMPORT_MAX_BYTES) {
      setError(`Source files over ${fmtBytes(IMPORT_MAX_BYTES)} are not supported here. Use the CLI for larger captures.`);
      return;
    }
    invalidateCheck(); setResult(null); setRecordDetail(null); setTelemetry([]); setSelectedTelemetryIndex(null);
    receiptReadRef.current++;
    setReceiptText(''); setReceiptLoading(false); setReceiptSelected(false); setReceiptInputError(''); setKeyText('');
    receiptInvalidRef.current = false; receiptInvalidMessageRef.current = '';
    if (receiptInputRef.current) receiptInputRef.current.value = '';
    const op = ++runRef.current;
    setBusy('Preparing ULog import…');
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
      let initialRecord = 0;
      if (lastPointIndex >= 0) {
        const point = imported.telemetry[lastPointIndex];
        initialRecord = Number(point.record);
        telemetrySelectionRef.current++;
        setSelectedTelemetryIndex(lastPointIndex); setSelectedRecord(Number(point.record)); setPage(Math.floor(Number(point.record) / PAGE_SIZE));
      }
      setOperationStatus('');
      navigate('sandbox', { sample: null, record: initialRecord });
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
    const forSeal = sealPickerRef.current;
    sealPickerRef.current = false;
    if (!file) return;
    const extension = file.name.toLowerCase().split('.').pop();
    if (forSeal && !['tsv', 'txt', 'csv', 'json', 'tlog'].includes(extension)) { setError('Choose a timestamped TSV/TXT, CSV, JSON or MAVLink Tlog source to seal.'); return; }
    if (!['fseal', 'ulg', 'tsv', 'txt', 'csv', 'json', 'tlog'].includes(extension)) {
      setError('Unsupported source format. Choose a .fseal log, a PX4 .ulg capture, a timestamped TSV/TXT file, or CSV, JSON or MAVLink .tlog telemetry. To seal any other log file, use Seal & send.');
      return;
    }
    setCsvDraft(null);
    setCurrentSample(null);
    navigate(extension === 'fseal' ? 'verify' : 'sandbox', { sample: null, record: 0 });
    if (sealOutputAcknowledged) { setSealOutput(null); setSealOutputAcknowledged(false); }
    if (extension !== 'tsv' && extension !== 'txt') { setSealFileInput(null); setSealSourceMetadata(null); setSealSourceOriginal(null); }
    if (extension === 'fseal') {
      await chooseLog(file);
      navigate('verify', { sample: null, record: 0 });
      return;
    }
    if (extension === 'tsv' || extension === 'txt') {
      invalidateCheck(); const operation = runRef.current; setBusy('Preparing timestamped source…'); setResult(null); setTelemetry([]); setSelectedTelemetryIndex(null); await disposeImportedOutput();
      if (operation !== runRef.current) return;
      setSealFileInput(file); setSealSourceMetadata(null); setSealSourceOriginal(null); setTelemetry([]); setSelectedTelemetryIndex(null); setError(''); setBusy(''); navigate('sandbox', { sample: null, record: 0 });
      return;
    }
    if (['csv', 'json', 'tlog'].includes(extension)) {
      invalidateCheck(); const operation = runRef.current; setBusy('Validating telemetry source…'); setResult(null); setRecordDetail(null); setTelemetry([]); setSelectedTelemetryIndex(null); await disposeImportedOutput();
      if (operation !== runRef.current) return;
      if (extension === 'csv') {
        setSealFileInput(null); setSealSourceMetadata(null); setSealSourceOriginal(null);
        try {
          const preview = await inspectCsvFile(file);
          if (operation !== runRef.current) return;
          setCsvDraft({ file, ...preview, mapping: { timestampColumn: '', timestampUnit: '', latitudeColumn: '', latitudeUnit: '', longitudeColumn: '', longitudeUnit: '', altitudeColumn: '', altitudeUnit: '', speedColumn: '', speedUnit: '' } });
          setTelemetry([]); setSelectedTelemetryIndex(null); setBusy(''); setError(''); setOperationStatus('CSV preview ready. Map the columns and declared units before converting.');
        } catch (cause) {
          if (operation !== runRef.current) return;
          setBusy(''); setError(cause?.message || 'Could not preview this CSV file.');
        }
        return;
      }
      const controller = new AbortController(); controllerRef.current = controller;
      try {
        const converted = await convertTelemetryFile(file, { signal: controller.signal });
        if (operation !== runRef.current) return;
        setSealFileInput(converted.file); setSealSourceMetadata(converted.source); setSealSourceOriginal(file); setTelemetry(converted.telemetry);
        setSelectedTelemetryIndex(converted.telemetry.length ? 0 : null); setSelectedRecord(0); setPage(0);
        setError(''); setOperationStatus(`${converted.records.toLocaleString()} ${converted.source.format} records converted locally. Source SHA-256 recorded; MAVLink frame checksums are not verified by the Tlog converter.`); setBusy('');
        navigate('sandbox', { sample: null, record: 0 });
      } catch (cause) {
        if (operation !== runRef.current) return;
        setBusy('');
        if (cause?.name === 'AbortError') { setOperationStatus('Telemetry import canceled. No source was sealed.'); return; }
        setError(cause?.message || 'Could not parse this telemetry file. Check the documented schema and retry.');
      }
      return;
    }
    if (extension !== 'ulg') {
      setError('Unsupported source format. Choose a .fseal log, a PX4 .ulg capture, a timestamped TSV/TXT file, or CSV, JSON or MAVLink .tlog telemetry. To seal any other log file, use Seal & send.');
      return;
    }
    await importUlog(file);
  };
  const convertCsvDraft = async () => {
    if (!csvDraft) return;
    invalidateCheck(); const operation = runRef.current; const { file, mapping } = csvDraft;
    setBusy('Converting mapped CSV locally…'); setError('');
    const controller = new AbortController(); controllerRef.current = controller;
    try {
      const converted = await convertTelemetryFile(file, { signal: controller.signal, csvMapping: mapping });
      if (operation !== runRef.current) return;
      setSealFileInput(converted.file); setSealSourceMetadata(converted.source); setSealSourceOriginal(file);
      setTelemetry(converted.telemetry); setSelectedTelemetryIndex(converted.telemetry.length ? 0 : null); setSelectedRecord(0); setPage(0);
      setCsvDraft(null); setOperationStatus(`${converted.records.toLocaleString()} CSV records converted locally with the selected mapping. Source SHA-256 recorded; original columns retained.`);
      navigate('sandbox', { sample: null, record: 0 });
    } catch (cause) {
      if (operation !== runRef.current || cause?.name === 'AbortError') return;
      setError(cause?.message || 'Could not convert this CSV using the selected mapping.');
    } finally { if (operation === runRef.current) setBusy(''); }
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

  const doMutation = async (kind, trigger) => {
    if (!result || busy) return;
    const focused = document.activeElement === trigger;
    let moved = false;
    const onFocus = (event) => { if (event.target !== trigger && event.target !== document.body) moved = true; };
    const onPointer = (event) => { if (!trigger.contains(event.target)) moved = true; };
    const onKey = (event) => { if (event.key === 'Tab') moved = true; };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    mutationFocusRef.current = (restore = true) => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      const target = trigger.isConnected && !trigger.disabled ? trigger : document.getElementById(`page-${screen}`);
      if (restore && focused && !moved && document.activeElement === document.body) target?.focus({ preventScroll: true });
    };
    const selectedResult = result;
    const operation = ++runRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    setBusy('Preparing sandbox copy…'); setResult(null);
    try {
      const { file, indexed, receipts, key, label } = selectedResult;
      const changed = await mutateFile(file, indexed, kind, { signal: controller.signal });
      if (operation !== runRef.current || selectedResult !== result) return;
      setTelemetry([]); setSelectedTelemetryIndex(null);
      await runVerify(changed.file, receipts, key, `${label} · ${changed.description}`);
      // The bounded mutation may be a Blob assembled from slices of the imported
      // OPFS-backed file. Keep that source alive until the whole session is cleared.
    } catch (cause) {
      if (operation === runRef.current && cause?.name !== 'AbortError') setError(cause?.message || 'Could not prepare a bounded sandbox copy. Choose the file again and retry.');
    } finally {
      if (operation === runRef.current) setBusy('');
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

  const generateSigningKey = async () => {
    const owner = authEpochRef.current, read = ++signingKeyReadRef.current;
    const isCurrent = () => owner === authEpochRef.current && read === signingKeyReadRef.current;
    setError('');
    try {
      const generated = await generateEd25519SigningKey();
      if (!isCurrent()) return;
      setSigningKey({ ...generated, origin: 'Generated in this tab' });
      setOperationStatus('Ed25519 key generated in memory. Keep an explicit private-key backup before relying on it; no identity is verified.');
    } catch (cause) { if (isCurrent()) setError(cause?.message || 'Could not generate an Ed25519 key in this browser.'); }
  };
  const importSigningKey = async (file) => {
    if (!file) return;
    const owner = authEpochRef.current, read = ++signingKeyReadRef.current;
    const isCurrent = () => owner === authEpochRef.current && read === signingKeyReadRef.current;
    if (file.size > 16 * 1024) { setError('Private key PEM files are limited to 16 KiB.'); return; }
    try {
      const text = await file.text();
      if (!isCurrent()) return;
      const privateKeyPem = await validateEd25519PrivateKey(text);
      if (!isCurrent()) return;
      setSigningKey({ privateKeyPem, publicKeyHex: '', backupFilename: file.name, origin: 'Imported for this tab only' });
      setOperationStatus('Private key loaded in memory for this tab. Import its matching public key separately for verification.');
      setError('');
    } catch (cause) { if (isCurrent()) setError(cause?.message || 'Could not load this private key.'); }
  };
  const clearSigningKey = () => {
    signingKeyReadRef.current++;
    setSigningKey(null);
    const input = document.getElementById('private-key-file');
    if (input) input.value = '';
    setOperationStatus('Private key cleared from app state.');
  };
  const downloadPrivateKeyBackup = () => {
    if (!signingKey?.privateKeyPem) return;
    if (!window.confirm('Download a plaintext private-key backup to this device? Anyone with this file can create matching receipt signatures.')) return;
    download(signingKey.backupFilename || 'hashwing-ed25519-private-key.pem', signingKey.privateKeyPem, 'application/x-pem-file');
    setOperationStatus('Private-key backup downloaded. HashWing does not store or recover it.');
  };
  const downloadSigningPublicKey = () => {
    if (signingKey?.publicKeyHex) download('hashwing-ed25519-public-key.txt', `${signingKey.publicKeyHex}\n`, 'text/plain;charset=utf-8');
  };

  const runSeal = async () => {
    if (sealOutput && !sealOutputAcknowledged) {
      setError('Download the current sealed files or confirm you no longer need them before replacing them.'); setOperationStatus('');
      return;
    }
    receiptReadRef.current++; setReceiptLoading(false);
    invalidateCheck(); setResult(null); setRecordDetail(null);
    const op = ++runRef.current;
    setBusy('Preparing sealed output…');
    await disposeImportedOutput();
    if (op !== runRef.current) return;
    if (!sealFileInput) { setError('Choose a tab-separated timestamp and payload file first.'); setBusy(''); return; }
    if (sealFileInput.size > SEAL_MAX_BYTES) { setError(`The C++ sealer accepts source files up to ${SEAL_MAX_BYTES / 1024 / 1024} MiB.`); setBusy(''); return; }
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    setBusy('Sealing TSV…'); setError(''); setSealOutput(null);
    try {
      const sealed = await sealFile(sealFileInput, { every: Number(sealInterval), signal: controller.signal, privateKeyPem: signingKey?.privateKeyPem || '' });
      if (op !== runRef.current) return;
      const output = { ...sealed, filename: sealSourceMetadata?.filename || sealFileInput.name, source: sealSourceMetadata, originalSource: sealSourceOriginal };
      setSealOutput(output);
      setSealOutputAcknowledged(false);
      setReceiptText(''); setReceiptSelected(false); setReceiptInputError('');
      receiptInvalidRef.current = false; receiptInvalidMessageRef.current = '';
      if (receiptInputRef.current) receiptInputRef.current.value = '';
      setReceiptText(sealed.receipts); setKeyText(sealed.publicKey);
      const verified = await runVerify(new File([sealed.log], 'sealed.fseal'), sealed.receipts, sealed.publicKey, output.filename, output.source);
      if (!verified) return;
      setOperationStatus('');
    } catch (cause) {
      if (op !== runRef.current || cause?.name === 'AbortError') return;
      setError(cause?.message || 'Could not seal this file. Check the TSV format and retry.');
    } finally { if (op === runRef.current) setBusy(''); }
  };

  // Seal & send: seal the exact bytes of any log file, hand one receipt to a witness, later check and give the original back.
  const runProtectSeal = async () => {
    invalidateCheck(); setProtectSealed(null); setProtectResult(null); setRestored(null); setCopyStatus(''); setError('');
    if (!protectFile) { setError('Choose the flight log file you want to seal.'); return; }
    let op = ++runRef.current;
    const controller = new AbortController(); controllerRef.current = controller;
    setBusy('Sealing your file on this device…');
    try {
      const packed = await fileToRecords(protectFile);
      if (op !== runRef.current) return;
      const sealed = await sealFile(packed.records, { every: 1000000, signal: controller.signal, privateKeyPem: signingKey?.privateKeyPem || '' });
      if (op !== runRef.current) return;
      const log = new File([sealed.log], `${packed.name}.fseal`, { type: 'application/octet-stream' });
      const verified = await runVerify(log, sealed.receipts, sealed.publicKey, `${packed.name} (just sealed)`);
      if (!verified) return;
      op = runRef.current; // runVerify started its own operation; Cancel or a newer action changes it
      setBusy('Rebuilding the original from the sealed copy to double-check it…');
      const back = await recordsToFile(log);
      if (op !== runRef.current) return;
      if (verified.overallVerdict !== 'intact' || !back?.matches) { setResult(null); throw new Error('The sealed copy did not check out, so it was discarded. Choose the file again and retry.'); }
      setProtectResult(verified);
      setProtectSealed({
        name: packed.name, bytes: packed.bytes, sha256: packed.sha256, log, savedKey: !!signingKey?.privateKeyPem,
        handover: handoverText({ ...packed, receipts: sealed.receipts, publicKey: sealed.publicKey, sealedAt: new Date().toISOString(), checkUrl: `${location.origin}${location.pathname}#/app/protect` }),
      });
      setOperationStatus('Sealed and checked on this device; nothing was uploaded. Now send the receipt message to someone else.');
    } catch (cause) {
      if (op !== runRef.current || cause?.name === 'AbortError') return;
      setBusy(''); setError(cause?.message || 'Could not seal this file. Choose it again and retry.');
    } finally { if (op === runRef.current) setBusy(''); }
  };

  const runProtectCheck = async () => {
    invalidateCheck(); setProtectResult(null); setRestored(null); setError('');
    if (!checkFile) { setError('Choose the sealed file (.fseal) you were given.'); return; }
    const { receipts, publicKey, keyConflict } = parseHandover(checkText);
    if (keyConflict) { setError('This message names more than one public key. Paste only the receipt message you received when the flight was sealed.'); return; }
    if (!receipts || !publicKey) { setError('Paste the receipt message you received when the flight was sealed. Without it, a rewritten file cannot be told apart from the original.'); return; }
    const verified = await runVerify(checkFile, receipts, publicKey, checkFile.name);
    if (!verified) return;
    const op = runRef.current;
    setProtectResult(verified);
    if (verified.overallVerdict !== 'intact' || Number(verified.receiptCoverage.uncovered) !== 0) return;
    setBusy('Rebuilding the original file…');
    try {
      const back = await recordsToFile(checkFile);
      if (op === runRef.current) setRestored(back || 'none');
    } catch (cause) { if (op === runRef.current) setError(cause.message); }
    finally { if (op === runRef.current) setBusy(''); }
  };

  const copyHandover = async () => {
    try { await navigator.clipboard.writeText(protectSealed.handover); setCopyStatus('Copied. Paste it into an email or message to the person who will keep it.'); }
    catch { setCopyStatus('This browser blocked copying. Select the text in the box and copy it, or download the receipt.'); }
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

  const setHashRoute = (hash) => {
    if (location.hash !== hash) location.hash = hash.slice(1);
    setRoute(parseRouteHash(hash));
    setMenuOpen(false);
    setError('');
  };
  const beginDemo = () => {
    if (sealOutput && !sealOutputAcknowledged) { setProfileMenuMessage('Download the sealed files or acknowledge them in the workspace before switching sessions.'); return false; }
    if (activeSession) clearSensitiveWorkspace();
    let session;
    try { session = setLocalSession({ kind: 'guest' }); }
    catch {
      session = { app: 'hashwing', schema: 1, kind: 'guest', userId: globalThis.crypto?.randomUUID?.() || `volatile-${Date.now()}-${Math.random()}` };
      setOperationStatus('Browser session storage is unavailable. This demo session will not be remembered after this tab closes.');
    }
    setActiveSession(session);
    setLocalProfile(null);
    initialLegacyLoadedRef.current = true;
    setHashRoute(routeHash('sandbox', { sample: 'intact' }));
    return true;
  };
  const clearSensitiveWorkspace = () => {
    authEpochRef.current++;
    signingKeyReadRef.current++;
    setPrivateResetVersion((version) => version + 1);
    runRef.current++;
    controllerRef.current?.abort(); controllerRef.current = null;
    recordRef.current++; routeEpochRef.current++; receiptReadRef.current++;
    const dispose = importDisposeRef.current; importDisposeRef.current = null;
    if (typeof dispose === 'function') Promise.resolve().then(() => dispose()).catch(() => {});
    setBusy(''); setResult(null); setLogFile(null); setReceiptText(''); setReceiptLoading(false); setReceiptSelected(false);
    setReceiptInputError(''); setKeyText(''); setSelectedRecord(0); setRecordDetail(null); setRecordError(''); setPageRows([]); setFirstRecord(null);
    setTelemetry([]); setSelectedTelemetryIndex(null); setHasImportedOutput(false); setPage(0); setSealFileInput(null); setSealSourceMetadata(null); setSealSourceOriginal(null); setSigningKey(null);
    setCsvDraft(null); setShareDialogOpen(false); setFeedbackDialogOpen(false); setInstallDialogOpen(false);
    setSealOutput(null); setSealOutputAcknowledged(false); setCurrentSample(null); setDemoLabel(''); setError(''); setOperationStatus('');
    setVideoOffset('0'); clearVideo();
    receiptInvalidRef.current = false; receiptInvalidMessageRef.current = ''; sealPickerRef.current = false;
    if (receiptInputRef.current) receiptInputRef.current.value = '';
    if (workbenchFileRef.current) workbenchFileRef.current.value = '';
    document.querySelectorAll('#root input[type="file"]').forEach((input) => { input.value = ''; });
  };
  const logout = () => {
    if (sealOutput && !sealOutputAcknowledged) { setProfileMenuMessage('Download the sealed files or acknowledge them in the workspace before logging out.'); return; }
    try { announceLocalLogout({ userId: activeSession?.userId || null }); }
    catch { clearLocalSession(); }
    clearSensitiveWorkspace();
    setActiveSession(null); setLocalProfile(null); setSavedContext(null); setSavedContextError(''); setProfileMenuMessage('');
    legacyGuestInitializedRef.current = false; initialLegacyLoadedRef.current = false;
    history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    setRoute(parseRouteHash('#/'));
    setMenuOpen(false);
  };
  const logoutFromAnotherTab = (message) => {
    const sameActiveProfile = activeSession && message?.userId === activeSession.userId;
    const removedProfile = message?.scope === 'profiles' && activeSession?.kind === 'account' && !message.profileIds?.includes(activeSession.userId);
    const storageWasCleared = message?.scope === 'all';
    const pendingLoginMatches = !activeSession && route.kind === 'login' && authAttemptRef.current.mode === 'login' &&
      localProfileFor({ kind: 'account', userId: message?.userId })?.email === authAttemptRef.current.email;
    if (!sameActiveProfile && !removedProfile && !storageWasCleared && !pendingLoginMatches) return;
    authEpochRef.current++;
    if (!activeSession) return;
    clearLocalSession();
    clearSensitiveWorkspace();
    setActiveSession(null); setLocalProfile(null); setSavedContext(null); setSavedContextError(''); setProfileMenuMessage('');
    legacyGuestInitializedRef.current = false; initialLegacyLoadedRef.current = false;
    history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    setRoute(parseRouteHash('#/'));
  };
  useEffect(() => subscribeToLocalLogout(logoutFromAnotherTab), [activeSession?.userId, route.kind]);

  const finishAuthentication = async (profile, requestedRoute, importGuest, submittedEpoch) => {
    if (submittedEpoch !== authEpochRef.current) return { error: 'This sign-in was canceled because the local session changed. Try again.' };
    if (sealOutput && !sealOutputAcknowledged) return { error: 'Download the sealed files or acknowledge them in the workspace before switching accounts.' };
    const guestContext = activeSession?.kind === 'guest' && importGuest && currentSample
      ? { screen: workspaceScreenRef.current, sample: currentSample, record: selectedRecord } : null;
    try {
      if (guestContext) await saveWorkspaceContext(profile.id, guestContext, { isCurrent: () => submittedEpoch === authEpochRef.current });
      if (submittedEpoch !== authEpochRef.current) return { error: 'This sign-in was canceled because the local session changed. Try again.' };
      setLocalSession({ kind: 'account', userId: profile.id });
    } catch (cause) { return { error: cause?.message || 'Could not start the local profile session.' }; }
    clearSensitiveWorkspace();
    setActiveSession({ app: 'hashwing', schema: 1, kind: 'account', userId: profile.id });
    setLocalProfile({ id: profile.id, email: profile.email });
    let saved = null;
    try { saved = readWorkspaceContext(profile.id); setSavedContextError(''); }
    catch (cause) { setSavedContextError(cause?.message || 'Saved view data is invalid. Remove it before saving another view.'); setProfileMenuMessage(cause?.message || 'Saved view data is invalid. Remove it before saving another view.'); }
    const target = requestedRoute
      ? safeReturnRoute(requestedRoute)
      : guestContext
        ? routeHash(guestContext.screen, { sample: guestContext.sample, record: guestContext.record })
        : saved
          ? routeHash(saved.screen, { sample: saved.sample, record: saved.record })
          : routeHash('sandbox', { sample: 'intact' });
    setSavedContext(saved || guestContext);
    setHashRoute(target);
    return { ok: true };
  };
  const saveCurrentView = async () => {
    if (activeSession?.kind !== 'account' || !currentSample) return;
    const saveEpoch = authEpochRef.current;
    try {
      if (savedContextError) { setProfileMenuMessage(savedContextError); return; }
      const saved = await saveWorkspaceContext(activeSession.userId, { screen, sample: currentSample, record: selectedRecord }, { isCurrent: () => authEpochRef.current === saveEpoch && activeSession?.kind === 'account' && activeSession.userId === localProfile?.id });
      setSavedContext({ screen: saved.screen, sample: saved.sample, record: saved.record });
      setSavedContextError('');
      setProfileMenuMessage('Included-sample view saved on this device.');
    } catch (cause) { setProfileMenuMessage(cause?.message || 'Could not save this view.'); }
  };
  const restoreSavedView = () => {
    if (activeSession?.kind !== 'account') return;
    let saved;
    try { saved = readWorkspaceContext(activeSession.userId); }
    catch (cause) { setSavedContextError(cause?.message || 'Saved view data is invalid.'); setProfileMenuMessage(cause?.message || 'Saved view data is invalid.'); return; }
    setSavedContext(saved);
    if (!saved) { setProfileMenuMessage('No saved view is available on this device.'); return; }
    setProfileMenuMessage('Restored the saved included-sample view.');
    setHashRoute(routeHash(saved.screen, { sample: saved.sample, record: saved.record }));
  };
  const deleteSavedView = async () => {
    if (activeSession?.kind !== 'account') return;
    const deleteEpoch = authEpochRef.current;
    try { await removeWorkspaceContext(activeSession.userId, { isCurrent: () => authEpochRef.current === deleteEpoch && activeSession?.kind === 'account' && activeSession.userId === localProfile?.id }); setSavedContext(null); setSavedContextError(''); setProfileMenuMessage('Saved view removed from this device.'); }
    catch (cause) { setProfileMenuMessage(cause?.message || 'Could not remove the saved view.'); }
  };
  const removeActiveProfile = async () => {
    if (activeSession?.kind !== 'account' || !localProfile?.id) return;
    if (sealOutput && !sealOutputAcknowledged) { setProfileMenuMessage('Download or acknowledge the pending sealed output before removing this profile.'); return; }
    if (!window.confirm('Remove this local profile and its saved view from this browser? This cannot be undone.')) return;
    const id = localProfile.id;
    const epoch = authEpochRef.current;
    try { await removeLocalProfile(id, { isCurrent: () => authEpochRef.current === epoch && activeSession?.kind === 'account' && activeSession.userId === id }); }
    catch (cause) { setProfileMenuMessage(cause?.message || 'Could not remove this local profile.'); return; }
    if (authEpochRef.current !== epoch) return;
    announceLocalLogout({ userId: id });
    logout();
  };

  useEffect(() => {
    if (route.kind !== 'workspace' || activeSession) return;
    if (legacyGuestInitializedRef.current && route.legacy) return;
    legacyGuestInitializedRef.current = route.legacy;
    let guest;
    try { guest = setLocalSession({ kind: 'guest' }); }
    catch { guest = { app: 'hashwing', schema: 1, kind: 'guest', userId: globalThis.crypto?.randomUUID?.() || `volatile-${Date.now()}-${Math.random()}` }; }
    setActiveSession(guest); setLocalProfile(null);
  }, [route.kind, route.route, route.legacy, route.screen, route.sample, route.record, activeSession?.userId]);

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
    `Verified log whole-file SHA-256: ${result.native.fileSha256 || 'Unavailable'}`,
    `Head: ${result.native.head}`,
    `Time reversals: ${String(result.native.timeReversals)}`,
    `Receipt coverage: ${String(result.receiptCoverage?.covered ?? result.native.covered)} covered; ${String(result.receiptCoverage?.uncovered ?? result.native.uncovered)} uncovered`,
    ...(result.receiptChecks.length ? ['', 'Receipt checks:', ...result.receiptChecks.map((r, i) => `  ${i + 1}. after ${r.count}: ${r.description} [${r.check}]`)] : ['Receipts: none supplied']),
    ...(result.source ? ['', 'Imported source:', `  Format: ${result.source.format}`, ...(result.source.filename ? [`  Original filename: ${result.source.filename}`] : []), `  Bytes: ${String(result.source.bytes)}`, `  SHA-256: ${result.source.sha256}`, ...(result.source.converterVersion ? [`  Converter: ${result.source.converterVersion}`, ...result.source.transformations.map((step) => `  Transformation: ${step}`)] : []), ...(result.source.fieldMapping ? [`  CSV field mapping: ${csvMappingSummary(result.source.fieldMapping)}`] : [])] : []),
    ...(result.source ? [`  Source mapping: ${result.source.recordMappings?.length || 0} explicit record identifiers; original bytes are retained separately in the evidence bundle when available.`] : []),
    '', 'Custody events: HashWing records the selected input metadata and local processing result only. It does not establish independent acquisition or custody.',
    `Signature basis: ${result.receiptChecks.length ? (result.needsTrustedKey ? 'receipt signatures were not checked against a trusted public key' : 'receipt signatures were checked against the supplied public key; external trust in that key is user-established') : 'no receipt signatures supplied'}`,
    'User-entered identity: none recorded. Key possession does not establish a pilot or operator identity.',
    `Path evidence: ${selectedTelemetryPoint ? `record ${selectedTelemetryPoint.record}, timestamp ${selectedTelemetryPoint.timestampUs} µs${selectedTelemetryPoint.sourceOffset == null ? '' : `, source byte ${selectedTelemetryPoint.sourceOffset}`}; ${Number.isFinite(selectedTelemetryPoint.latitudeDeg) && Number.isFinite(selectedTelemetryPoint.longitudeDeg) ? 'coordinates are source values, not independently authenticated' : 'location unavailable at this record; no GPS point was fabricated'}` : telemetry.length ? 'telemetry records are available; no point was selected and location may be unavailable' : 'location unavailable; no GPS point was fabricated'}`,
    'Time basis: timestamps are source values; no trusted time source or acquisition-time protection is established.',
    ...(result.indexed.problem ? ['', `First failure: ${problemLabel(result.indexed.problem.token)} (${result.indexed.problem.token}) at record ${result.indexed.problem.record}`, `Byte offset: ${result.indexed.problem.offset}`, ...(result.indexed.problem.expected != null ? [`Expected: ${String(result.indexed.problem.expected)}`] : []), ...(result.indexed.problem.actual != null ? [`Actual: ${String(result.indexed.problem.actual)}`] : []), result.indexed.problem.detail || ''] : []),
    '', 'This integrity result does not establish that recorded sensor data was true.',
  ].filter((line) => line !== undefined).join('\n') + '\n' : '';
  const reportJson = result ? JSON.stringify({
    engine: result.native.engine, nativeVerdict: result.native.verdict, overallVerdict: result.overallVerdict || result.native.verdict, status: result.native.status,
    records: String(result.native.records), goodBytes: String(result.native.goodBytes), wholeFileSha256: result.native.fileSha256 || null, head: result.native.head,
    covered: String(result.receiptCoverage?.covered ?? result.native.covered), uncovered: String(result.receiptCoverage?.uncovered ?? result.native.uncovered),
    receiptChecks: result.receiptChecks.map((r) => ({ ...r, count: String(r.count) })),
    source: result.source || null,
    firstFailure: result.indexed.problem ? { type: problemLabel(result.indexed.problem.token), token: result.indexed.problem.token, record: String(result.indexed.problem.record), offset: String(result.indexed.problem.offset), expected: result.indexed.problem.expected ?? null, actual: result.indexed.problem.actual ?? null } : null,
    report: reportText,
  }, null, 2) : '';
  const reportMarkdown = result ? `# HashWing integrity evidence report\n\n${reportText.split('\n').filter(Boolean).map((line) => line.startsWith('  ') ? `  - ${line.trim()}` : line.endsWith(':') ? `\n## ${line.slice(0, -1)}\n` : line).join('\n')}\n\n## Reverification\n\nUse the exported .fseal log, receipt file, and public key with FlightSeal's independent verifier. Verify the public key with its holder through a separate channel.\n\nThis report does not establish legal admissibility, sensor truth, capture-time integrity, verified personhood, trusted time, or independent custody.\n` : '';
  const downloadPdf = async () => {
    if (!result) return;
    const owner = authEpochRef.current, operation = runRef.current;
    const isCurrent = () => owner === authEpochRef.current && operation === runRef.current;
    try {
      const { createIntegrityPdf, fingerprintPublicKey } = await import('./report-pdf.mjs');
      if (!isCurrent()) return;
      const fingerprint = await fingerprintPublicKey(result.key);
      if (!isCurrent()) return;
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
          `Verified log whole-file SHA-256: ${result.native.fileSha256 || 'Unavailable'}`,
          `Full chain head: ${result.native.head}`,
          `Public key SHA-256 fingerprint: ${fingerprint}`,
          `Receipt coverage: ${String(result.receiptCoverage?.covered ?? result.native.covered)} covered; ${String(result.receiptCoverage?.uncovered ?? result.native.uncovered)} uncovered`,
          '## Receipt checks',
          ...(result.receiptChecks.length ? result.receiptChecks.map((receipt) => `After ${receipt.count}: ${receipt.check} - ${receipt.description}; head ${receipt.head}; key ${receipt.key}`) : ['No receipts were supplied.']),
          ...(result.source ? ['## Imported source', `Format: ${result.source.format}`, ...(result.source.filename ? [`Original filename: ${result.source.filename}`] : []), `Bytes: ${String(result.source.bytes)}`, `Source SHA-256: ${result.source.sha256}`, ...(result.source.converterVersion ? [`Converter: ${result.source.converterVersion}`, ...result.source.transformations.map((step) => `Transformation: ${step}`)] : []), ...(result.source.fieldMapping ? [`CSV field mapping: ${csvMappingSummary(result.source.fieldMapping)}`] : [])] : []),
          ...(result.source ? [`Source mapping identifiers: ${result.source.recordMappings?.length || 0}; original source bytes are available separately in the bundle when this was a converted import.`] : []),
          'Custody events: local selection and processing evidence only; no independent custody is established.',
          `Signature/trust basis: ${result.receiptChecks.length ? result.needsTrustedKey ? 'unchecked against trusted public key' : 'checked against user-supplied public key; external trust is user-established' : 'no signatures supplied'}.`,
          'User-entered operator identity: none recorded. Key possession does not establish pilot identity.',
          `Path evidence: ${selectedTelemetryPoint ? `record ${selectedTelemetryPoint.record} at ${selectedTelemetryPoint.timestampUs} µs${selectedTelemetryPoint.sourceOffset == null ? '' : `, source byte ${selectedTelemetryPoint.sourceOffset}`}; ${Number.isFinite(selectedTelemetryPoint.latitudeDeg) && Number.isFinite(selectedTelemetryPoint.longitudeDeg) ? 'source coordinates are not independently authenticated' : 'location unavailable at this record; no GPS point was fabricated'}` : telemetry.length ? 'telemetry records available; no point selected and location may be unavailable' : 'location unavailable; no GPS point was fabricated'}.`,
          'Timestamps are source values; no trusted time or capture-time protection is established.',
          ...(issue ? ['## First failure', `Type: ${problemLabel(issue.token)} (${issue.token})`, `Record: ${String(issue.record)}`, `Byte offset: ${String(issue.offset)}`, ...(issue.expected != null ? [`Expected: ${String(issue.expected)}`] : []), ...(issue.actual != null ? [`Actual: ${String(issue.actual)}`] : []), issue.detail || ''] : ['First failure: none reported.']),
          'Receipt v1 has no signed issue timestamp.',
          'This integrity report is not a legal guarantee, court-admissible certificate, or claim that sensor data is true.',
        ],
      });
      if (isCurrent()) download('hashwing-integrity-report.pdf', pdf, 'application/pdf');
    } catch (cause) {
      if (isCurrent()) setError(cause?.message || 'Could not create the PDF report. Download the text or JSON report instead.');
    }
  };
  const downloadEvidenceBundle = async () => {
    if (!result) return;
    const owner = authEpochRef.current, operation = runRef.current;
    const isCurrent = () => owner === authEpochRef.current && operation === runRef.current;
    try {
      const { fingerprintPublicKey } = await import('./report-pdf.mjs');
      if (!isCurrent()) return;
      const fingerprint = await fingerprintPublicKey(result.key);
      if (!isCurrent()) return;
      const files = [
        { name: 'verified-log.fseal', blob: result.file },
        ...(sealOutput?.originalSource ? [{ name: `original-source-${sealOutput.originalSource.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'source.bin'}`, blob: sealOutput.originalSource }] : []),
        { name: 'receipts.txt', bytes: new TextEncoder().encode(result.receipts || '') },
        { name: 'public-key.txt', bytes: new TextEncoder().encode(`${result.key || ''}\n`) },
        { name: 'verification-report.txt', bytes: new TextEncoder().encode(reportText) },
        { name: 'verification-report.json', bytes: new TextEncoder().encode(reportJson) },
        { name: 'bundle-notes.txt', bytes: new TextEncoder().encode(`HashWing / FlightSeal local verification export\nEngine: ${result.native.engine}\nRecords: ${result.native.records}\nWhole-file SHA-256: ${result.native.fileSha256 || 'unavailable'}\nChain head: ${result.native.head}\nPublic-key SHA-256 fingerprint: ${fingerprint}\nBundle export does not establish sensor truth, acquisition time, key identity, independent custody or legal admissibility.\n${result.source ? `Imported source: ${JSON.stringify(result.source)}\n` : ''}`) },
      ];
      const zip = await createStoreZip(files);
      if (!isCurrent()) return;
      const url = URL.createObjectURL(zip); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'hashwing-evidence-bundle.zip'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
      setOperationStatus('Evidence bundle downloaded. Share the files and key separately; this bundle is not independent custody.');
    } catch (cause) { if (isCurrent()) setError(cause?.message || 'Could not create the evidence bundle. Use the individual report and log downloads.'); }
  };
  const totalRows = result ? Number(result.native.records) + Number(!!result.indexed.problem && result.indexed.problem.record === Number(result.native.records)) : 0;
  const pageCount = result ? Math.max(1, Math.ceil(totalRows / PAGE_SIZE)) : 1;
  const rowStart = page * PAGE_SIZE;
  const activeReceiptChecks = result?.receiptChecks || [];
  useEffect(()=>{if(screen==='receipts'&&result&&/^[1-9][0-9]*$/.test(route.params.get('receipt')||''))document.getElementById('receipt-'+route.params.get('receipt'))?.focus();},[screen,result,route.params.get('receipt')]);
  const selectedFileName = workbenchFileRef.current?.files?.[0]?.name || '';
  useEffect(()=>{
    const readCurrent=()=>result ? {kind:result.source?'sealing':'verification',title:result.label,payload:{engine:result.native.engine,verdict:result.overallVerdict||result.native.verdict,status:result.native.status,records:String(result.native.records),good_bytes:String(result.native.goodBytes),sha256:result.native.fileSha256,chain_head:result.native.head,public_key:result.key,receipt_count:result.receiptChecks.length,covered:String(result.receiptCoverage?.covered??result.native.covered),uncovered:String(result.receiptCoverage?.uncovered??result.native.uncovered),first_failure:result.indexed.problem?{type:result.indexed.problem.token,record:String(result.indexed.problem.record),offset:String(result.indexed.problem.offset)}:null,source:result.source||null}} : null;
    globalThis.WorkspaceStore.register({readCurrent,readArtifacts:()=>result?[{name:'source.fseal',blob:result.file},...(result.receipts?[{name:'witness.receipts',blob:new Blob([result.receipts],{type:'text/plain'})}]:[])]:[],onLogout:clearSensitiveWorkspace,restore:async(run,files,isCurrent)=>{if(!files[0])throw Error('No source artifact was saved with this run. Download its report instead.');const receipts=files[1]?await files[1].text():'';if(!isCurrent())return;navigate('sandbox');await runVerify(new File([files[0]],'saved-source.fseal'),receipts,run.payload.public_key||'',run.title,run.payload.source||null);}});
    globalThis.WorkspaceStore.capture(readCurrent(),{autosave:false});
  },[result]);
  const returnTo = route.params.get('returnTo') || '';
  const renderedAuthEpoch = authEpochRef.current;
  const quickStartScope = activeSession?.kind === 'account' ? `profile_${activeSession.userId}` : `guest_${activeSession?.userId || 'anonymous'}`;
  const quickStartStorageKey = `flightseal_quickstart_${quickStartScope}_v1`;
  const installKind = installPrompt ? 'prompt' : detectInstallKind();

  if (route.kind === 'legal') return <><header className="auth-header"><a className="landing-brand" href="#/"><span className="brand-mark" aria-hidden="true">H</span><span>HashWing</span></a><nav className="auth-persistent-actions" aria-label="Account and workspace"><a href="#/login">Log in</a><a href="#/signup">Create account</a><a href="#/app/sandbox">Launch Workspace</a></nav></header><LegalPage page={route.page} onBack={() => setHashRoute('#/')} onClearCache={() => { navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_FLIGHTSEAL_CACHES' }); setOfflineReady(false); setOfflineStatus('FlightSeal-owned caches were requested for removal. Other apps’ caches are left alone.'); }} cacheStatus={offlineStatus} onFeedback={() => setFeedbackDialogOpen(true)} onInstall={installApp} onRestartQuickStart={() => { setQuickStartDismissed(false); try { localStorage.removeItem(quickStartStorageKey); } catch {} setHashRoute(routeHash('sandbox')); }} /><InstallGuide open={installDialogOpen} onClose={() => setInstallDialogOpen(false)} ios={installKind === 'ios'} /><FeedbackDialog key={`feedback-${privateResetVersion}`} open={feedbackDialogOpen} onClose={() => setFeedbackDialogOpen(false)} route={route.route} /></>;

  if (route.kind === 'landing') return <LandingPage key={privateResetVersion} onProtect={() => setHashRoute(routeHash('protect'))} onDemo={() => loadDemo(false)} onContinue={() => setHashRoute(routeHash('sandbox', { sample: currentSample || 'intact', record: selectedRecord }))} result={result} busy={busy} error={error} installKind={installKind} onInstall={installApp} onFeedback={() => setFeedbackDialogOpen(true)} installOpen={installDialogOpen} onInstallClose={() => setInstallDialogOpen(false)} feedbackOpen={feedbackDialogOpen} onFeedbackClose={() => setFeedbackDialogOpen(false)} route={route.route} />;
  if (route.kind === 'signup' || route.kind === 'login') return <AuthPage
    key={privateResetVersion}
    mode={route.kind}
    returnTo={returnTo}
    outputNeedsAck={!!sealOutput && !sealOutputAcknowledged}
    onReturnToWorkspace={() => setHashRoute(routeHash('sandbox', { sample: currentSample, record: selectedRecord }))}
    guestCanImport={activeSession?.kind === 'guest' && !!currentSample}
    currentSampleName={demoLabel}
    expectedEpoch={renderedAuthEpoch}
    isCurrent={() => authEpochRef.current === renderedAuthEpoch}
    onLogin={authenticateLocalProfile}
    onSignup={createLocalProfile}
    onAuthAttempt={(email, mode) => { authAttemptRef.current = { email: String(email || '').trim().toLowerCase(), mode }; }}
    onComplete={finishAuthentication}
    onDemo={beginDemo}
    installKind={installKind}
    onInstall={installApp}
    onFeedback={() => setFeedbackDialogOpen(true)}
    installOpen={installDialogOpen}
    onInstallClose={() => setInstallDialogOpen(false)}
    feedbackOpen={feedbackDialogOpen}
    onFeedbackClose={() => setFeedbackDialogOpen(false)}
    route={route.route}
  />;

  const profileControls = (<ProfileMenu
          key={`${privateResetVersion}:${activeSession?.userId || ''}`}
          isCurrent={() => authEpochRef.current === renderedAuthEpoch}
          session={activeSession}
          profile={localProfile}
          currentSample={currentSample}
          savedContext={savedContext}
          savedContextError={savedContextError}
          hasUnacknowledgedOutput={!!sealOutput && !sealOutputAcknowledged}
          message={profileMenuMessage}
          onSave={saveCurrentView}
          onRestore={restoreSavedView}
          onDeleteSaved={deleteSavedView}
          onRemoveProfile={removeActiveProfile}
          onLogout={logout}
          onNavigateAuth={(kind) => setHashRoute(`#/${kind}`)}
          syncStatus={syncProvider.status}
        />);

  const navLink = ([key, label, Icon]) => <a key={key} href={workspaceHref(key, { sample: currentSample, record: selectedRecord })} aria-current={(productMode ? canonicalPage : screen) === key ? 'page' : undefined} onClick={(e) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); navigate(key); }}><Icon size={16} strokeWidth={1.8} aria-hidden="true" />{productMode && key === 'sandbox' ? 'Upload and seal' : label}</a>;
  return <div className={`app-shell${canonicalPage ? ` canonical-page canonical-${canonicalPage}` : ''}`}>
    <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
    <aside className="workbench-rail" aria-label="HashWing">
      <a className="brand" href={productMode ? '/overview' : '#/'} onClick={(e) => { e.preventDefault(); if(productMode)navigate('overview');else setHashRoute('#/'); }}><span className="brand-mark" aria-hidden="true">H</span><span>HashWing</span></a>
      <button type="button" className="rail-menu" aria-expanded={menuOpen} aria-controls="primary-nav" onClick={() => setMenuOpen((open) => !open)}><Menu size={16} aria-hidden="true" />Menu</button>
      <nav id="primary-nav" className={`nav${menuOpen ? ' open' : ''}`} aria-label="Primary navigation">
        {(productMode ? CANONICAL_NAV : PRIMARY_NAV).map(navLink)}
        {!productMode && <details ref={moreRef} className="nav-more" onKeyDown={closeDisclosure}><summary>More tools</summary>{MORE_NAV.map(navLink)}</details>}
      </nav>
      <div className="rail-foot"><span className="local-dot" aria-hidden="true" />Local files</div>
        <details className="workspace-tools-menu" onKeyDown={closeDisclosure}><summary>Other apps</summary><div>{SUITE_LINKS.map((tool) => tool.state === 'unavailable' ? <span key={tool.name} aria-disabled="true">{tool.name} · unavailable (HTTP 404)</span> : <a key={tool.name} href={tool.href} target="_blank" rel="noreferrer">{tool.name}</a>)}</div></details>
    </aside>
    <div className="workspace">
    <header className="topbar commandbar">
      <h1 id={`page-${screen}`} tabIndex="-1">{pageTitle}</h1>
      <div className="command-actions">
        <nav hidden={!!canonicalPage || activeSession?.kind === 'account'} className="workspace-persistent-actions" aria-label="Account and workspace"><a href="#/login">Log in</a><a href="#/signup">Create account</a></nav>

        {!canonicalPage && profileControls}

      </div>
    </header>
    <section hidden={(!!canonicalPage && canonicalPage!=='workbench') || screen === 'protect'} className="session-strip" aria-label="Current session">
      <span id="session-file-name" className="session-name" title={selectedFileName || 'Choose a source or sealed log'}>{selectedFileName ? `Selected: ${selectedFileName}` : 'Choose a source or sealed log'}</span>
      {result && <span className="session-result-name">Checked: {result.label}</span>}
      {result && <button type="button" className="hash-copy" title={`Copy full chain head ${result.native.head}`} onClick={async () => { try { await navigator.clipboard.writeText(result.native.head); setOperationStatus('Chain head copied.'); } catch { setError('Clipboard access is unavailable. Select the full hash in the report.'); } }}><span>Copy hash</span><code>{`${result.native.head.slice(0, 10)}…${result.native.head.slice(-8)}`}</code></button>}
      {hasImportedOutput && <button type="button" className="clear-session" onClick={clearImportedSession}>Clear imported session</button>}
    </section>
    <main id="main" className="page-wrap" tabIndex="-1">
    <details hidden={(!!canonicalPage && canonicalPage!=='workbench') || screen === 'protect'} className="source-actions" open={screen === 'sandbox'} onKeyDown={closeDisclosure}><summary>Source and report actions</summary><div className="source-action-items">
        <label className="command-file-wrap" htmlFor="workbench-file"><span className="visually-hidden">Choose source or sealed log</span><input id="workbench-file" ref={workbenchFileRef} className="command-file-input" type="file" accept=".fseal,.ulg,.tsv,.txt,.tlog,.csv,.json,application/octet-stream,text/plain,application/json,text/csv" disabled={!!busy} aria-label="Choose source or sealed log" aria-describedby="session-file-name" onChange={(e) => chooseWorkbenchFile(e.target.files?.[0] || null)} /></label>
        <button className="button secondary command-seal" type="button" onClick={() => { if (sealFileInput) runSeal(); else { sealPickerRef.current = true; workbenchFileRef.current?.click(); } }} disabled={!!busy}><FileCheck2 size={16} aria-hidden="true" />Seal new log</button>
        {result && <button className="button primary command-export" type="button" onClick={downloadPdf} disabled={!!busy}>Export PDF</button>}

    </div></details>


      {error && <div role="alert" className="alert error-alert"><strong>Could not finish</strong><p>{error}</p><button type="button" className="button secondary" onClick={() => setError('')}>Dismiss</button></div>}
      {busy && <div className="busy-card" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" />{busy}<button className="button secondary" type="button" onClick={cancel}>Cancel</button></div>}
      {operationStatus && !busy && <p className={`operation-status${/before treating|unavailable/i.test(operationStatus) ? ' warning' : ''}`} role="status">{operationStatus}</p>}


      {screen === 'overview' && <section className="overview-content" aria-label="Flight evidence overview">
        <section className="panel"><div className="panel-body"><h2>Flight-log integrity</h2><p>Seal telemetry, check its hash chain, and inspect signed receipts.</p><div className="actions-row"><button className="button primary" disabled={!!busy} onClick={()=>{navigate('sandbox');loadDemo(false);}}>Verify included flight log</button><a className="button secondary" href="/workbench" onClick={event=>{event.preventDefault();navigate('workbench');}}>Open workbench</a></div></div></section>
        <dl className="overview-facts"><div><dt>Current result</dt><dd>{result ? resultTitle[0] : 'No log checked in this tab'}</dd></div><div><dt>Records checked</dt><dd>{result ? fmtBig(result.native.records) : 'Unavailable'}</dd></div><div><dt>Offline verifier</dt><dd>{offlineReady ? 'Ready' : offlineStatus || 'Checking…'}</dd></div></dl>
        <server-workspace view="overview" />
      </section>}
      {canonicalPage === 'workbench' && <nav className="workbench-tabs" aria-label="Log workflow"><a href={workspaceHref('sandbox',{sample:currentSample,record:selectedRecord})} aria-current={screen==='sandbox'?'page':undefined} onClick={event=>{event.preventDefault();navigate('sandbox');}}>Seal and inspect</a><a href={workspaceHref('verify',{sample:currentSample,record:selectedRecord})} aria-current={screen==='verify'?'page':undefined} onClick={event=>{event.preventDefault();navigate('verify');}}>Verify receipts</a><a href="#/app/records">Records</a><a href="#/app/receipts">Receipts</a><a href="#/app/video">Video alignment</a></nav>}
      {screen === 'reports' && <section aria-label="Evidence and saved reports"><server-workspace view="reports" />
        <section className="panel"><div className="panel-body"><h2>Current evidence</h2>{result ? <><button className="button primary" onClick={downloadPdf}>Download PDF</button><ResultPanel result={result} resultTitle={resultTitle} reportText={reportText} onDownloadText={()=>download('verification-report.txt',reportText)} onDownloadMarkdown={()=>download('verification-report.md',reportMarkdown)} onDownloadJson={()=>download('verification-report.json',reportJson,'application/json')} onNavigate={navigate} onShare={()=>setShareDialogOpen(true)} /></> : <p>No checked evidence in this tab. Open Workbench to verify a log, or select a saved run above.</p>}</div></section>
        <details className="report-details"><summary>Benchmarks and recovery evidence</summary><BenchmarkPage /></details>
      </section>}
      {screen === 'settings' && <section aria-label="Workspace settings"><server-workspace view="settings" /><details className="report-details"><summary>Browser profiles and encrypted backups</summary>{profileControls}</details><SystemPage /></section>}
      {canonicalPage === 'workbench' && <server-workspace view="workbench" />}
      {screen === 'system' && <SystemPage />}
      {screen === 'benchmarks' && <BenchmarkPage />}
      {screen === 'not-found' && <section className="screen"><section className="panel empty-state" aria-labelledby="not-found-title"><h2 id="not-found-title">Page not found</h2><p>The address does not match a HashWing page.</p><button className="button primary" type="button" onClick={() => navigate('sandbox')}>Return to samples</button></section></section>}

      {screen === 'protect' && <section className="screen protect-screen" aria-label="Seal and send">
        {protectMode === 'embedded' && <p className="lede">Seal a flight log as soon as you download it, then send one short receipt to someone you trust: your company, client or insurer. Later, anyone with that receipt can prove the file was not changed and get the exact original back. Files never leave this device.</p>}
        <fieldset className="mode-choice"><legend>What are you sealing?</legend>
          <label><input type="radio" name="protect-mode" value="manifest" checked={protectMode === 'manifest'} disabled={!!busy} onChange={() => setProtectMode('manifest')} />Large files (fingerprint only)</label>
          <label><input type="radio" name="protect-mode" value="embedded" checked={protectMode === 'embedded'} onChange={() => setProtectMode('embedded')} />Small file (seal the whole file, up to 45 MiB)</label>
        </fieldset>
        {/* Kept mounted while hidden, so switching modes never drops a running hash or an unsaved sealed list. */}
        <div className="section-grid" hidden={protectMode !== 'manifest'}><ManifestSeal signingKey={signingKey} onActiveChange={setManifestActive} /><ManifestCheck /></div>
        {protectMode === 'embedded' && <div className="section-grid">
          <section className="panel" aria-labelledby="seal-title"><div className="panel-head"><FileLock2 aria-hidden="true" size={18} /><h2 id="seal-title">Seal a flight log</h2></div><div className="panel-body">
            <p>For the pilot or operator. Works with any log file: PX4 <code>.ulg</code>, ArduPilot <code>.bin</code>, DJI flight records, CSV and others. The exact bytes are sealed.</p>
            <label className="field-label" htmlFor="protect-file">Flight log file <span>(up to {RAW_MAX_BYTES / 1024 / 1024} MiB)</span></label>
            <input id="protect-file" type="file" onChange={(e) => { invalidateCheck(); setProtectFile(e.target.files?.[0] || null); setProtectSealed(null); setProtectResult(null); setRestored(null); setCopyStatus(''); setError(''); }} />
            <p className="field-hint">{signingKey?.privateKeyPem ? 'The signing key loaded under Settings (kept in this tab only) will sign the receipt, so every flight you seal with it carries the same public key.' : 'No signing key loaded: a key is made for this file only and discarded. Load or generate a key under Settings to use one identity across flights.'}</p>
            <button className="button primary" type="button" disabled={!protectFile || !!busy} onClick={runProtectSeal}>Seal this log</button>
            {protectSealed && <div className="handover">
              <h3>Send this receipt to someone else now</h3>
              <p>Protection depends on it. A copy kept only by you could be rewritten together with the file.</p>
              <label className="field-label" htmlFor="handover-text">Receipt message</label>
              <textarea id="handover-text" className="mono-input" readOnly rows={9} value={protectSealed.handover} />
              <div className="actions-row">
                <button className="button primary" type="button" onClick={copyHandover}><Copy aria-hidden="true" size={16} />Copy message</button>
                <a className="button secondary" href={`mailto:?subject=${encodeURIComponent(`HashWing receipt for ${protectSealed.name}`)}&body=${encodeURIComponent(protectSealed.handover)}`}><Mail aria-hidden="true" size={16} />Email it</a>
                <button className="button secondary" type="button" onClick={() => download(`${protectSealed.name}.receipt.txt`, protectSealed.handover)}><Download aria-hidden="true" size={16} />Download receipt</button>
              </div>
              {copyStatus && <p className="field-hint" role="status">{copyStatus}</p>}
              <h3>Keep the sealed file</h3>
              <p>It holds your original log, byte for byte. Store it like the original and send it when someone asks for this flight.</p>
              <button className="button secondary" type="button" onClick={() => download(protectSealed.log.name, protectSealed.log, 'application/octet-stream')}><Download aria-hidden="true" size={16} />Download sealed file</button>
              <p className="field-hint">{protectSealed.savedKey ? 'Signed with the key loaded under Settings. Anyone holding that private key can sign other files, so keep its backup private.' : 'The signing key was made for this file only and was discarded, never stored or exported, so no further receipt can be made with it.'} Anyone can seal a different file with another key; that is why the receipt you send now is what counts later. Sealing shows the file has not changed since now; it cannot show what happened before you sealed it.</p>
            </div>}
          </div></section>
          <section className="panel" aria-labelledby="check-title"><div className="panel-head"><ShieldCheck aria-hidden="true" size={18} /><h2 id="check-title">Check a sealed log</h2></div><div className="panel-body">
            <p>For whoever kept the receipt: an operator's company, a client, an insurer or an investigator.</p>
            <label className="field-label" htmlFor="check-file">Sealed file <span>(.fseal)</span></label>
            <input id="check-file" type="file" accept=".fseal,application/octet-stream" onChange={(e) => { invalidateCheck(); setCheckFile(e.target.files?.[0] || null); setProtectResult(null); setRestored(null); setError(''); }} />
            <label className="field-label" htmlFor="check-text">Receipt message you were sent</label>
            <textarea id="check-text" className="mono-input" rows={6} value={checkText} spellCheck="false" aria-describedby="check-text-hint" onChange={(e) => { invalidateCheck(); setCheckText(e.target.value); setProtectResult(null); setRestored(null); setError(''); }} />
            <p id="check-text-hint" className="field-hint">Use the copy you received when the flight was sealed, not one that arrives with the file now.</p>
            <button className="button primary" type="button" disabled={!checkFile || !checkText.trim() || !!busy} onClick={runProtectCheck}>Check this log</button>
            {result && result === protectResult && checkFile && result.file === checkFile && <p className="field-hint" role="note">This result compares the file with the receipt message you pasted. It means something only if you received that message directly from the pilot or operator when the flight was sealed.</p>}
            {restored && restored !== 'none' && result === protectResult && <div className="restored">
              <h3>{restored.matches ? 'Original file recovered' : 'Recovered file does not match'}</h3>
              <dl className="detail-grid"><dt>Name</dt><dd className="wrap">{restored.name}</dd><dt>Size</dt><dd>{fmtBytes(restored.bytes)}</dd><dt>SHA-256</dt><dd><code>{restored.actualSha256}</code></dd></dl>
              {restored.matches ? <button className="button secondary" type="button" onClick={() => download(restored.name, restored.data, 'application/octet-stream')}><Download aria-hidden="true" size={16} />Download original file</button> : <p>Do not rely on this file.</p>}
            </div>}
            {restored === 'none' && result === protectResult && <p className="field-hint">This log holds decoded flight records rather than a whole sealed file, so there is no original file to download.</p>}
          </div></section>
        </div>}
        {protectMode === 'embedded' && result && result === protectResult && <ResultPanel result={result} resultTitle={resultTitle} reportText={reportText} onDownloadText={() => download('hashwing-verification-report.txt', reportText)} onDownloadMarkdown={() => download('hashwing-evidence-report.md', reportMarkdown, 'text/markdown;charset=utf-8')} onDownloadJson={() => download('hashwing-verification-report.json', reportJson, 'application/json')} onNavigate={navigate} onShare={() => setShareDialogOpen(true)} />}
      </section>}

      {screen === 'sandbox' && <section className="screen" aria-label="Samples and sealing">
        <section className="sandbox-tools" aria-label="Samples">
          <div className="sample-toolbar"><div className="sample-choice"><button className="button primary" type="button" onClick={() => loadDemo(false)}>Load 800-record demo</button><small>800 records · 107 KiB</small></div><div className="sample-choice"><button className="button secondary" type="button" onClick={() => loadDemo(true)}>Load PX4 sample</button><small>2,422 records · 748 KiB</small></div><div className="sample-choice"><button className="button secondary" type="button" onClick={() => loadDemo('full')}>Load full PX4 sample</button><small>64,542 records · 28.9 MiB</small></div><div className="sample-choice"><button className="button secondary" type="button" onClick={loadTelemetrySample}>Load telemetry sample</button><small>256 decoded points</small></div><span className="sample-current"><strong>{demoLabel || 'No sample loaded'}</strong>{result && <span>{fmtBig(result.native.records)} records · {fmtBytes(result.file.size)}</span>}</span></div>
        </section>
        {demoLabel.includes('PX4') && <p className="sample-note">PX4 samples contain selected decoded records, not every byte of the original ULog. The bundled key authenticates this fixture only.{demoLabel.includes('full') && <> <a href="/flightseal/samples/px4-full-provenance.json">Source and sealing provenance</a>.</>}</p>}
        {result?.source && demoLabel.includes('Synthetic telemetry') && <p className="sample-note">Synthetic telemetry sample; not flight evidence.</p>}
        <QuickStart completed={[!!result, !!result, false]} dismissed={quickStartDismissed} exportReady={!!result} onDismiss={() => { setQuickStartDismissed(true); try { localStorage.setItem(quickStartStorageKey, 'dismissed'); } catch { setOperationStatus('Quick start hidden for this tab only; browser storage is unavailable.'); } }} onRestart={() => { setQuickStartDismissed(false); try { localStorage.removeItem(quickStartStorageKey); } catch {} }} onOpenSample={() => loadDemo(false)} onInspect={() => navigate('records')} onExport={downloadEvidenceBundle} />
        {result && <ResultPanel result={result} resultTitle={resultTitle} reportText={reportText} onDownloadText={() => download('hashwing-verification-report.txt', reportText)} onDownloadMarkdown={() => download('hashwing-evidence-report.md', reportMarkdown, 'text/markdown;charset=utf-8')} onDownloadJson={() => download('hashwing-verification-report.json', reportJson, 'application/json')} onNavigate={navigate} onShare={() => setShareDialogOpen(true)} />}
        {result?.source && <FlightTelemetry source={result.source} points={telemetry} verificationProblem={result.indexed.problem} selectedPointIndex={selectedTelemetryIndex} onMovePoint={(pointIndex) => { const point = telemetry[pointIndex]; if (!point) return; telemetrySelectionRef.current++; setSelectedTelemetryIndex(pointIndex); setSelectedRecord(Number(point.record)); setPage(Math.floor(Number(point.record) / PAGE_SIZE)); }} onSelectPoint={(pointIndex) => { const point = telemetry[pointIndex]; if (!point) return; telemetrySelectionRef.current++; setSelectedTelemetryIndex(pointIndex); setSelectedRecord(Number(point.record)); setPage(Math.floor(Number(point.record) / PAGE_SIZE)); navigate('records'); }} />}
        <div className="section-grid">
          <section className="panel"><div className="panel-head"><FlaskConical aria-hidden="true" size={18} /><h2>Mutations</h2></div><div className="panel-body"><div className="mutation-list"><button className="mutation" type="button" disabled={!result || !!busy} onClick={(event) => doMutation('flip', event.currentTarget)}><span>Flip one payload byte</span></button><button className="mutation" type="button" disabled={!result || !!busy} onClick={(event) => doMutation('delete', event.currentTarget)}><span>Remove one middle record</span></button><button className="mutation" type="button" disabled={!result || !!busy} onClick={(event) => doMutation('truncate', event.currentTarget)}><span>Trim seven tail bytes</span></button></div></div></section>
          <section className="panel"><div className="panel-head"><FileCheck2 aria-hidden="true" size={18} /><h2>Seal</h2></div><div className="panel-body"><p>Create a sealed log from a timestamped source.</p><p className="field-hint">TSV, CSV, JSON or MAVLink <code>.tlog</code>. Converted values are canonicalized; MAVLink frame CRC is not checked.</p><details className="report-details import-details"><summary>Import details <ChevronDown size={17} aria-hidden="true" /></summary><div className="prose"><p>TSV/TXT uses <code>timestamp_us&lt;TAB&gt;payload</code>. CSV opens a bounded preview and requires explicit column and unit mapping before conversion. JSON accepts an array of objects with an unsigned <code>timestamp_us</code>. MAVLink .tlog records use their 8-byte big-endian timestamps; frame checksum/CRC_EXTRA validation is not performed.</p><p>CSV timestamp units must be microseconds. Coordinates require both latitude and longitude in degrees; altitude is mapped in meters and speed in meters per second. All original CSV columns remain in each payload and the mapping is saved in provenance. Unsupported/conflicting unit labels are rejected. JSON fields use the documented names and units; unknown names are not guessed. Missing/null coordinates stay unavailable. TSV/TXT sources are limited to {fmtBytes(SEAL_MAX_BYTES)}; CSV, JSON and .tlog conversion to 16 MiB. To seal any other log file byte for byte, use Seal &amp; send.</p></div></details><button className="button secondary" type="button" onClick={() => { sealPickerRef.current = true; workbenchFileRef.current?.click(); }}>Choose telemetry source</button>{csvDraft && <CsvMappingEditor draft={csvDraft} setDraft={setCsvDraft} onConvert={convertCsvDraft} onCancel={() => { setCsvDraft(null); if (workbenchFileRef.current) workbenchFileRef.current.value = ''; setOperationStatus('CSV mapping canceled. No source was converted or sealed.'); }} busy={!!busy} />}{sealSourceMetadata && <TelemetrySourcePreview source={sealSourceMetadata} original={sealSourceOriginal} />}<section className="signing-key-controls" aria-labelledby="signing-key-title"><h3 id="signing-key-title">Ed25519 signing key</h3><p>Use a generated or imported key instead of the ephemeral default. The private key stays in tab memory and is never saved. Key possession does not verify operator identity.</p><div className="actions-row"><button type="button" className="button secondary" onClick={generateSigningKey}>Generate Ed25519 key</button><label className="button secondary key-import-button" htmlFor="private-key-file">Import private PEM<input id="private-key-file" type="file" accept=".pem,application/x-pem-file,text/plain" onChange={(event) => { const file = event.target.files?.[0] || null; event.target.value = ''; importSigningKey(file); }} /></label>{signingKey && <><button type="button" className="button secondary" onClick={downloadPrivateKeyBackup}>Download private-key backup</button>{signingKey.publicKeyHex && <button type="button" className="button secondary" onClick={downloadSigningPublicKey}>Download public key</button>}<button type="button" className="text-action" onClick={clearSigningKey}>Clear key</button></>}</div>{signingKey && <p role="status">{signingKey.origin}{signingKey.publicKeyHex ? ` · public key ${signingKey.publicKeyHex}` : ' · import the matching public key separately'}</p>}<p className="field-hint">A plaintext backup is created only after you choose Download. Store it securely outside this browser profile.</p></section><label className="field-label" htmlFor="receipt-interval">Receipt interval (records)</label><input id="receipt-interval" type="number" min="1" max="1000000" value={sealInterval} onChange={(e) => { invalidateCheck(); setSealInterval(e.target.value); }} /><button className="button primary" type="button" disabled={!sealFileInput || !!busy} onClick={runSeal}>Seal and verify</button>{sealOutput && <div className="seal-outputs"><p>Generated from <strong>{sealOutput.filename}</strong>.</p><button className="button secondary" onClick={() => download('sealed.fseal', sealOutput.log, 'application/octet-stream')}>Download sealed log</button><button className="button secondary" onClick={() => download('sealed.receipts', sealOutput.receipts)}>Download receipts</button><button className="button secondary" onClick={() => download('sealed-public-key.txt', sealOutput.publicKey + '\n')}>Download public key</button><p>Keep receipts and public key with a separate witness. The private key is not included in these outputs.</p><label className="output-ack"><input type="checkbox" checked={sealOutputAcknowledged} onChange={(e) => setSealOutputAcknowledged(e.target.checked)} /> I saved these files or no longer need them</label></div>}</div></section>
        </div>
      </section>}

      {screen === 'verify' && <section className="screen verify-layout" aria-labelledby="verify-title">
        <section className="panel verify-demo" aria-labelledby="verify-demo-title"><div className="panel-head"><FlaskConical aria-hidden="true" size={18} /><h2 id="verify-demo-title">Try a sample integrity check</h2></div><div className="panel-body">
          <p>Check whether a sealed flight log has changed and review its signed receipts.</p>
          <p className="field-hint">Included synthetic sample: 800 records, 8 receipts. The bundled demo signer identifies this fixture only.</p>
          <label className="field-label" htmlFor="verify-scenario">Sample scenario</label>
          <select id="verify-scenario" value={demoScenario} disabled={!!busy} onChange={(event) => setDemoScenario(event.target.value)}><option value="intact">Original sample · valid</option><option value="byte-flip">Payload byte flip · detected failure</option></select>
          <div className="actions-row"><button className="button primary" type="button" disabled={!!busy} onClick={() => loadDemo(demoScenario)}>Run Interactive Demo</button><button className="button secondary" type="button" disabled={!!busy || currentSample !== 'intact' || result?.native.status !== 'intact' || result?.file.name !== 'intact.fseal' || Number(result?.native.records) < 1} onClick={() => loadDemo('byte-flip')}>Simulate Tampering</button><button className="button secondary" type="button" disabled={!!busy || !['intact', 'byte-flip'].includes(currentSample)} onClick={() => loadDemo(false)}>Restore Original</button></div>
          {quickStartDismissed ? <button className="text-action" type="button" onClick={() => setQuickStartDismissed(false)}>Show demo guidance</button> : <div className="demo-guidance"><p>Pick a sample, inspect or change the copy, then verify the outcome.</p><button className="text-action" type="button" onClick={() => setQuickStartDismissed(true)}>Dismiss guidance</button></div>}
          {currentSample === 'byte-flip' && result?.native.status === 'bad-link' && <p className="sample-note">The copy changed at record 0 (the first record). Its stored hash no longer matches the payload. The original sample, receipts and public key were retained unchanged. Restore Original runs a new verification.</p>}
          <details className="report-details"><summary>Technical Diagnostics <ChevronDown size={17} aria-hidden="true" /></summary><div className="prose"><p>The copy flips the first payload byte of zero-based record 0 and recomputes CRC-32, while retaining the stored hash link and original Ed25519 receipts. The C++/OpenSSL WebAssembly verifier detects the hash mismatch. No receipt is re-signed.</p><p>A passing result establishes file integrity against the supplied fixture key, not sensor truth, operator identity or independent custody.</p></div></details>
        </div></section>
        <div className="panel verify-panel"><div className="panel-head"><ShieldCheck aria-hidden="true" size={18} /><h2 id="verify-title">Verification inputs</h2></div><div className="panel-body input-grid"><div><label className="field-label" htmlFor="log-input">HashWing / FlightSeal .fseal log <span>(up to {fmtBytes(MAX_UI_BYTES)})</span></label><input id="log-input" type="file" accept=".fseal,application/octet-stream" onChange={(e) => chooseLog(e.target.files?.[0] || null)} /></div><div><label className="field-label" htmlFor="receipt-input">Witness receipts <span>(optional)</span></label><input id="receipt-input" ref={receiptInputRef} type="file" accept=".receipts,text/plain" aria-invalid={receiptInputError ? 'true' : undefined} aria-describedby={receiptInputError ? 'receipt-input-error' : undefined} onChange={(e) => chooseReceipts(e.target.files?.[0] || null)} />{receiptLoading && <p className="field-hint" role="status">Reading receipts…</p>}{receiptInputError && <p id="receipt-input-error" className="field-hint receipt-error">{receiptInputError}</p>}{receiptSelected && <button className="button secondary remove-receipts" type="button" onClick={removeReceipts}>Remove receipts</button>}</div><div className="field-wide"><label className="field-label" htmlFor="trusted-key">Public key for receipt check <span>(64 lowercase hexadecimal digits)</span></label><input id="trusted-key" className="mono-input" value={keyText} onChange={(e) => { invalidateCheck(); setKeyText(e.target.value); }} autoComplete="off" spellCheck="false" /><TrustedKeyPinControls value={keyText} onUse={(value) => { invalidateCheck(); setKeyText(value); }} /></div><div className="field-wide actions-row"><button className="button primary" type="button" disabled={!logFile || logFile.size > MAX_UI_BYTES || receiptLoading || !!receiptInputError || !!busy} onClick={verifyPicked}>Run check</button><button className="button secondary" type="button" disabled={!!busy} onClick={() => loadDemo(false)}>Load included 800-record demo</button></div></div></div>{result && <ResultPanel result={result} resultTitle={resultTitle} reportText={reportText} onDownloadText={() => download('hashwing-verification-report.txt', reportText)} onDownloadMarkdown={() => download('hashwing-evidence-report.md', reportMarkdown, 'text/markdown;charset=utf-8')} onDownloadJson={() => download('hashwing-verification-report.json', reportJson, 'application/json')} onNavigate={navigate} onShare={() => setShareDialogOpen(true)} />}</section>}

      {screen === 'records' && <section className="screen">{!result ? <EmptyState onNavigate={navigate} /> : <div className="records-layout"><section className="panel records-panel"><div className="panel-head"><List aria-hidden="true" size={18} /><h2>Records <span className="subcount">{fmtBig(result.native.records)}</span></h2></div><ol className="record-list">{pageRows.map((row, localIndex) => { const index = Number(row.index ?? rowStart + localIndex); const broken = !!result.indexed.problem && index === Number(result.indexed.problem.record); return <li key={index} className={`${broken ? 'record-broken' : 'record-pass'} ${index === selectedRecord ? 'selected' : ''}`}><button type="button" aria-current={index === selectedRecord ? 'true' : undefined} onClick={() => setSelectedRecord(index)}><span className="record-index">{fmtBig(index)}</span><span className="record-status">{broken ? `${problemLabel(result.indexed.problem.token)} (${result.indexed.problem.token})` : 'Checked'}</span><span className="record-bytes">{row.len == null ? 'problem row' : fmtBytes(row.len)}</span></button></li>; })}</ol><div className="pagination"><button className="button secondary" disabled={page === 0} onClick={() => setPage(0)}>First</button><button className="button secondary" disabled={page === 0} onClick={() => setPage((v) => Math.max(0, v - 1))}>Previous</button><span>Page {page + 1} of {pageCount}</span><button className="button secondary" disabled={page >= pageCount - 1} onClick={() => setPage((v) => Math.min(pageCount - 1, v + 1))}>Next</button><button className="button secondary" disabled={page >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>Last</button></div></section><section className="panel detail-panel" aria-labelledby="record-detail-title"><div className="panel-head"><FileCheck2 aria-hidden="true" size={18} /><h2 id="record-detail-title">Record {fmtBig(selectedRecord)}</h2></div><div className="panel-body">{recordError ? <div role="alert" className="alert error-alert"><p>{recordError}</p><button className="button secondary" onClick={() => loadRecord(selectedRecord)}>Retry</button></div> : !recordDetail ? <p className="muted" role="status">Loading record…</p> : <><div className="detail-actions"><button className="button secondary" type="button" onClick={() => navigate('video')}>Video</button></div><RecordDetail record={recordDetail} /></>}</div></section></div>}</section>}

      {screen === 'receipts' && <section className="screen">{!result ? <EmptyState onNavigate={navigate} /> : <section className="panel"><div className="panel-head"><Stamp aria-hidden="true" size={18} /><h2 id="receipt-heading">Receipts</h2></div><p className="receipt-overview">{fmtBig(result.receiptCoverage?.covered ?? result.native.covered)} records covered by a trusted receipt · {fmtBig(result.receiptCoverage?.uncovered ?? result.native.uncovered)} uncovered</p>{result.needsTrustedKey && <p className="muted">Hash chain checked; receipt signatures remain unchecked until a trusted public key is entered.</p>}{activeReceiptChecks.length ? <div className="table-scroll" role="region" aria-labelledby="receipt-heading" tabIndex="0" onKeyDown={(event) => { if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && event.currentTarget.scrollWidth > event.currentTarget.clientWidth) { event.preventDefault(); event.currentTarget.scrollLeft += event.key === 'ArrowRight' ? 48 : -48; } }}><table><thead><tr><th scope="col">Receipt</th><th scope="col">After records</th><th scope="col">Check</th><th scope="col">Head</th><th scope="col">Signing key</th></tr></thead><tbody>{activeReceiptChecks.map((receipt, i) => <tr key={`${receipt.count}-${i}`} id={`receipt-${i+1}`} tabIndex={route.params.get('receipt')===String(i+1)?-1:undefined} aria-current={route.params.get('receipt')===String(i+1)?'true':undefined}><td>{i + 1}</td><td className="numeric">{fmtBig(receipt.count)}</td><td><span className={`status-label ${receipt.check === 'ok' ? 'ok' : receipt.check === 'wrong-key' || receipt.check === 'bad-signature' ? 'bad' : 'warn'}`}>{receipt.description}</span></td><td><code>{receipt.head}</code></td><td><code>{receipt.key}</code></td></tr>)}</tbody></table></div> : <div className="panel-body"><p>{result.receipts ? 'No receipts authenticated.' : 'No receipts provided.'}</p></div>}</section>}</section>}

      {screen === 'video' && <section className="screen"><section className="panel"><div className="panel-head"><Video aria-hidden="true" size={18} /><h2>Local clip</h2></div><div className="panel-body video-grid"><label className="field-label" htmlFor="video-input">Video file</label><input id="video-input" type="file" accept="video/*" onChange={(e) => inspectVideo(e.target.files?.[0] || null)} /><video ref={videoRef} src={videoUrl || undefined} controls playsInline aria-label="Selected local video preview" onLoadedMetadata={(e) => { const media = e.currentTarget; const url = videoUrlRef.current; const metadata = { duration: media.duration, width: media.videoWidth, height: media.videoHeight }; if (!url || media.currentSrc !== url) return; setVideoInfo((v) => v && v.url === url ? { ...v, ...metadata, state: 'Browser metadata available. Codec identification is unknown.' } : v); }} onCanPlay={() => setVideoInfo((v) => v && ({ ...v, playable: true }))} onError={() => setVideoInfo((v) => v && ({ ...v, playable: false, state: 'The browser could not read metadata or play this stream. Codec identification is unknown.' }))} />{result && <div className="video-sync-controls"><p className="field-hint">Timestamps may be boot-relative. Alignment is a playback aid, not signed capture-time proof.</p><label className="field-label" htmlFor="video-record-range">Record</label><input id="video-record-range" type="range" min="0" max={Math.max(0, totalRows - 1)} value={Math.min(selectedRecord, Math.max(0, totalRows - 1))} disabled={totalRows < 2} onChange={(e) => { const next = Number(e.target.value); setSelectedRecord(next); setPage(Math.floor(next / PAGE_SIZE)); }} /><p><strong>Selected record {fmtBig(selectedRecord)}</strong>{selectedTelemetryPoint ? ` · telemetry from record ${fmtBig(selectedTelemetryPoint.record)} at ${fmtBig(selectedTelemetryPoint.timestampUs)} µs` : selectedTimestamp == null ? ' · timestamp unavailable' : ` · ${fmtBig(selectedTimestamp)} µs`}{selectedTelemetryPoint?.sourceOffset == null ? '' : ` · source byte ${selectedTelemetryPoint.sourceOffset}`}</p><p>Time base: {firstTimestamp == null ? 'unavailable' : `${fmtBig(firstTimestamp)} µs at first telemetry sample`}</p><label className="field-label" htmlFor="video-offset">Manual offset (seconds)</label><input id="video-offset" type="number" step="any" value={videoOffset} onChange={(e) => setVideoOffset(e.target.value)} /><button className="button primary" type="button" disabled={!videoInfo?.duration || selectedTimestamp == null || firstTimestamp == null} onClick={syncVideo}>Sync to record</button></div>}{videoInfo && <div className="video-meta" role="status"><strong>{videoInfo.name}</strong><span>{fmtBytes(videoInfo.size)}</span>{videoInfo.duration != null && <span>{Number.isFinite(videoInfo.duration) ? `${videoInfo.duration.toFixed(2)} seconds` : 'Duration unavailable'}</span>}{videoInfo.width && <span>{videoInfo.width} × {videoInfo.height} pixels</span>}<p>{videoInfo.state}</p>{videoInfo.syncMessage && <p>{videoInfo.syncMessage}</p>}<p>Video stays local. Codec is not inferred when unavailable.</p></div>}{!result && <p className="muted">Verify a log to align video.</p>}</div></section></section>}

      {screen === 'help' && <section className="screen help-layout"><section className="panel"><div className="panel-head"><CircleHelp aria-hidden="true" size={18} /><h2>Trust and limits</h2></div><div className="panel-body prose"><h3>Formats</h3><p>HashWing verifies .fseal logs, FlightSeal receipt v1 files, and supported PX4 ULog captures. Sealed output remains compatible with FlightSeal tools.</p><h3>Integrity and authenticity</h3><p>Sealing happens after download; it does not prove acquisition time or sensor truth. An intact chain confirms internal links only. A supplied public key is not automatically a trusted identity. Receipt v1 has no signed issue time. PX4 samples contain selected decoded records, not every byte of the original ULog. A chain head is not a whole-file SHA-256 digest.</p><h3>Independent witness</h3><p>Coverage reports how many records supplied receipts cover. Detecting a shortened or rebuilt log requires an independent holder to retain those receipts. Confirm the public key with that holder through another channel.</p><h3>Failures</h3><p>Verification stops at the first inconsistent record. A chain break identifies the first bad link, not every changed record. A torn tail may indicate an interrupted write. HashWing does not repair supplied files.</p><h3>Local handling</h3><p>Files are analyzed on this device. Save current run uploads the selected source, checked log, receipts and report to your private server workspace when available. Private signing keys and video are excluded. Exported verification reports contain verdicts, counts and hashes, not record payloads. The C++/OpenSSL WebAssembly engine checks the chain; a separate JavaScript index loads record details. Engine version appears in each report. The app shell and included samples are cached after online setup; the full PX4 sample is fetched separately and may not be available offline. This AI-assisted project requires human review of generated code and documentation.</p><h3>Reports</h3><p>PDF exports carry ordered heading and paragraph tags plus document language, but are not certified PDF/UA. The screen-reader workflow has not been validated; use the text report as the accessible reading alternative or JSON for structured data.</p><p><a href="https://github.com/anirudh763/flightseal" target="_blank" rel="noreferrer">Source and issue tracker</a></p></div></section><section className="panel limits-panel"><div className="panel-head"><h2>Limits</h2></div><div className="panel-body"><dl><dt>Verify file size</dt><dd>{fmtBytes(MAX_UI_BYTES)}</dd><dt>Native import limit</dt><dd>{fmtBytes(IMPORT_MAX_BYTES)}</dd><dt>Seal TSV/TXT source</dt><dd>{fmtBytes(SEAL_MAX_BYTES)}</dd><dt>Seal &amp; send file</dt><dd>{fmtBytes(RAW_MAX_BYTES)}</dd><dt>Manifest items</dt><dd>{MANIFEST_LIMITS.maxItems}</dd><dt>Manifest payload</dt><dd>64 KiB</dd><dt>CSV/JSON/.tlog conversion</dt><dd>16 MiB</dd><dt>Receipt text</dt><dd>4 MiB</dd><dt>Records per page</dt><dd>50</dd><dt>Telemetry plot</dt><dd>1,000 sampled points</dd><dt>Payload display</dt><dd>4 KiB per record</dd></dl></div></section></section>}
      {(!canonicalPage || canonicalPage === 'settings') && (offlineStatus || waitingUpdate || installKind !== 'none') && <details className="install-tools" onKeyDown={closeDisclosure}><summary>Offline and installation</summary><section className="offline-controls" aria-label="Offline and installation controls"><p className="offline-note" role="status">{offlineStatus || (offlineReady ? 'Offline verifier is ready on this device.' : 'Offline use needs a one-time online preparation.')}</p><div className="offline-control-actions"><button type="button" className="button secondary" onClick={prepareOffline}>Prepare offline</button>{waitingUpdate && <button type="button" className="button secondary" onClick={activateWaitingUpdate}>Apply safe update</button>}<button type="button" className="button secondary" onClick={installApp}>{installKind === 'ios' ? 'Add to Home Screen help' : installPrompt ? 'Install HashWing' : 'Install help'}</button><button type="button" className="text-action" onClick={() => setFeedbackDialogOpen(true)}>Report a bug</button></div></section></details>}
    </main>
    <FooterLinks onFeedback={() => setFeedbackDialogOpen(true)} onInstall={installApp} />
    <InstallGuide open={installDialogOpen} onClose={() => setInstallDialogOpen(false)} ios={installKind === 'ios'} />
    <FeedbackDialog key={`feedback-${privateResetVersion}`} open={feedbackDialogOpen} onClose={() => setFeedbackDialogOpen(false)} route={route.route} />
    <ShareDialog key={`share-${privateResetVersion}`} isOwnerCurrent={() => authEpochRef.current === renderedAuthEpoch} open={shareDialogOpen} onClose={() => setShareDialogOpen(false)} summary={shareSummary} shareUrl={shareUrl} onShare={async (data) => { if (!(await invokeNativeShare(data))) throw new Error('Native sharing is unavailable.'); }} />
    </div>
  </div>;
}

const LANDING_MENUS = [
  { id: 'features', label: 'Features', columns: [
    [['Verify a log', 'Check chain integrity and inspect the first failure.', '/app/verify', ShieldCheck], ['Seal after download', 'Create a local hash chain and portable receipts.', '/app/sandbox', FileCheck2]],
    [['Inspect records', 'Browse indexed records and selected details.', '/app/records', List], ['Review receipts', 'Check signatures and record coverage separately.', '/app/receipts', Stamp]],
    [['Align local video', 'Use record timestamps as a playback aid.', '/app/video', Video], ['Trust and limits', 'Read what the evidence does and does not establish.', '/app/help', CircleHelp]],
  ] },
  { id: 'use-cases', label: 'Use Cases', columns: [
    [['After a flight', 'Seal a downloaded log without claiming capture-time proof.', '/app/sandbox', FileCheck2], ['Independent review', 'Hand off a log, receipts and public key.', '/app/receipts', Stamp]],
    [['Changed file', 'Locate the first inconsistent record and byte offset.', '/app/verify', ShieldCheck], ['Local inspection', 'Review selected records and supported telemetry.', '/app/records', MapPin]],
  ] },
  { id: 'how-it-works', label: 'How It Works', columns: [
    [['Choose a source', 'Work with a local .fseal log, ULog or timestamped TSV.', '/app/verify', FileUp], ['Check the chain', 'The browser runs the native C++ verifier locally.', '/app/verify', ShieldCheck]],
    [['Keep portable evidence', 'Export reports and retain receipts with a separate witness.', '/app/receipts', ArrowRight]],
  ] },
  { id: 'trust', label: 'Trust / Docs', columns: [
    [['Trust boundaries', 'Integrity is separate from sensor truth and key identity.', '/app/help', CircleHelp], ['Source and security', 'Review source, format contracts and reporting guidance.', 'https://github.com/anirudh763/flightseal', LockKeyhole]],
  ] },
  { id: 'tools', label: 'More Tools', columns: [SUITE_LINKS.map((tool) => [
    `${tool.name}${tool.state === 'unavailable' ? ' · currently unavailable (HTTP 404)' : ''}`,
    tool.state === 'unavailable' ? 'Configured destination; last checked 2026-11-15 and returned 404.' : 'Open this separate tool. No files or account data are transferred.',
    tool.href,
    ArrowRight,
    tool.state,
  ])] },
];

function SkipLink({ targetId = 'main' }) {
  return <a className="skip-link" href={`#${targetId}`} onClick={(event) => { event.preventDefault(); document.getElementById(targetId)?.focus(); }}>{'Skip to content'}</a>;
}

function LandingPage({ onProtect, onDemo, onContinue, result, busy, error, installKind, onInstall, onFeedback, installOpen, onInstallClose, feedbackOpen, onFeedbackClose, route }) {
  const [openMenu, setOpenMenu] = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [slide, setSlide] = useState(0);
  const [paused, setPaused] = useState(false);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const navRef = useRef(null);
  const menuButtonRefs = useRef(new Map());
  const clickedMenuRef = useRef(null);
  const previewRef = useRef(null);
  const slides = [
    { title: 'Selected source', text: 'Included 800-record demonstration log', kind: 'source', label: 'intact.fseal', meta: '107 KiB · local file', state: 'Ready to inspect' },
    { title: 'Separate verdicts', text: 'Integrity, receipt signatures and coverage are distinct checks.', kind: 'verdict', label: 'INTACT', meta: 'Signature checked · 800 covered · 0 uncovered', state: 'Included demonstration fixture' },
    { title: 'First failure', text: 'A changed file reports the first inconsistent record and byte offset.', kind: 'failure', label: 'First failure', meta: 'Record · offset · expected · actual', state: 'Values come from the selected file' },
    { title: 'Portable handoff', text: 'Keep the log, receipts and public key together for another reviewer.', kind: 'handoff', label: 'Evidence bundle', meta: 'Log · receipts · public key · text / JSON / PDF', state: 'No cloud custody or legal certification' },
  ];

  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    if (paused || pointerInside || focusInside || reducedMotion) return undefined;
    const timer = setInterval(() => setSlide((current) => (current + 1) % slides.length), 6000);
    return () => clearInterval(timer);
  }, [paused, pointerInside, focusInside, reducedMotion, slides.length]);
  useEffect(() => {
    const close = (event) => {
      if (event.key !== 'Escape') return;
      if (openMenu) {
        event.preventDefault();
        const button = menuButtonRefs.current.get(openMenu);
        setOpenMenu(null);
        button?.focus();
      } else if (mobileOpen) {
        event.preventDefault(); setMobileOpen(false); document.querySelector('.landing-mobile-toggle')?.focus();
      }
    };
    addEventListener('keydown', close);
    return () => removeEventListener('keydown', close);
  }, [openMenu, mobileOpen]);

  const renderMenu = (menu) => <div className="landing-nav-item" key={menu.id} onMouseEnter={() => setOpenMenu(menu.id)}>
    <button ref={(node) => node && menuButtonRefs.current.set(menu.id, node)} type="button" className="landing-nav-trigger" aria-expanded={openMenu === menu.id} aria-controls={`mega-${menu.id}`} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpenMenu(menu.id); requestAnimationFrame(() => document.querySelector(`#mega-${menu.id} a`)?.focus()); } }} onClick={() => { if (openMenu === menu.id && clickedMenuRef.current === menu.id) { clickedMenuRef.current = null; setOpenMenu(null); } else { clickedMenuRef.current = menu.id; setOpenMenu(menu.id); } }}>{menu.label}<ChevronDown size={14} aria-hidden="true" /></button>
    <div id={`mega-${menu.id}`} className="mega-menu" hidden={openMenu !== menu.id}>
      {menu.columns.map((column, columnIndex) => <div className="mega-column" key={`${menu.id}-${columnIndex}`}>{column.map(([title, description, href, Icon, state]) => { const external = href.startsWith('http'); const target = external ? href : `#${href}`; const unavailable = state === 'unavailable'; return <a key={title} href={target} aria-disabled={unavailable ? 'true' : undefined} target={external && !unavailable ? '_blank' : undefined} rel={external && !unavailable ? 'noreferrer' : undefined} className={`mega-link${unavailable ? ' is-unavailable' : ''}`} onClick={(event) => { if (unavailable) { event.preventDefault(); return; } setOpenMenu(null); setMobileOpen(false); }}><Icon size={17} aria-hidden="true" /><span><strong>{title}</strong><small>{description}</small></span><ArrowRight size={14} aria-hidden="true" /></a>; })}</div>)}
    </div>
  </div>;

  return <div className="landing-page">
    <SkipLink />
    <header className="landing-header" onMouseLeave={() => { setOpenMenu(null); clickedMenuRef.current = null; }}>
      <a className="landing-brand" href="#/"><span className="brand-mark" aria-hidden="true">H</span><span>HashWing</span></a>
      <button className="landing-mobile-toggle" type="button" aria-expanded={mobileOpen} aria-controls="landing-navigation" onClick={() => setMobileOpen((value) => !value)}><Menu size={18} aria-hidden="true" />Menu</button>
      <nav id="landing-navigation" className={`landing-navigation${mobileOpen ? ' is-open' : ''}`} aria-label="Main navigation" ref={navRef}>
        <div className="landing-menu-items">{LANDING_MENUS.map(renderMenu)}</div>
        <div className="landing-actions"><button className="landing-demo" type="button" onClick={onDemo}>Run real verification <ArrowRight size={15} aria-hidden="true" /></button></div>
      </nav>
      <nav className="landing-persistent-actions" aria-label="Account and workspace"><a href="#/login">Log in</a><a href="#/signup">Create account</a><button type="button" onClick={onContinue}>Launch Workspace</button></nav>
    </header>
    <main id="main" className="landing-main" tabIndex="-1">
      <section className="landing-hero" aria-labelledby="page-landing">
        <div className="landing-hero-copy"><p className="landing-kicker">Local flight log verification</p><h1 id="page-landing" tabIndex="-1">Check the log.<br />Keep the evidence.</h1><p className="landing-lede">Seal a downloaded flight log, verify its chain, and hand off receipts for independent review.</p><div className="landing-hero-actions"><button className="landing-demo" type="button" onClick={onProtect}>Seal a flight log <ArrowRight size={16} aria-hidden="true" /></button><button className="landing-secondary-button" type="button" onClick={onDemo} disabled={!!busy}>Run real verification</button><a href="#/signup" className="landing-secondary">Create account</a><button type="button" className="landing-secondary-button" onClick={onContinue}>Launch Workspace</button></div><p className="landing-local-note"><LockKeyhole size={14} aria-hidden="true" />Files are analyzed locally. Uploads require Save current run; private keys and video stay in this tab.</p></div>
        {busy && <p role="status" className="hero-verify-status">{busy}</p>}
        {error && <p role="alert" className="hero-verify-error">{error}</p>}
        {result && <section className="hero-actual-result" aria-label="Live verification result"><div><span>Actual C++ / OpenSSL / WebAssembly result</span><strong>{humanStatus(result.overallVerdict || result.native.verdict)[0]}</strong></div><dl><div><dt>Chain</dt><dd>{humanStatus(result.native.status)[0]}</dd></div><div><dt>Receipts</dt><dd>{result.needsTrustedKey ? 'Signature unchecked' : result.receiptChecks.length ? 'Checked against bundled demo key' : 'Not supplied'}</dd></div><div><dt>Coverage</dt><dd>{fmtBig(result.receiptCoverage?.covered ?? result.native.covered)} / {fmtBig(result.native.records)}</dd></div></dl><p>Integrity does not establish sensor truth, capture time, identity or independent custody.</p><button className="button secondary" type="button" onClick={onContinue}>Inspect records and export <ArrowRight size={15} aria-hidden="true" /></button></section>}
        <div className="preview-stage" ref={previewRef} aria-label="HashWing product preview" onMouseEnter={() => setPointerInside(true)} onMouseLeave={() => setPointerInside(false)} onFocusCapture={() => setFocusInside(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusInside(false); }}>
          <div className="preview-stage-head"><span>Product preview</span><span className="fixture-tag">Included fixture</span></div>
          <div className="preview-slides">{slides.map((item, index) => <article key={item.kind} className={`preview-slide preview-${item.kind}`} hidden={index !== slide} aria-hidden={index !== slide}>
            <div className="preview-window"><div className="preview-window-top"><span className="preview-glyph">H</span><span>HashWing <small>/ {item.title}</small></span><span className="preview-local">Local</span></div>
              {item.kind === 'source' && <div className="preview-source"><div><span>Selected source</span><strong>{item.label}</strong><small>{item.meta}</small></div><span className="preview-source-state"><Check size={14} aria-hidden="true" /> {item.state}</span></div>}
              {item.kind === 'verdict' && <div className="preview-verdict"><div className="preview-result"><span className="result-check"><Check size={17} aria-hidden="true" /></span><span><strong>{item.label}</strong><small>{item.state}</small></span></div><div className="preview-checks"><div><span>Chain integrity</span><b>Intact</b></div><div><span>Receipt signature</span><b>Checked</b></div><div><span>Receipt coverage</span><b>800 / 800</b></div></div><small className="preview-note">{item.meta}</small></div>}
              {item.kind === 'failure' && <div className="preview-failure"><span className="preview-alert">First failure</span><p>{item.text}</p><dl><dt>Record</dt><dd>From selected file</dd><dt>Byte offset</dt><dd>From selected file</dd><dt>Expected / actual</dt><dd>Shown in report</dd></dl><small>{item.state}</small></div>}
              {item.kind === 'handoff' && <div className="preview-handoff"><div className="handoff-mark"><Stamp size={22} aria-hidden="true" /><span>{item.label}</span></div><div className="handoff-files"><span>flight.fseal</span><span>flight.receipts</span><span>public-key.txt</span></div><div className="handoff-actions"><span>Download text</span><span>Download JSON</span><span>Export PDF</span></div><small>{item.state}</small></div>}
            </div>
            <p className="preview-caption">{item.text}</p>
          </article>)}</div>
          <div className="preview-controls"><div role="group" aria-label="Choose product preview">{slides.map((item, index) => <button key={item.kind} type="button" aria-pressed={slide === index} aria-label={`Show ${item.title} preview`} onClick={() => setSlide(index)}>{item.title}</button>)}</div><button className="preview-pause" type="button" disabled={reducedMotion} aria-label={reducedMotion ? 'Autoplay disabled by reduced motion' : paused ? 'Play previews' : 'Pause previews'} onClick={() => setPaused((value) => !value)}>{paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{reducedMotion ? 'Reduced motion' : paused ? 'Play' : 'Pause'}</button></div>
        </div>
      </section>
      <section className="landing-proof" aria-label="What HashWing checks"><article><h2>Integrity</h2><p>Verify linked records and locate the first failure.</p></article><article><h2>Receipt signatures</h2><p>Check a supplied signature against a key you trust.</p></article><article><h2>Coverage</h2><p>See which records receipts cover and which remain uncovered.</p></article><article><h2>Handoff</h2><p>Keep portable logs, receipts, keys and readable reports.</p></article></section>
      <section className="mavframe-handoff" aria-labelledby="mavframe-handoff-title"><div><span className="landing-kicker">Separate tool · no file transfer</span><h2 id="mavframe-handoff-title">Continue with a raw telemetry capture</h2><p>Mavframe accepts .tlog and raw MAVLink v1/v2 streams. HashWing accepts .fseal, PX4 .ulg, timestamped TSV/TXT, CSV, JSON and MAVLink .tlog. These formats are not interchangeable. To inspect a capture in Mavframe, open it there separately; no local file is sent in this link.</p></div><a href="https://anirudh763.github.io/mavframe/" target="_blank" rel="noreferrer">Open Mavframe <ArrowRight size={15} aria-hidden="true" /></a></section>
      <section className="landing-how" aria-labelledby="how-title"><div><span className="landing-kicker">A local workflow</span><h2 id="how-title">From download to review</h2></div><ol><li><span>Choose</span><p>Open a flight log from this device, or start with the included sample.</p></li><li><span>Verify or seal</span><p>Check an existing chain, or seal a downloaded TSV after the flight.</p></li><li><span>Hand off</span><p>Share the log, receipts and public key with a reviewer through a separate channel.</p></li></ol></section>
      <section className="landing-trust" aria-labelledby="trust-title"><div><span className="landing-kicker">Trust boundaries</span><h2 id="trust-title">Integrity has a clear limit.</h2></div><p>An intact chain does not prove sensor truth, acquisition time, legal certification or independent custody. A supplied public key is not automatically a trusted identity. HashWing runs locally and has no cloud receipt service.</p><a href="/flightseal/console/#/app/help">Read trust and format details <ArrowRight size={15} aria-hidden="true" /></a></section>
      <section className="team-access" aria-labelledby="team-access-title"><div><span className="landing-kicker">Optional · prospective service</span><h2 id="team-access-title">Team &amp; Cloud Early Access</h2><p>Local verification remains free. This form is for interest in possible future team workflows; no hosted service or waitlist is active unless a remote endpoint is configured.</p></div><TeamAccessForm /></section>
    </main>
    <FooterLinks onFeedback={onFeedback} onInstall={onInstall}>
    <div className="landing-footer"><a className="landing-brand" href="#/"><span className="brand-mark" aria-hidden="true">H</span><span>HashWing</span></a><span>Free local tools · No paid tiers</span><nav aria-label="Footer links"><a href="#/app/help">Trust and docs</a><a href="https://github.com/anirudh763/flightseal" target="_blank" rel="noreferrer">Source</a><a href="#/login">Log in</a></nav></div>
    </FooterLinks>
    <InstallGuide open={installOpen} onClose={onInstallClose} ios={installKind === 'ios'} />
    <FeedbackDialog open={feedbackOpen} onClose={onFeedbackClose} route={route} />
  </div>;
}

function TeamAccessForm() {
  const [email, setEmail] = useState('');
  const [teamSize, setTeamSize] = useState('');
  const [useCase, setUseCase] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState('');
  const endpoint = typeof __EARLY_ACCESS_ENDPOINT__ === 'undefined' ? '' : __EARLY_ACCESS_ENDPOINT__;
  const submit = async (event) => {
    event.preventDefault(); setStatus(''); setRequestError('');
    if (!event.currentTarget.reportValidity()) return;
    const request = { email: email.trim(), teamSize, useCase: useCase.trim() };
    if (!endpoint || !navigator.onLine) {
      try {
        localStorage.setItem('flightseal_early_access_draft_v1', JSON.stringify({ ...request, savedAt: new Date().toISOString(), delivery: 'local-draft-only' }));
        setStatus('Local draft saved in this browser. No request was sent or remotely received.');
      } catch { setRequestError('Could not save this local draft. Browser storage may be blocked or full.'); }
      return;
    }
    setPending(true);
    try {
      await deliverEarlyAccessRequest(endpoint, request);
      setStatus('Request received by the configured endpoint.');
    } catch (cause) { setRequestError(`${cause?.message || 'Could not reach the configured endpoint.'} Your request was not queued; retry explicitly when online or save a local draft.`); }
    finally { setPending(false); }
  };
  return <form className="team-access-form" onSubmit={submit}>
    <label htmlFor="team-email">Email</label><input id="team-email" type="email" autoComplete="email" maxLength="254" required value={email} onChange={(event) => setEmail(event.target.value)} />
    <label htmlFor="team-size">Team size</label><select id="team-size" required value={teamSize} onChange={(event) => setTeamSize(event.target.value)}><option value="">Choose a range</option><option>1–5</option><option>6–20</option><option>21–100</option><option>101+</option></select>
    <label htmlFor="team-use-case">Use case</label><textarea id="team-use-case" maxLength="1000" rows="3" required value={useCase} onChange={(event) => setUseCase(event.target.value)} />
    <p className="team-access-privacy">{endpoint ? 'On submit, these three fields go to the configured public form endpoint. No logs or files are sent.' : 'No request endpoint is configured. Submit saves only a draft in this browser; it does not enroll you in a waitlist.'} Analytics are disabled.</p>
    {status && <p role="status" className="team-access-status">{status}</p>}{requestError && <p role="alert" className="team-access-error">{requestError}</p>}
    <button className="button secondary" type="submit" disabled={pending}>{pending ? 'Sending request…' : endpoint ? 'Send early access request' : 'Save local draft'}</button>
    {status && !endpoint && <button className="text-action" type="button" onClick={() => { localStorage.removeItem('flightseal_early_access_draft_v1'); setStatus('Local draft removed.'); }}>Remove local draft</button>}
  </form>;
}

function AuthPage({ mode, returnTo, guestCanImport, currentSampleName, outputNeedsAck, onReturnToWorkspace, expectedEpoch, isCurrent, onAuthAttempt, onLogin, onSignup, onComplete, onDemo, installKind, onInstall, onFeedback, installOpen, onInstallClose, feedbackOpen, onFeedbackClose, route }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [importGuest, setImportGuest] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const creating = mode === 'signup';
  const submit = async (event) => {
    event.preventDefault(); setError('');
    if (creating && password !== confirm) { setError('Passwords do not match.'); return; }
    if (expectedEpoch == null) { setError('This local session has changed. Reload and try again.'); return; }
    onAuthAttempt(email, mode);
    setPending(true);
    try {
      const profile = creating ? await onSignup(email, password, { isCurrent }) : await onLogin(email, password, { isCurrent });
      const result = await onComplete(profile, returnTo, creating && importGuest, expectedEpoch);
      if (result?.error) setError(result.error);
    } catch (cause) { setError(cause?.message || `Could not ${creating ? 'create' : 'open'} the local profile.`); }
    finally { setPending(false); }
  };
  return <div className="auth-page">
    <SkipLink targetId="auth-main" />
    <header className="auth-header"><a className="landing-brand" href="#/"><span className="brand-mark" aria-hidden="true">H</span><span>HashWing</span></a><nav className="auth-persistent-actions" aria-label="Account and workspace"><a href="#/login">Log in</a><a href="#/signup">Create account</a><a href="#/app/sandbox">Launch Workspace</a></nav><a href="#/">Home</a></header>
    <main id="auth-main" className={`auth-layout${creating ? ' auth-signup' : ''}`} tabIndex="-1">
      <section className="auth-context"><span className="landing-kicker">Local profile</span><h1>{creating ? 'Keep your workspace context.' : 'Return to your saved view.'}</h1><p>Profiles are stored only in this browser. They help restore an included-sample view; they do not upload files or create a cloud account.</p><ul><li><Check size={16} aria-hidden="true" />All HashWing tools stay free.</li><li><Check size={16} aria-hidden="true" />Flight logs, receipts and keys are not saved in a profile.</li><li><Check size={16} aria-hidden="true" />Passwords use a salted PBKDF2 verifier on this device.</li></ul><a href="#/app/help">Read local handling and trust limits <ArrowRight size={14} aria-hidden="true" /></a></section>
      <section className="auth-form-wrap" aria-labelledby={`page-${mode}`}><div className="auth-form-card"><p className="landing-kicker">{creating ? 'Create a local account' : 'Log in on this device'}</p><h2 id={`page-${mode}`} tabIndex="-1">{creating ? 'Create account' : 'Log in'}</h2><form onSubmit={submit} noValidate>
        {outputNeedsAck && <div className="auth-output-warning" role="alert"><p>A sealed output is still waiting to be downloaded or acknowledged in this tab.</p><button type="button" className="auth-return-workspace" onClick={onReturnToWorkspace}>Return to workspace</button></div>}
        <div className="auth-field"><label htmlFor="auth-email">Email</label><input id="auth-email" type="email" name="email" autoComplete="email" inputMode="email" maxLength="254" required value={email} onChange={(event) => setEmail(event.target.value)} /></div>
        <div className="auth-field"><label htmlFor="auth-password">Password</label><div className="auth-password-wrap"><input id="auth-password" type={showPassword ? 'text' : 'password'} name="password" autoComplete={creating ? 'new-password' : 'current-password'} minLength="12" maxLength="128" required value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="password-help" /><button type="button" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>{showPassword ? 'Hide' : 'Show'}</button></div><small id="password-help">Use 12–128 characters. Paste and password managers are supported.</small></div>
        {creating && <div className="auth-field"><label htmlFor="auth-confirm">Confirm password</label><input id="auth-confirm" type={showPassword ? 'text' : 'password'} name="confirm-password" autoComplete="new-password" minLength="12" maxLength="128" required value={confirm} onChange={(event) => setConfirm(event.target.value)} /></div>}
        {creating && guestCanImport && <label className="guest-import"><input type="checkbox" checked={importGuest} onChange={(event) => setImportGuest(event.target.checked)} /><span>Import this guest session's included-sample view ({currentSampleName || 'current sample'}). No file, key or payload is copied.</span></label>}
        {error && <p className="auth-error" role="alert">{error}</p>}
        {pending && <p className="auth-pending" role="status">{creating ? 'Creating local profile…' : 'Checking local profile…'}</p>}
        <button className="auth-submit" type="submit" disabled={pending || outputNeedsAck}>{creating ? 'Create account' : 'Log in'} <ArrowRight size={16} aria-hidden="true" /></button>
      </form>
      <div className="auth-switch">{creating ? <>Already have a local profile? <a href="#/login">Log in</a></> : <>New on this device? <a href="#/signup">Create account</a></>}</div>{guestCanImport && <button type="button" className="auth-return-workspace" onClick={onReturnToWorkspace}>Cancel and return to guest workspace</button>}
      <button className="auth-demo" type="button" disabled={outputNeedsAck} onClick={() => { if (onDemo() === false) setError('Download or acknowledge the pending sealed output first.'); }}><FlaskConical size={16} aria-hidden="true" />Continue with Demo</button>
      <p className="auth-recovery-note">No email, password-reset or cloud service is connected. If this browser's profile data is cleared, the profile cannot be recovered.</p>
      </div></section>
    </main>
    <FooterLinks onFeedback={onFeedback} onInstall={onInstall} />
    <InstallGuide open={installOpen} onClose={onInstallClose} ios={installKind === 'ios'} />
    <FeedbackDialog open={feedbackOpen} onClose={onFeedbackClose} route={route} />
  </div>;
}

function TrustedKeyPinControls({ value, onUse }) {
  const [name, setName] = useState('');
  const [pins, setPins] = useState(() => { try { return listTrustedKeys(); } catch { return []; } });
  const [message, setMessage] = useState('');
  const save = async () => {
    try {
      let pinned;
      try { pinned = await pinTrustedKey(name, value); }
      catch (cause) {
        if (!/Key changed for/.test(cause?.message || '') || !window.confirm(`${cause.message}\nOnly continue after checking the new fingerprint with the key holder through another channel.`)) throw cause;
        pinned = await pinTrustedKey(name, value, { confirmRotation: true });
      }
      setPins(listTrustedKeys()); setMessage(`Saved local pin ${pinned.name} · SHA-256 ${pinned.fingerprint}. This device decision does not verify pilot identity.`);
    } catch (cause) { setMessage(cause?.message || 'Could not save this public-key pin.'); }
  };
  return <div className="trusted-key-controls"><label className="field-label" htmlFor="trusted-key-profile">Named local public-key pin</label><select id="trusted-key-profile" defaultValue="" onChange={(event) => { const pin = pins.find((item) => item.name === event.target.value); if (pin) onUse(pin.publicKey); }}><option value="">Choose a saved key profile</option>{pins.map((pin) => <option key={pin.name} value={pin.name}>{pin.name} · {pin.fingerprint.slice(0, 16)}</option>)}</select><label className="field-label" htmlFor="trusted-key-name">Save or rotate key profile</label><input id="trusted-key-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="For example, Flight recorder 1" /><button type="button" disabled={!value || !name.trim()} onClick={save}>Pin public key on this device</button><p>Pinning is your local trust decision. Confirm every key rotation independently; a fingerprint is not a verified pilot identity.</p>{message && <p role="status">{message}</p>}</div>;
}

function EncryptedBackupControls({ profileId, isOwnerCurrent }) {
  const [passphrase, setPassphrase] = useState('');
  const [file, setFile] = useState(null);
  const [payload, setPayload] = useState(null);
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  const changeInput = () => { revision.current++; setBusy(false); setPayload(null); setPreview(null); setStatus(''); };
  const exportBackup = async () => {
    const operation = ++revision.current, isCurrent = () => operation === revision.current && isOwnerCurrent();
    setBusy(true); setStatus('');
    try {
      const backup = await createEncryptedProfileBackup(profileId, { passphrase, isCurrent });
      if (!isCurrent()) return;
      download('flightseal-encrypted-profile-backup.json', backup, 'application/vnd.flightseal.profile-backup+json');
      setStatus('Encrypted profile backup downloaded. Keep its passphrase separately. Sessions, private keys and flight files are excluded.');
    } catch (cause) { if (isCurrent()) setStatus(cause?.message || 'Could not create encrypted backup.'); }
    finally { if (isCurrent()) setBusy(false); }
  };
  const inspectBackup = async () => {
    const operation = ++revision.current, isCurrent = () => operation === revision.current && isOwnerCurrent();
    setBusy(true); setStatus(''); setPayload(null); setPreview(null);
    try {
      const decrypted = await inspectEncryptedProfileBackup(file, passphrase, { isCurrent });
      if (!isCurrent()) return;
      const nextPreview = previewBackupRestore(decrypted);
      setPayload(decrypted); setPreview(nextPreview);
      setStatus(`Restore preview: local profile ${nextPreview.email}; ${nextPreview.hasSavedView ? 'one saved included-sample view' : 'no saved view'}. No changes made.`);
    } catch (cause) { if (isCurrent()) setStatus(cause?.message || 'Could not open encrypted backup.'); }
    finally { if (isCurrent()) setBusy(false); }
  };
  const commit = async () => {
    if (!payload || !preview) return;
    const operation = ++revision.current, isCurrent = () => operation === revision.current && isOwnerCurrent();
    setBusy(true); setStatus('');
    try {
      await commitBackupRestore(payload, globalThis.localStorage, { isCurrent });
      if (!isCurrent()) return;
      setStatus(`Restored local profile ${preview.email}. Log in on this device to open its saved view.`);
      setPayload(null); setPreview(null); setFile(null);
    } catch (cause) { if (isCurrent()) setStatus(cause?.message || 'Restore failed. Existing data was not intentionally overwritten.'); }
    finally { if (isCurrent()) setBusy(false); }
  };
  return <section className="profile-backup" aria-label="Encrypted profile backup">
    <h2>Encrypted backup</h2>
    <label className="field-label" htmlFor="backup-passphrase">Backup passphrase</label>
    <input id="backup-passphrase" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={passphrase} onChange={(event) => { changeInput(); setPassphrase(event.target.value); }} placeholder="12–128 characters" />
    <button type="button" disabled={busy || !profileId || passphrase.length < 12} onClick={exportBackup}>Download encrypted backup</button>
    <label className="field-label" htmlFor="backup-file">Restore encrypted backup</label>
    <input id="backup-file" type="file" accept="application/vnd.flightseal.profile-backup+json,.json" onChange={(event) => { changeInput(); setFile(event.target.files?.[0] || null); }} />
    <button type="button" disabled={busy || !file || passphrase.length < 12} onClick={inspectBackup}>Check backup and preview</button>
    {preview && <button type="button" disabled={busy} onClick={commit}>Restore this profile</button>}
    {status && <p role="status">{status}</p>}
    <p>Encrypted with PBKDF2-SHA-256 and AES-256-GCM. No session, flight file, receipt, API secret or signing private key is included.</p>
  </section>;
}

function ProfileMenu({ isCurrent, session, profile, currentSample, savedContext, savedContextError, hasUnacknowledgedOutput, message, onSave, onRestore, onDeleteSaved, onRemoveProfile, onLogout, onNavigateAuth, syncStatus }) {
  const menuRef = useRef(null);
  const email = profile?.email || (session?.kind === 'guest' ? 'Demo session' : 'Workspace access');
  return <details className="profile-menu" ref={menuRef} onKeyDown={closeDisclosure}>
    <summary aria-label={session?.kind === 'account' ? `Profile menu for ${email}` : email}><UserRound size={15} aria-hidden="true" /><span>{email}</span><ChevronDown size={14} aria-hidden="true" /></summary>
    <div className="profile-menu-panel">
      <p className="profile-menu-identity"><strong>{email}</strong><span>{session?.kind === 'account' ? 'Local profile · this device only' : session?.kind === 'guest' ? 'Separate guest session' : 'No active session'}</span></p>
      <EncryptedBackupControls isOwnerCurrent={isCurrent} profileId={session?.kind === 'account' ? profile?.id : null} />
      <p className="profile-menu-note">Cloud sync: {syncStatus === 'configured' ? 'connector configured; local profiles are not cloud credentials' : 'not configured'}. No local logs or keys are uploaded.</p>
      {session?.kind === 'account' ? <>
        <button type="button" onClick={onSave} disabled={!currentSample || !!savedContextError}>Save included-sample view</button>
        <button type="button" onClick={onRestore} disabled={!savedContext}>Restore saved view{savedContext ? ` · ${savedContext.screen}` : ''}</button>
        {(savedContext || savedContextError) && <button type="button" onClick={onDeleteSaved}>{savedContextError ? 'Remove damaged saved view' : 'Remove saved view'}</button>}
        <p className="profile-menu-note">Files, receipts, keys and payloads are not saved.</p>
        {hasUnacknowledgedOutput && <p className="profile-menu-message" role="alert">Download or acknowledge the pending output before logging out.</p>}
        {savedContextError && <p className="profile-menu-message" role="alert">{savedContextError}</p>}
        {message && <p className="profile-menu-message" role="status">{message}</p>}
        <button type="button" className="profile-logout" disabled={hasUnacknowledgedOutput} onClick={onLogout}>Log out</button><button type="button" className="profile-remove" disabled={hasUnacknowledgedOutput} onClick={onRemoveProfile}>Remove local profile and saved view</button>
      </> : <>
        {session?.kind === 'guest' && <p className="profile-menu-note">Guest state is separate from every local profile.</p>}
        <button type="button" onClick={() => onNavigateAuth('signup')}>Create local account</button>
        <button type="button" onClick={() => onNavigateAuth('login')}>Log in</button>
        {session?.kind === 'guest' && <button type="button" className="profile-logout" disabled={hasUnacknowledgedOutput} onClick={onLogout}>End demo session</button>}
      </>}
    </div>
  </details>;
}

function EmptyState({ onNavigate }) { return <div className="empty-state"><h2>No file checked</h2><button className="button primary" onClick={() => onNavigate('verify')}>Verify a file</button></div>; }
function FlightTelemetry({ source, points, verificationProblem, selectedPointIndex, onMovePoint, onSelectPoint }) {
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
  if (!points.length) return <section className="telemetry-panel" aria-labelledby="telemetry-title"><div className="panel-head"><MapPin aria-hidden="true" size={17} /><h2 id="telemetry-title">Flight telemetry</h2></div><SourceMetadata source={source} />{verificationProblem && <p className="telemetry-note">First reported chain inconsistency is at log record {verificationProblem.record}; this does not identify every changed record.</p>}<p className="telemetry-empty">No valid coordinates are available for this source. Records remain available in the sealed log.</p></section>;
  const selectedPoint = selectedPointIndex == null ? null : points[selectedPointIndex];
  const pointControl = (index, label, rows) => {
    const active = rows.some((row) => row.index === selectedPointIndex) ? selectedPointIndex : rows[0]?.index;
    return {
    role: 'button', tabIndex: index === active ? 0 : -1, 'aria-pressed': index === selectedPointIndex, 'aria-label': `${label}${verificationProblem && Number(verificationProblem.record) === index ? '; first reported chain inconsistency at this log record' : ''}`, 'data-telemetry-index': index,
    onClick: () => onSelectPoint(index),
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectPoint(index); }
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        const ordered = rows.map((row) => row.index);
        const current = ordered.indexOf(index);
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
        const next = ordered[(current + step + ordered.length) % ordered.length];
        const svg = event.currentTarget.ownerSVGElement;
        onMovePoint(next);
        requestAnimationFrame(() => svg.querySelector(`[data-telemetry-index="${next}"]`)?.focus());
      }
    },
  }; };
  return <section className="telemetry-panel" aria-labelledby="telemetry-title">
    <div className="panel-head"><MapPin aria-hidden="true" size={17} /><h2 id="telemetry-title">Flight telemetry</h2><span className="subcount">{points.length.toLocaleString()} decoded points</span></div>
    {verificationProblem && <p className="first-failure-note">First reported chain inconsistency: log record {fmtBig(verificationProblem.record)}. This is the first detected failure, not a list of every modified record.</p>}<p className="telemetry-note">{source.format === 'MAVLink Tlog' ? 'Frame boundaries and recorded timestamps were parsed; MAVLink checksum/CRC_EXTRA was not verified, and this view does not decode message coordinates.' : source.format === 'CSV' || source.format === 'JSON' ? `${source.coordinateRecords || 0} records have valid recorded coordinates; ${source.coordinateLessRecords || 0} have none. Locations are untrusted recorded values, not physical truth.` : 'Supported PX4 fields and units only. Missing and custom fields are not inferred; recorded coordinates are not physical-truth evidence.'} Plots sample at most 1,000 points; multiple points may share a source record.</p>
    <SourceMetadata source={source} />
    <div className="telemetry-grid">
      <section className="telemetry-plot" aria-labelledby="gps-heading"><h3 id="gps-heading">Recorded coordinates <small>local plot · not independently verified</small></h3>{gps.length ? <svg className="gps-plot" viewBox="0 0 480 104" role="group" aria-label={`${gps.length} sampled recorded coordinates plotted locally; physical truth is not verified`}><path d={gpsPath} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />{gps.map(({ point, index }) => <circle {...pointControl(index, `Recorded coordinate for record ${point.record}, latitude ${point.latitudeDeg} degrees, longitude ${point.longitudeDeg} degrees, ${point.timestampUs} microseconds; not independently verified`, gps)} key={index} cx={gx(point.longitudeDeg)} cy={gy(point.latitudeDeg)} r={index === selectedPointIndex ? 5 : 2.5} className={index === selectedPointIndex ? 'selected-dot' : ''}><title>Record {point.record}: {point.latitudeDeg}, {point.longitudeDeg} at {point.timestampUs} µs</title></circle>)}{selectedGps && <text x={gx(selectedGps.point.longitudeDeg) + 8} y={gy(selectedGps.point.latitudeDeg) - 8}>Selected {selectedGps.point.timestampUs} µs</text>}</svg> : <p className="plot-empty">No valid coordinates are available for this source. Coordinate-less records remain in the sealed log.</p>}</section>
      <div className="series-plots">{series.map((item) => {
        const positions = positionsFor(item);
        const path = positions.map(({ x, y }, index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
        return <section className="telemetry-plot series-plot" key={item.field} aria-label={`${item.label} telemetry`}><h3>{item.label} <small>{item.unit}</small></h3>{item.rows.length ? <svg viewBox="0 0 480 100" role="group" aria-label={`${item.rows.length} ${item.label.toLowerCase()} samples by sample order`}><path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />{positions.map(({ point, index, x, y }) => <circle {...pointControl(index, `${item.label} record ${point.record}, ${point[item.field]} ${item.unit}, ${point.timestampUs} microseconds`, positions)} key={index} cx={x} cy={y} r={index === selectedPointIndex ? 4.5 : 2.2} className={index === selectedPointIndex ? 'selected-dot' : ''}><title>Record {point.record}: {point[item.field]} {item.unit} at {point.timestampUs} µs</title></circle>)}</svg> : <p className="plot-empty">No decoded {item.label.toLowerCase()} values.</p>}</section>;
      })}</div>
    </div>
    <div className="telemetry-selection"><label htmlFor="telemetry-point">Selected telemetry point</label><select id="telemetry-point" value={selectedPointIndex ?? ''} onChange={(event) => onSelectPoint(Number(event.target.value))}><option value="" disabled>Select a telemetry point</option>{displayPoints.map(({ point, index }) => <option key={index} value={index}>Record {point.record} · {point.timestampUs} µs{point.sourceOffset == null ? '' : ` · source byte ${point.sourceOffset}`} · {Number.isFinite(point.latitudeDeg) && Number.isFinite(point.longitudeDeg) ? 'GPS coordinates available' : 'location unavailable'}</option>)}</select>{selectedPoint && <span>Record {selectedPoint.record} · {selectedPoint.timestampUs} µs{selectedPoint.sourceOffset == null ? '' : ` · source byte ${selectedPoint.sourceOffset}`} · {Number.isFinite(selectedPoint.latitudeDeg) && Number.isFinite(selectedPoint.longitudeDeg) ? 'GPS coordinates available' : 'location unavailable'}</span>}<button type="button" className="button secondary" disabled={!selectedPoint} onClick={() => selectedPoint && onSelectPoint(selectedPointIndex)}>Inspect selected point</button></div>
  </section>;
}
function SourceMetadata({ source }) { return <dl className="source-metadata"><dt>Source</dt><dd>{source.format} · {fmtBytes(source.bytes)} · SHA-256 <code>{source.sha256}</code></dd></dl>; }
function CsvMappingEditor({ draft, setDraft, onConvert, onCancel, busy }) {
  const update = (field, value) => setDraft((current) => ({ ...current, mapping: { ...current.mapping, [field]: value } }));
  const fields = [
    ['timestampColumn', 'Timestamp column', 'timestampUnit', [['microseconds', 'Microseconds (µs)'], ['milliseconds', 'Milliseconds'], ['seconds', 'Seconds']], true],
    ['latitudeColumn', 'Latitude column', 'latitudeUnit', [['degrees', 'Degrees'], ['radians', 'Radians']], false],
    ['longitudeColumn', 'Longitude column', 'longitudeUnit', [['degrees', 'Degrees'], ['radians', 'Radians']], false],
    ['altitudeColumn', 'Altitude column', 'altitudeUnit', [['meters', 'Meters'], ['feet', 'Feet'], ['centimeters', 'Centimeters']], false],
    ['speedColumn', 'Speed column', 'speedUnit', [['meters per second', 'Meters per second'], ['knots', 'Knots'], ['kilometers per hour', 'Kilometers per hour']], false],
  ];
  const coordinatePairValid = !!draft.mapping.latitudeColumn === !!draft.mapping.longitudeColumn;
  const fieldsMapped = fields.every(([column, , unit, , required]) => required ? !!draft.mapping[column] && !!draft.mapping[unit] : !draft.mapping[column] || !!draft.mapping[unit]);
  return <section className="csv-mapping" aria-labelledby="csv-mapping-title">
    <h3 id="csv-mapping-title">Map CSV fields</h3>
    <p className="field-hint">{draft.file.name} · {draft.rows.toLocaleString()} data rows · choose columns and confirm their declared units. No headers or units are guessed.</p>
    <div className="csv-mapping-grid">{fields.map(([field, label, unitField, units, required]) => <div key={field}><label className="field-label" htmlFor={`csv-${field}`}>{label}{required ? ' (required)' : ' (optional)'}</label><select id={`csv-${field}`} value={draft.mapping[field]} onChange={(event) => { update(field, event.target.value); if (!event.target.value) update(unitField, ''); }}><option value="">{required ? 'Select a column' : 'Not mapped'}</option>{draft.headers.map((header) => <option key={header} value={header}>{header}</option>)}</select><label className="field-label" htmlFor={`csv-${unitField}`}>{label.replace(' column', '')} unit</label><select id={`csv-${unitField}`} value={draft.mapping[unitField]} disabled={!draft.mapping[field]} onChange={(event) => update(unitField, event.target.value)}><option value="">{draft.mapping[field] ? 'Declare the unit' : 'No field mapped'}</option>{units.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></div>)}</div>
    {!coordinatePairValid && <p className="mapping-error" role="alert">Map both latitude and longitude, or leave both unmapped.</p>}
    <div className="csv-preview-scroll" role="region" aria-label="CSV preview, first five rows" tabIndex="0"><table><caption>Preview · first {draft.preview.length} of {draft.rows.toLocaleString()} rows · original values</caption><thead><tr>{draft.headers.map((header) => <th scope="col" key={header}>{header}</th>)}</tr></thead><tbody>{draft.preview.map((row, index) => <tr key={index}>{draft.headers.map((header) => <td key={header}>{row[header]}</td>)}</tr>)}</tbody></table></div>
    <div className="actions-row"><button className="button primary" type="button" disabled={!!busy || !fieldsMapped || !coordinatePairValid} onClick={onConvert}>Convert mapped CSV</button><button className="button secondary" type="button" disabled={!!busy} onClick={onCancel}>Cancel mapping</button></div>
  </section>;
}
function RecordDetail({ record }) {
  const payload = record.payload || new Uint8Array();
  const flightRaw = new TextDecoder().decode(payload.subarray(0, 8)) === 'FSRAW001';
  const preview = flightRaw ? Array.from(payload.subarray(0, 64), (byte) => byte.toString(16).padStart(2, '0')).join(' ') : new TextDecoder().decode(payload.subarray(0, 4096)) || '(empty)';
  return <><dl className="detail-grid"><dt>File offset</dt><dd className="numeric">{fmtBig(record.offset)}</dd><dt>Payload length</dt><dd>{fmtBytes(record.length)}</dd><dt>Raw sequence</dt><dd className="numeric">{record.seq == null ? 'Missing' : fmtBig(record.seq)}</dd><dt>Timestamp</dt><dd className="numeric">{record.ts == null ? 'Missing' : `${fmtBig(record.ts)} µs`}</dd><dt>Stored link</dt><dd><code>{record.link || 'Unavailable'}</code></dd><dt>Stored CRC-32</dt><dd><code>{record.crc || 'Unavailable'}</code></dd></dl><h3>{flightRaw ? 'Source payload bytes · FSRAW001' : 'Payload excerpt'}</h3>{flightRaw && <p className="field-hint">Raw source bytes; telemetry shown separately.</p>}<pre className="payload mono">{preview}</pre></>;
}
function TelemetrySourcePreview({ source, original }) {
  const mappings = source.recordMappings || [];
  const csvMap = csvMappingSummary(source.fieldMapping);
  return <details className="source-preview" open>
    <summary>Review source mapping · {source.format} · {mappings.length.toLocaleString()} records</summary>
    <p>Original {source.filename || original?.name || 'file'} · {fmtBytes(source.bytes)} · SHA-256 <code>{source.sha256}</code></p>
    <p>{source.format === 'CSV' ? `Mapped CSV columns: ${csvMap}. The mapped time is encoded as canonical timestamp_us in microseconds.` : 'timestamp_us is an unsigned integer in microseconds and retains the original row order.'} Missing coordinates remain unavailable; no units are inferred. CSV headers and JSON keys are retained as payload fields. {source.format === 'MAVLink Tlog' ? 'Each MAVLink frame follows its 8-byte big-endian timestamp. CRC_EXTRA/checksum validation is not performed.' : ''}</p>
    <label className="field-label" htmlFor="source-mapping">First source record identifiers</label>
    <select id="source-mapping" size={Math.min(5, Math.max(2, Math.min(mappings.length, 5)))} aria-label="Source record mapping preview">
      {mappings.slice(0, 5).map((item) => <option key={item.record} value={item.record}>Normalized record {item.record} ← {item.sourceIdentifier}{item.sourceOffset == null ? '' : ` (byte ${item.sourceOffset})`}</option>)}
    </select>
    <p>All {mappings.length.toLocaleString()} mappings and source digest are included in the verification report. Original bytes are retained separately in the evidence ZIP.</p>
  </details>;
}
function ResultPanel({ result, resultTitle, reportText, onDownloadText, onDownloadMarkdown, onDownloadJson, onNavigate, onShare }) {
  const { native, indexed } = result;
  const [label, kind] = resultTitle;
  const problem = indexed.problem;
  const overallVerdict = result.overallVerdict || native.verdict;
  const nativeChainVerdict = native.status === 'intact' ? 'intact' : native.status === 'torn-tail' ? 'incomplete' : 'tampered';
  const chainDiffers = nativeChainVerdict !== overallVerdict;
  const nativeChainCondition = humanStatus(native.status === 'intact' ? 'intact' : native.status)[0];
  const applicationEvidence = result.needsTrustedKey ? 'Receipt signatures unchecked: trusted key missing.' : result.receiptChecks.length === 0 ? 'No receipts supplied; only the native hash chain was checked.' : result.receiptChecks.some((receipt) => receipt.check !== 'ok') ? 'Receipt evidence needs review.' : 'Receipt signatures match the supplied key.';
  const summary = chainDiffers
    ? `Native chain: ${nativeChainCondition}. Application evidence: ${applicationEvidence}`
    : native.status === 'intact'
      ? `${fmtBig(native.records)} records checked; ${fmtBig(result.receiptCoverage?.covered ?? native.covered)} receipt-covered; ${fmtBig(result.receiptCoverage?.uncovered ?? native.uncovered)} uncovered; ${fmtBig(native.timeReversals)} timestamp reversals. ${applicationEvidence}`
      : native.description || indexed.description || 'The first failure is shown below.';
  return <section className="result-panel panel" aria-labelledby="result-heading"><div className="result-top"><div><h2 id="result-heading"><span className="result-heading-live" role="status" aria-live="polite" aria-atomic="true"><span className={`status-shape ${kind}`} aria-hidden="true" />{label}</span></h2><p>{summary}</p></div><div className="result-stat"><strong>{fmtBig(native.records)}</strong><span>records checked</span></div></div><div className="stats-grid"><div><span>File</span><strong className="wrap">{result.label}</strong></div><div><span>Size</span><strong>{fmtBytes(result.file.size)}</strong></div><div><span>Good bytes</span><strong>{fmtBytes(native.goodBytes)}</strong></div><div><span>Chain head</span><code title={native.head}>{native.head.slice(0, 10)}…{native.head.slice(-8)}</code></div><div><span>Whole-file SHA-256</span><code title={native.fileSha256}>{native.fileSha256 || 'Unavailable'}</code></div><div><span>Receipt coverage</span><strong>{fmtBig(result.receiptCoverage?.covered ?? native.covered)} covered · {fmtBig(result.receiptCoverage?.uncovered ?? native.uncovered)} uncovered</strong></div><div><span>Time reversals</span><strong>{fmtBig(native.timeReversals)}</strong></div></div>{problem && <div className={`first-failure ${kind}`}><span className="eyebrow">FIRST FAILURE</span><strong>Record {fmtBig(problem.record)} · {problemLabel(problem.token)} <code>({problem.token})</code></strong><span>{problem.detail || problem.description || 'Verification stopped at the first inconsistent record.'}</span>{problem.expected != null && <div className="hash-comparison"><span>Expected</span><code>{String(problem.expected)}</code>{problem.actual != null && <><span>Actual</span><code>{String(problem.actual)}</code></>}</div>}<span>Offset {fmtBig(problem.offset)} bytes</span></div>}<div className="result-actions"><button className="button secondary" onClick={() => onNavigate('records')}>Records</button><button className="button secondary" onClick={() => onNavigate('receipts')}>Receipts</button><button className="button secondary" onClick={onDownloadText}>Download text report</button><button className="button secondary" onClick={onDownloadMarkdown}>Download Markdown report</button><button className="button secondary" onClick={onDownloadJson}>Download JSON</button><button className="button secondary" onClick={onShare}>Share summary</button></div><details className="report-details" aria-label="Text verification report"><summary><span>Text verification report</span><ChevronDown size={17} aria-hidden="true" /></summary><pre className="report-text">{reportText}</pre></details></section>;
}

// Large files (fingerprint only): originals stay on the operator's storage. State here never enters
// runVerify/result, so "Save current run" cannot upload it, and no file bytes, names or digests leave this device.
async function hashAll(files, signal, onProgress) {
  const out = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const started = performance.now();
    onProgress({ index, done: 0, started });
    let r;
    try { r = await hashFile(file, { signal, onProgress: (done) => onProgress({ index, done, started }) }); }
    catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      throw new Error(`Could not read ${file.name}. It may have been moved, changed or deleted after you chose it. Choose the files again and retry.`);
    }
    out.push({ name: file.name, bytes: r.bytes, sha256: r.sha256 });
  }
  return out;
}
const percent = (done, size) => (size ? Math.floor((done / size) * 100) : 100);
function FileProgressList({ files, progress, idPrefix, label, onCancel }) {
  return <ol className="manifest-file-list" aria-label={label}>{files.map((file, index) => {
    const done = !progress ? null : index < progress.index ? file.size : index === progress.index ? progress.done : 0;
    const active = progress?.index === index;
    const seconds = active ? (performance.now() - progress.started) / 1000 : 0;
    return <li key={`${index}-${file.name}`}>
      <div className="manifest-file-row"><span className="manifest-file-name">{file.name}</span><span className="mono-values">{fmtBytes(file.size)}</span></div>
      {done !== null && <div className="manifest-progress">
        <progress id={`${idPrefix}-progress-${index}`} aria-label={`${file.name} progress`} max={Math.max(1, file.size)} value={done} />
        <span className="mono-values">{percent(done, file.size)}%{active && seconds > 0.2 ? ` · ${(done / 1e6 / seconds).toFixed(1)} MB/s` : ''}</span>
        {active && <button className="button secondary" type="button" onClick={onCancel}>Cancel</button>}
      </div>}
    </li>;
  })}</ol>;
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const friendlyLimit = (cause) => cause instanceof RangeError && /exceeds 65536 bytes/.test(cause.message)
  ? 'The list is too long to seal. Turn off "Include file names", shorten the notes, or seal fewer files at a time.'
  : `${cause.message} Shorten it under More options, then press Seal again.`;

function ManifestSeal({ signingKey, onActiveChange }) {
  const [files, setFiles] = useState([]);
  const [includeNames, setIncludeNames] = useState(false);
  const [notes, setNotes] = useState({});
  const [progress, setProgress] = useState(null);
  const [phase, setPhase] = useState('');
  const [output, setOutput] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const controllerRef = useRef(null);
  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => { onActiveChange(!!phase || (!!output && !output.saved)); }, [phase, output, onActiveChange]);
  useEffect(() => () => onActiveChange(false), [onActiveChange]);
  const reset = () => { controllerRef.current?.abort(); setOutput(null); setMessage(''); setError(''); };
  const choose = (list) => {
    reset(); setNotes({});
    const picked = [...(list || [])];
    if (picked.length > MANIFEST_LIMITS.maxItems) { setFiles([]); setError(`You picked ${picked.length} files. Choose up to ${MANIFEST_LIMITS.maxItems} at a time, and seal the rest as a second list.`); return; }
    setFiles(picked);
  };
  const itemsFor = (digests) => files.map((file, index) => ({ bytes: digests ? digests[index].bytes : file.size, sha256: digests ? digests[index].sha256 : '0'.repeat(64), name: includeNames ? file.name : '', note: notes[index] || '' }));
  const seal = async () => {
    reset();
    // Same length as the real payload, so a long note or name fails now rather than after hours of hashing.
    try { encodeManifest({ salt: '0'.repeat(64), items: itemsFor(null) }); } catch (cause) { setError(friendlyLimit(cause)); return; }
    const controller = new AbortController(); controllerRef.current = controller;
    setPhase('hashing');
    try {
      const hashed = await hashAll(files, controller.signal, setProgress);
      const items = itemsFor(hashed);
      const payload = encodeManifest({ salt: newSalt(), items });
      setPhase('sealing'); setProgress(null);
      let sealed, check;
      try {
        sealed = await sealFile(manifestRecordsBlob(payload), { every: 1, signal: controller.signal, privateKeyPem: signingKey?.privateKeyPem || '' });
        check = await verifySealedManifest(sealed.log, sealed.receipts, sealed.publicKey);
      } catch (cause) {
        if (cause?.name === 'AbortError') throw cause;
        throw new Error(`Sealing failed (${cause?.message || 'unknown error'}). Press Seal again; if it keeps failing, reload the page.`);
      }
      if (!check.verified || check.manifest.items.length !== items.length) throw new Error(`The sealed result did not pass its own check, so it was discarded (${check.reason || 'item count differs'}). Press Seal again.`);
      const base = `hashwing-${stamp()}`;
      setOutput({
        base, publicKey: sealed.publicKey, items: items.length, total: hashed.reduce((sum, item) => sum + item.bytes, 0), saved: false,
        log: new File([sealed.log], `${base}.manifest.fseal`, { type: 'application/octet-stream' }),
        handover: manifestHandoverText({ items: items.length, receipts: sealed.receipts, publicKey: sealed.publicKey, sealedAt: new Date().toISOString() }),
      });
      setMessage('Sealed on this device.');
    } catch (cause) {
      if (cause?.name === 'AbortError') setMessage('Cancelled');
      else setError(cause?.message || 'Something went wrong. Press Seal again.');
    } finally { if (controllerRef.current === controller) { controllerRef.current = null; setPhase(''); setProgress(null); } }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(output.handover); setMessage('Receipt message copied. Paste it into an email or chat to the person who will keep it.'); }
    catch { setMessage('Your browser blocked copying. Select the text in the box and copy it, or press Download receipt.'); }
  };
  const busy = !!phase;
  const step = output ? 3 : files.length ? 2 : 1;
  return <section className="panel" aria-labelledby="manifest-seal-title"><div className="panel-head"><FileLock2 aria-hidden="true" size={18} /><h2 id="manifest-seal-title">Seal large files</h2></div><div className="panel-body manifest-body">
    <ol className="manifest-steps" aria-label="Steps">{['Choose files', 'Seal', 'Send'].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined}>{label}</li>)}</ol>
    <p className="manifest-notice"><strong>This keeps a fingerprint, not a copy.</strong> Keep your original files.</p>
    <details className="report-details manifest-help"><summary>What is this? <ChevronDown size={17} aria-hidden="true" /></summary><div className="manifest-options-body prose">
      <p>HashWing reads each file on this device and records its size and SHA-256 fingerprint. That list (a manifest) is signed and saved as a small .manifest.fseal file. The files themselves are not stored or uploaded. A manifest is not a backup.</p>
      <p>Later, anyone with the receipt message and your public key can check copies of the files against the list. A random salt makes each list unique; it does not hide the fingerprints.</p>
    </div></details>
    <label className="field-label" htmlFor="manifest-files">Files <span>(up to {MANIFEST_LIMITS.maxItems})</span></label>
    <input id="manifest-files" type="file" multiple disabled={busy} onChange={(e) => choose(e.target.files)} />
    {files.length > 0 && <FileProgressList files={files} progress={progress} idPrefix="manifest-seal" label="Selected files" onCancel={() => controllerRef.current?.abort()} />}
    {progress && <p className="visually-hidden" role="status">Reading file {progress.index + 1} of {files.length}</p>}
    {phase === 'sealing' && <p role="status">Sealing…</p>}
    <details className="report-details manifest-options"><summary>More options <ChevronDown size={17} aria-hidden="true" /></summary><div className="manifest-options-body">
      <label className="check-row"><input id="manifest-include-names" type="checkbox" checked={includeNames} disabled={busy} onChange={(e) => { reset(); setIncludeNames(e.target.checked); }} />Include file names</label>
      {files.map((file, index) => <div key={`${index}-${file.name}`}><label className="field-label" htmlFor={`manifest-note-${index}`}>Operator note for <span className="manifest-file-name">{file.name}</span> <span>(optional)</span></label><input id={`manifest-note-${index}`} type="text" value={notes[index] || ''} disabled={busy} onChange={(e) => { reset(); setNotes((current) => ({ ...current, [index]: e.target.value })); }} /></div>)}
      <p className="field-hint">Receipt interval: 1 record. {signingKey?.privateKeyPem ? 'Signed with the key loaded under Settings.' : 'No signing key loaded: a one-time key signs this list and is then discarded.'}</p>
    </div></details>
    <button className="button primary" type="button" disabled={!files.length || busy || !!output} onClick={seal}>Seal</button>
    {error && <p className="field-hint receipt-error" role="alert">{error}</p>}
    {message && <p className="field-hint" role="status">{message}</p>}
    {output && <div className="handover">
      <h3>Send this receipt to someone else now</h3>
      <dl className="detail-grid"><dt>Files</dt><dd className="mono-values">{output.items} · {fmtBytes(output.total)}</dd><dt>Public key</dt><dd><code className="wrap">{output.publicKey}</code></dd></dl>
      <label className="field-label" htmlFor="manifest-handover-text">Receipt message</label>
      <textarea id="manifest-handover-text" className="mono-input" readOnly rows={8} value={output.handover} />
      <div className="actions-row">
        <button className="button primary" type="button" onClick={copy}><Copy aria-hidden="true" size={16} />Copy message</button>
        <button className="button secondary" type="button" onClick={() => download(`${output.base}.receipt.txt`, output.handover)}><Download aria-hidden="true" size={16} />Download receipt</button>
        <button className="button secondary" type="button" onClick={() => download(`${output.base}.public-key.txt`, `${output.publicKey}\n`)}><Download aria-hidden="true" size={16} />Download public key</button>
      </div>
      <h3>Keep the sealed list</h3>
      <button className="button secondary" type="button" onClick={() => { download(output.log.name, output.log, 'application/octet-stream'); setOutput((current) => current && { ...current, saved: true }); }}><Download aria-hidden="true" size={16} />Download sealed list</button>
    </div>}
  </div></section>;
}

const STATUS_KIND = { match: 'ok', 'bytes-differ': 'warn', missing: 'grey', 'not-in-manifest': 'neutral' };
function ManifestCheck() {
  const [sealed, setSealed] = useState(null);
  const [text, setText] = useState('');
  const [key, setKey] = useState('');
  const [locals, setLocals] = useState([]);
  const [progress, setProgress] = useState(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [message, setMessage] = useState('');
  const controllerRef = useRef(null);
  const revisionRef = useRef(0);
  useEffect(() => () => controllerRef.current?.abort(), []);
  const changed = (apply) => { revisionRef.current++; controllerRef.current?.abort(); setOutcome(null); setMessage(''); apply(); };
  const run = async () => {
    const revision = ++revisionRef.current;
    const controller = new AbortController(); controllerRef.current = controller;
    setOutcome(null); setMessage(''); setRunning(true);
    try {
      const verified = await verifySealedManifest(sealed, text, key);
      if (revision !== revisionRef.current) return;
      if (!verified.verified) { setOutcome({ verified: false, reason: verified.reason }); return; }
      const hashed = await hashAll(locals, controller.signal, setProgress);
      if (revision !== revisionRef.current) return;
      setOutcome({ verified: true, manifest: verified.manifest, comparison: compareFiles(verified.manifest, hashed), locals: hashed });
    } catch (cause) {
      if (revision !== revisionRef.current && cause?.name === 'AbortError') return;
      setMessage(cause?.name === 'AbortError' ? 'Cancelled' : cause?.message || 'Something went wrong. Press Check files again.');
    } finally { if (controllerRef.current === controller) { controllerRef.current = null; setRunning(false); setProgress(null); } }
  };
  const comparison = outcome?.verified ? outcome.comparison : null;
  return <section className="panel" aria-labelledby="manifest-check-title"><div className="panel-head"><ShieldCheck aria-hidden="true" size={18} /><h2 id="manifest-check-title">Check files against a manifest</h2></div><div className="panel-body manifest-body">
    <label className="field-label" htmlFor="manifest-check-file">Sealed list <span>(.manifest.fseal)</span></label>
    <input id="manifest-check-file" type="file" accept=".fseal,application/octet-stream" disabled={running} onChange={(e) => changed(() => setSealed(e.target.files?.[0] || null))} />
    <label className="field-label" htmlFor="manifest-check-text">Receipt message</label>
    <textarea id="manifest-check-text" className="mono-input" rows={5} value={text} spellCheck="false" disabled={running} onChange={(e) => changed(() => setText(e.target.value))} />
    <label className="field-label" htmlFor="manifest-trusted-key">Trusted public key <span>(64 hexadecimal digits, received separately)</span></label>
    <input id="manifest-trusted-key" className="mono-input" value={key} autoComplete="off" spellCheck="false" disabled={running} onChange={(e) => changed(() => setKey(e.target.value))} />
    <TrustedKeyPinControls value={key} onUse={(value) => changed(() => setKey(value))} />
    <label className="field-label" htmlFor="manifest-local-files">Your copies of the files</label>
    <input id="manifest-local-files" type="file" multiple disabled={running} onChange={(e) => changed(() => setLocals([...(e.target.files || [])]))} />
    {progress && <FileProgressList files={locals} progress={progress} idPrefix="manifest-check" label="Files being checked" onCancel={() => controllerRef.current?.abort()} />}
    {progress && <p className="visually-hidden" role="status">Reading file {progress.index + 1} of {locals.length}</p>}
    {running && !progress && <p role="status">Checking the sealed list…</p>}
    <button className="button primary" type="button" disabled={!sealed || !text.trim() || running} onClick={run}>Check files</button>
    {message && <p className="field-hint" role="status">{message}</p>}
    {outcome && !outcome.verified && <div className="manifest-outcome" role="alert"><h3><span className="status-label bad">Manifest not verified</span></h3><p>{outcome.reason}</p><p>Check that you chose the right sealed file, pasted the whole receipt message, and entered the key the sender gave you separately.</p></div>}
    {comparison && <div className="manifest-outcome">
      <h3><span role="status" className="manifest-summary"><span className="status-label ok">Manifest verified</span> {comparison.items.filter((item) => item.status === 'match').length} of {comparison.items.length} files match</span></h3>
      <div className="table-scroll" role="region" aria-label="Manifest check results" tabIndex={0}><table className="manifest-table"><thead><tr><th scope="col">Item</th><th scope="col">Name in manifest</th><th scope="col">Size</th><th scope="col">Status</th><th scope="col">Local file</th></tr></thead><tbody>
        {comparison.items.map((item) => <tr key={item.id}><td className="mono-values">{item.id}</td><td className="wrap">{item.name || <span className="muted">Not included</span>}{item.note && <span className="manifest-note">Operator note: {item.note}</span>}</td><td className="mono-values">{fmtBytes(item.bytes)}</td><td><span className={`status-label ${STATUS_KIND[item.status]}`}>{MANIFEST_STATUS[item.status]}</span>{item.status === 'bytes-differ' && <span className="manifest-note">This can happen from editing, re-saving, compression, truncation or corruption — it isn't proof of tampering.</span>}</td><td className="wrap">{item.local == null ? '—' : outcome.locals[item.local].name}</td></tr>)}
        {comparison.extras.map((extra) => <tr key={`extra-${extra.local}`}><td>—</td><td>—</td><td className="mono-values">{fmtBytes(extra.bytes)}</td><td><span className={`status-label ${STATUS_KIND['not-in-manifest']}`}>{MANIFEST_STATUS['not-in-manifest']}</span></td><td className="wrap">{extra.name}</td></tr>)}
      </tbody></table></div>
      {comparison.items.some((item) => item.status === 'missing' && !item.name) && <p className="field-hint">Files sealed without a name can only match or be missing.</p>}
    </div>}
  </div></section>;
}

createRoot(document.getElementById('root')).render(<App />);
