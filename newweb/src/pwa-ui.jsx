import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Download, Globe2, MessageSquareWarning, Share2 } from 'lucide-react';

const safeWindowRoute = (route) => {
  const known = ['/', '/login', '/signup', '/app/sandbox', '/app/verify', '/app/records', '/app/receipts', '/app/video', '/app/help', '/privacy', '/terms', '/security'];
  return known.includes(route) ? `#${route}` : '#/';
};

export function PersistentActions({ session, profile, onLaunch, onLogout, installKind, onInstall, onFeedback, onAuthNavigation }) {
  return <nav className="global-header-actions" aria-label="Account and workspace">
    <a href="#/login" onClick={onAuthNavigation}>Log in</a>
    <a href="#/signup" onClick={onAuthNavigation}>Create account</a>
    <button type="button" className="launch-workspace" onClick={onLaunch}>Launch Workspace <ArrowRight size={15} aria-hidden="true" /></button>
    {installKind !== 'none' && <button type="button" className="install-app-action" onClick={onInstall}>{installKind === 'ios' ? 'Add to Home Screen help' : 'Install App'}</button>}
    {session?.kind === 'account' && <><span className="header-profile" title="Saved on this browser">{profile?.email || 'Local profile'} <small>Saved on this browser</small></span><button type="button" className="header-logout" disabled={!onLogout} onClick={onLogout}>Log out</button></>}
    {session?.kind === 'guest' && <span className="header-profile">Guest session</span>}
    <button type="button" className="header-feedback" onClick={onFeedback}>Report a bug</button>
  </nav>;
}

export function InstallGuide({ open, onClose, ios }) {
  const dialogRef = useRef(null);
  const dismissRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (open && !dialog.open) {
      const previous = document.activeElement;
      dialog.showModal();
      dismissRef.current?.focus();
      return () => { if (dialog.open) dialog.close(); if (previous?.isConnected) previous.focus(); };
    }
    if (!open && dialog.open) dialog.close();
    return undefined;
  }, [open]);
  return <dialog ref={dialogRef} className="pwa-dialog" aria-labelledby="install-guide-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="dialog-head"><div><span className="brand-eyebrow">Optional install</span><h2 id="install-guide-title">{ios ? 'Add HashWing to Home Screen' : 'Install HashWing'}</h2></div><button ref={dismissRef} type="button" className="dialog-close" onClick={onClose}>Close</button></div>
    {ios ? <><ol className="install-steps"><li>Open Safari’s <strong>Share</strong> menu.</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Enable <strong>Open as Web App</strong> if that option appears, then confirm.</li></ol><p>If the menu differs on your device, use Safari’s page menu and look for the Add to Home Screen action. This guide cannot open or confirm Apple’s installation sheet.</p></> : <p>Use the browser’s Install App action when it is offered. Installation is optional; the same free features remain available in the browser.</p>}
    <button type="button" className="button primary" onClick={onClose}>Done</button>
  </dialog>;
}

