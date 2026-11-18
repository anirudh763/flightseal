// Seal & send pieces shared by the small-file and large-file paths: the chosen-files list, the signing line and the
// after-sealing handoff ("Send these to your client"). The state lives in main.jsx and ManifestSeal.
import React, { useEffect, useRef, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { fingerprintHex, formatFingerprint } from './trusted-keys.mjs';

export const exactBytes = (n) => `${Number(n).toLocaleString('en-US')} bytes`; // byte counts: exact, with separators

/** The chosen files and their total, in tabular mono. `rows` is [{ name, size }]. */
export function FileTotals({ rows }) {
  if (!rows.length) return null;
  const total = rows.reduce((sum, row) => sum + row.size, 0);
  return <p className="manifest-file-row seal-total"><span>Total {rows.length} file{rows.length === 1 ? '' : 's'}</span><span className="mono-values">{exactBytes(total)}</span></p>;
}

const b64urlToHex = (s) => [...atob(s.replace(/-/g, '+').replace(/_/g, '/'))].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
async function keyFingerprint(key) {
  let hex = key.publicKeyHex;
  if (!hex) { // an imported PEM: the public half comes from the private key, in this tab only
    const der = Uint8Array.from(atob(key.privateKeyPem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
    const imported = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
    hex = b64urlToHex((await crypto.subtle.exportKey('jwk', imported)).x);
  }
  return fingerprintHex(hex);
}

/** One of the three signing lines (EXPERIENCE.md "Seal & send"). `registryLine` is the flag-on "Registering for …" line. */
export function SigningLine({ signingKey, trustHref, onTrust, registryLine }) {
  const [fingerprint, setFingerprint] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => {
    let live = true; setFingerprint(''); setCopied('');
    if (signingKey?.privateKeyPem) keyFingerprint(signingKey).then((value) => { if (live) setFingerprint(value); }).catch(() => {});
    return () => { live = false; };
  }, [signingKey]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(formatFingerprint(fingerprint)); setCopied('Fingerprint copied.'); }
    catch { setCopied('This browser blocked copying. Select the fingerprint and copy it.'); }
  };
  return <div className="signing-line" role="group" aria-labelledby="signing-line-title">
    <p id="signing-line-title" className="field-label">Signing</p>
    {!signingKey?.privateKeyPem
      ? <p>One-time key for this file. Your client can't check who sealed it. <a href={trustHref} onClick={onTrust}>Set up a company key on Trust</a>.</p>
      : <>
        <p>Signing as {signingKey.backupFilename ? `the key from ${signingKey.backupFilename}` : 'the key generated in this tab'}</p>
        {fingerprint ? <div className="signing-fingerprint"><code className="fingerprint wrap">{formatFingerprint(fingerprint)}</code><button type="button" className="button secondary" onClick={copy}><Copy aria-hidden="true" size={16} />Copy fingerprint</button></div>
          : <p className="field-hint">Reading the key's fingerprint…</p>}
        {copied && <p className="field-hint" role="status">{copied}</p>}
      </>}
    {registryLine}
  </div>;
}

/**
 * After sealing: what to download and send, in order. A Download click is not proof the file was saved (the save can
 * be cancelled or blocked), so `downloaded` turns true only through "Yes, saved" (`onSaved`), as in #37's unsaved-work
 * control; a receipt download likewise needs "Yes, receipt saved", and a copy counts once the clipboard took it.
 * Until the file is confirmed, Download, then "Yes, saved", is the one primary action. "Seal more files" asks first
 * whenever `unsaved` is true: the parent passes the same predicate its unsaved-work gate uses, never a copy of it.
 */
export function Handoff({ headingRef, headingId, summary, kind, fileName, unsaved, downloaded, receiptSaved, onDownload, onSaved, onDownloadReceipt, onReceiptSaved, originals, handoverId, handover, onCopy, copyStatus, actions, shareNote, details, onSealMore }) {
  const [asking, setAsking] = useState(false);
  const [started, setStarted] = useState(false); // Download was clicked at least once
  const [receiptStarted, setReceiptStarted] = useState(false); // Download receipt was clicked at least once
  const [showAll, setShowAll] = useState(false);
  const askRef = useRef(null);
  const moreRef = useRef(null);
  const copyRef = useRef(null);
  useEffect(() => { if (asking) askRef.current?.focus(); }, [asking, started, downloaded]);
  useEffect(() => { if (asking && !unsaved) { setAsking(false); requestAnimationFrame(() => moreRef.current?.focus()); } }, [asking, unsaved]); // kept now: nothing left to ask
  const list = kind === 'list';
  const downloadNow = () => { onDownload(); setStarted(true); };
  const downloadReceipt = () => { onDownloadReceipt(); setReceiptStarted(true); };
  const keep = () => { setAsking(false); requestAnimationFrame(() => moreRef.current?.focus()); };
  const discard = () => { setAsking(false); onSealMore(); };
  // "Yes, saved" from the question: if the receipt is kept too, go on; otherwise the question turns to the receipt.
  const savedThenMore = () => { onSaved(); if (receiptSaved) { setAsking(false); onSealMore(); } };
  const confirmNeeded = started && !downloaded;
  const shown = showAll ? originals : originals?.slice(0, 5);
  return <div className="handover handoff">
    <p className="seal-summary">{summary}</p>
    <h2 id={headingId} ref={headingRef} tabIndex="-1">Send these to your client</h2>
    <ol className="handoff-steps">
      <li>
        <div className="handoff-step-head"><span className="handoff-step-title">{list ? 'Download the list' : 'Download the sealed file'}</span><code className="wrap">{fileName}</code></div>
        <p className="field-hint">{list ? 'It holds the fingerprints, not your files.' : 'It holds your original file, byte for byte.'}</p>
        <div className="actions-row"><button type="button" className={`button ${downloaded || started ? 'secondary' : 'primary'}`} aria-label={list ? 'Download sealed list' : 'Download sealed file'} onClick={downloadNow}><Download aria-hidden="true" size={16} />Download</button></div>
        {confirmNeeded && !asking && <div className="handoff-confirm"><p role="status">Did the download finish?</p><div className="actions-row"><button type="button" className="button primary" onClick={() => { onSaved(); requestAnimationFrame(() => copyRef.current?.focus()); }}>Yes, saved</button></div></div>}
        {list && originals?.length > 0 && <div className="handoff-originals">
          <p>Send these originals separately (not inside the list):</p>
          <ul className="handoff-original-list">{shown.map((name, index) => <li key={`${index}-${name}`} className="wrap">{name}</li>)}</ul>
          {originals.length > 5 && <button type="button" className="text-action" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${originals.length}`}</button>}
        </div>}
      </li>
      <li>
        <div className="handoff-step-head"><label className="handoff-step-title" htmlFor={handoverId}>Send the receipt message</label></div>
        <textarea id={handoverId} className="mono-input" readOnly rows={list ? 8 : 9} value={handover} />
        <div className="actions-row"><button ref={copyRef} type="button" className={`button ${downloaded ? 'primary' : 'secondary'}`} onClick={onCopy}><Copy aria-hidden="true" size={16} />Copy message</button>{actions}<button type="button" className="button secondary" onClick={downloadReceipt}><Download aria-hidden="true" size={16} />Download receipt</button></div>
        {receiptStarted && !receiptSaved && !asking && <div className="handoff-confirm-receipt"><p role="status">Did the receipt download finish?</p><div className="actions-row"><button type="button" className="button secondary" onClick={onReceiptSaved}>Yes, receipt saved</button></div></div>}
        {copyStatus && <p className="field-hint" role="status">{copyStatus}</p>}
      </li>
    </ol>
    <p className="field-hint">Copying the message does not show that your client kept it.</p>
    {details}
    {shareNote}
    {asking ? <div className="confirm-box" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); keep(); } }}>
      {downloaded ? <>
        <p id="seal-more-ask">You haven't kept the receipt message. Copy it first?</p>
        <div className="actions-row"><button ref={askRef} type="button" className="button primary" aria-describedby="seal-more-ask" onClick={onCopy}><Copy aria-hidden="true" size={16} />Copy message</button><button type="button" className="button secondary" onClick={discard}>Discard it</button></div>
      </> : started ? <>
        <p id="seal-more-ask">Did the download of {fileName} finish?</p>
        <div className="actions-row"><button ref={askRef} type="button" className="button primary" aria-describedby="seal-more-ask" onClick={savedThenMore}>Yes, saved</button><button type="button" className="button secondary" onClick={downloadNow}><Download aria-hidden="true" size={16} />Download again</button><button type="button" className="button secondary" onClick={discard}>Discard it</button></div>
      </> : <>
        <p id="seal-more-ask">You haven't downloaded {fileName}. Download it first?</p>
        <div className="actions-row"><button ref={askRef} type="button" className="button primary" aria-describedby="seal-more-ask" onClick={downloadNow}><Download aria-hidden="true" size={16} />Download</button><button type="button" className="button secondary" onClick={discard}>Discard it</button></div>
      </>}
    </div> : <div className="actions-row"><button ref={moreRef} type="button" className="button secondary" onClick={() => (unsaved ? setAsking(true) : onSealMore())}>Seal more files</button></div>}
  </div>;
}