export function FeedbackDialog({ open, onClose, route, onDraftOpened }) {
  const dialogRef = useRef(null);
  const descriptionRef = useRef(null);
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [error, setError] = useState('');
  const [browserInfo, setBrowserInfo] = useState(false);
  const diagnostics = useMemo(() => {
    const safeRoute = safeWindowRoute(route);
    return `App version: ${typeof __APP_VERSION__ === 'undefined' ? 'development' : __APP_VERSION__}\nViewport: ${typeof window === 'undefined' ? 'unavailable' : `${window.innerWidth} × ${window.innerHeight}`}\nRoute: ${safeRoute}${browserInfo && typeof navigator !== 'undefined' ? `\nBrowser: ${navigator.userAgent}` : ''}`;
  }, [route, browserInfo]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (open && !dialog.open) {
      const previous = document.activeElement;
      dialog.showModal();
      descriptionRef.current?.focus();
      return () => { if (dialog.open) dialog.close(); if (previous?.isConnected) previous.focus(); };
    }
    if (!open && dialog.open) dialog.close();
    return undefined;
  }, [open]);
  const openDraft = () => {
    if (!description.trim()) { setError('Add a short description before opening the issue draft.'); return; }
    const body = `${description.trim()}${steps.trim() ? `\n\nReproduction steps\n${steps.trim()}` : ''}\n\n--- Safe diagnostics ---\n${diagnostics}\n\nPlease review this draft and remove any sensitive details before submitting.`;
    const target = new URL('https://github.com/anirudh763/flightseal/issues/new');
    target.searchParams.set('title', 'HashWing feedback');
    target.searchParams.set('body', body);
    window.open(target.toString(), '_blank', 'noopener,noreferrer');
    onDraftOpened?.();
    onClose();
  };
  return <dialog ref={dialogRef} className="pwa-dialog feedback-dialog" aria-labelledby="feedback-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="dialog-head"><div><span className="brand-eyebrow">Feedback draft</span><h2 id="feedback-title">Report a bug</h2></div><button type="button" className="dialog-close" onClick={onClose}>Close</button></div>
    <p>Review the text before you submit it on the FlightSeal GitHub issue form. Opening the draft does not send it. Do not include logs, source text, filenames, keys, captures, tokens or passwords.</p>
    <label htmlFor="feedback-description">Description</label><textarea ref={descriptionRef} id="feedback-description" value={description} onChange={(event) => { setDescription(event.target.value); setError(''); }} rows="3" maxLength="3000" />
    <label htmlFor="feedback-steps">Optional reproduction steps</label><textarea id="feedback-steps" value={steps} onChange={(event) => setSteps(event.target.value)} rows="3" maxLength="3000" />
    <details className="diagnostic-preview"><summary>Review diagnostic summary</summary><pre>{diagnostics}</pre><label><input type="checkbox" checked={browserInfo} onChange={(event) => setBrowserInfo(event.target.checked)} /> Include browser information</label></details>
    {error && <p role="alert" className="auth-error">{error}</p>}
    <div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button primary" onClick={openDraft}>Open GitHub issue draft</button></div>
  </dialog>;
}

export function FooterLinks({ onFeedback, onInstall, children }) {
  return <footer><div className="trust-footer"><nav aria-label="Product information">{children}<a href="#/privacy">Privacy</a><a href="#/terms">Terms of Use</a><a href="#/security">Security &amp; Offline Data</a><button type="button" onClick={onInstall}>Install help</button><button type="button" onClick={onFeedback}><MessageSquareWarning size={15} aria-hidden="true" />Report a bug</button></nav><small>HashWing verifies files locally.</small></div></footer>;
}

export function LegalPage({ page, onBack, onClearCache, cacheStatus, onFeedback, onInstall, onRestartQuickStart }) {
  const content = {
    privacy: { title: 'Privacy', blocks: [
      ['Local work', 'Logs, receipts, keys, video and results are processed in this browser. Save current run uploads the checked log, receipts, report and any selected original source to this host’s private workspace when server storage is available. Private signing keys and video are not included. Browser profiles save view settings; jobs are described below.'],
      ['Jobs on this device', 'Each seal adds a job to this browser: its job reference, package name, file count and size, the receipt message (with the public key; for one file, also its name, size and SHA-256) and when it was sealed. File contents and private signing keys are never kept. Jobs belong to the local profile that sealed them; jobs sealed without a profile belong to the guest, and anyone using this browser without a profile can see them. Jobs stay until you remove them on the Jobs page or clear this browser’s data. Removing a local profile removes its jobs too.'],
      ['Local profiles', 'A profile stores its email address and a salted PBKDF2 password verifier in this browser. When you explicitly save a view, only the workspace screen, an included-sample identifier and a record number are stored. Password hashing does not encrypt browser storage.'],
      ['Cache and external actions', 'The service worker caches the public app shell, verifier Wasm/worker files and small public sample files. Shared report URLs contain only supported sample/view/record parameters, never report text. Sharing or opening a feedback draft sends only the content shown in its review step to the destination you choose.'],
      ['Browser storage', 'Browser storage may be cleared or evicted. A local profile has no remote recovery. Removing a profile does not delete exported files or clear another app’s data.'],
    ] },
    terms: { title: 'Terms of Use', blocks: [
      ['Use', 'HashWing is provided as a local reference tool. You remain responsible for retaining original logs, receipts, public keys and exports. Check that results and file selections match your task.'],
      ['Limits', 'An intact chain does not establish sensor truth, acquisition time, trusted identity, independent custody or legal admissibility. A bundled sample key authenticates that sample fixture only. HashWing is not a substitute for a qualified forensic or legal review.'],
      ['Availability', 'The app is provided without a service-level guarantee. Browser support, storage availability, file-size limits and offline assets vary by device.'],
    ] },
    security: { title: 'Security & Offline Data', blocks: [
      ['What is stored', 'Profiles use a random per-profile salt and PBKDF2-HMAC-SHA-256 verifier. Saved views contain only a supported screen, included sample and selected record. Private keys, source files, captures, report text and payloads are not stored by the profile feature. Jobs store each seal’s job reference, package name, file count and size, receipt message and time, never file contents or private keys. The password verifier does not encrypt these other browser records.'],
      ['What is cached', 'After the first successful online preparation, the app shell, local styles/scripts, PDF chunk, C++/OpenSSL Wasm verifier, worker and the small included integrity sample with its receipts and fixture key are cached. The 28.9 MiB full PX4 sample is not part of offline preparation. Other public samples may be cached when available. User-selected files and generated reports are never cached.'],
      ['Offline limits', 'Local verification and report downloads can work offline when the prepared shell and sample are still in browser cache. First-time offline visits cannot download the app or sample. External imports, feedback drafts and network updates require a connection. Browser eviction or storage failure can remove offline readiness.'],
      ['Profiles and recovery', 'Guest state is separate from each profile. Saved views are local convenience, not encrypted storage or server authentication. Removing your active profile clears its verifier, saved view and jobs; log out clears active in-memory work but retains intentionally saved views and jobs. No remote recovery service is connected.'],
      ['Remove saved data', 'Use the active profile menu and choose “Remove local profile, saved view and jobs.” The shared FlightSeal worker can remove only FlightSeal-owned caches while leaving other apps’ caches alone. On this GitHub Pages host, browser “clear all site data” applies to the shared origin and may remove other apps’ local data too.'],
    ] },
  }[page];
  return <main className="legal-page" id="main" tabIndex="-1"><header className="legal-heading"><span className="brand-eyebrow">HashWing / FlightSeal</span><h1>{content.title}</h1><button className="button secondary" onClick={onBack}>Back to HashWing</button></header>
    <div className="legal-content">{content.blocks.map(([heading, text]) => <section key={heading}><h2>{heading}</h2><p>{text}</p></section>)}
      {page === 'security' && <section className="cache-controls"><h2>FlightSeal offline cache</h2><p>{cacheStatus || 'Check the app status before removing cached files.'}</p><button className="button secondary" type="button" onClick={onClearCache}><Download size={15} aria-hidden="true" />Remove FlightSeal cached files</button><button className="text-action" type="button" onClick={onRestartQuickStart}>Restart quick start</button></section>}
      <a href="https://github.com/anirudh763/flightseal" target="_blank" rel="noreferrer">Source and security reporting</a>
    </div><FooterLinks onFeedback={onFeedback} onInstall={onInstall} />
  </main>;
}

export function QuickStart({ completed = [], dismissed, onDismiss, onRestart, onOpenSample, onInspect, onExport, exportReady }) {
  if (dismissed) return <section className="quickstart-collapsed"><span>Quick start dismissed.</span><button type="button" className="text-action" onClick={onRestart}>Restart quick start</button></section>;
  const steps = [
    ['Open sample', 'Load the included 800-record log.', onOpenSample],
    ['Inspect integrity and coverage', 'Review the computed chain result and receipt coverage.', onInspect],
    ['Export an evidence bundle', 'Download the verified log, receipts, fixture key and report together.', onExport],
  ];
  return <section className="quickstart" aria-labelledby="quickstart-title"><div className="quickstart-head"><div><span className="brand-eyebrow">Optional</span><h2 id="quickstart-title">Quick start</h2></div><button type="button" className="text-action" onClick={onDismiss}>Dismiss</button></div><ol>{steps.map(([label, description, action], index) => <li key={label} className={completed[index] ? 'is-complete' : ''}><span className="quickstart-check" aria-hidden="true">{completed[index] ? <Check size={14} /> : index + 1}</span><div><strong>{label}</strong><small>{description}</small></div><button type="button" className="quickstart-action" onClick={action} disabled={index === 2 && !exportReady}>{index === 0 ? 'Open sample' : index === 1 ? 'Inspect' : 'Export bundle'}</button></li>)}</ol></section>;
}

export function ShareDialog({ open, onClose, summary, shareUrl, onShare, isOwnerCurrent }) {
  const dialogRef = useRef(null);
  const textRef = useRef(null);
  const [status, setStatus] = useState('');
  const revision = useRef(0);
  useEffect(() => { revision.current++; return () => { revision.current++; }; }, [open, summary, shareUrl]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (open && !dialog.open) {
      const previous = document.activeElement;
      dialog.showModal(); textRef.current?.focus();
      return () => { if (dialog.open) dialog.close(); if (previous?.isConnected) previous.focus(); };
    }
    if (!open && dialog.open) dialog.close();
    return undefined;
  }, [open]);
  const copy = async () => {
    const operation = revision.current;
    try { await navigator.clipboard.writeText(`${summary}\n\n${shareUrl}`); if (operation === revision.current && isOwnerCurrent()) setStatus('Summary and workspace link copied.'); }
    catch { if (operation !== revision.current || !isOwnerCurrent()) return; textRef.current?.select(); setStatus('Clipboard is unavailable. The text is selected for manual copying.'); }
  };
  const downloadText = () => {
    const blob = new Blob([`${summary}\n\n${shareUrl}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'hashwing-share-summary.txt'; anchor.click(); URL.revokeObjectURL(url); setStatus('Summary downloaded to this device.');
  };
  const share = async () => {
    const operation = revision.current;
    try { await onShare({ title: 'HashWing verification summary', text: summary, url: shareUrl }); if (operation === revision.current && isOwnerCurrent()) setStatus('The share sheet closed. HashWing cannot confirm what the recipient received.'); }
    catch (cause) { if (operation !== revision.current || !isOwnerCurrent()) return; if (cause?.name === 'AbortError') { setStatus('Sharing was canceled.'); return; } await copy(); }
  };
  return <dialog ref={dialogRef} className="pwa-dialog share-dialog" aria-labelledby="share-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="dialog-head"><div><span className="brand-eyebrow">Review before sharing</span><h2 id="share-title">Share verification summary</h2></div><button type="button" className="dialog-close" onClick={onClose}>Close</button></div>
    <p>This sends only the verdict, checked-record count, receipt coverage and a link to the same sample/view. It excludes filenames, full hashes, keys, report text, source files and payloads. The link cannot provide another person with a local file.</p>
    <label htmlFor="share-summary">Summary text</label><textarea ref={textRef} id="share-summary" readOnly value={summary} rows="5" />
    <label htmlFor="share-link">Workspace link</label><input id="share-link" readOnly value={shareUrl} />
    <div className="dialog-actions"><button className="button secondary" type="button" onClick={copy}>Copy text and link</button><button className="button secondary" type="button" onClick={downloadText}>Download text</button><button className="button primary" type="button" onClick={share}><Share2 size={15} aria-hidden="true" />Share…</button></div>
    {status && <p role="status" className="share-status">{status}</p>}
  </dialog>;
}
