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
 * After sealing: what to download and send, in order. Each part (the sealed file or list, and its receipt) is in one
 * of three states: not requested, requested (Download was clicked) or saved. A click is not proof the file was saved
 * (the save can be cancelled or blocked, #42), so "requested" never counts as saved: `downloaded` and `receiptSaved`
 * turn true only through "I saved it" (`onSaved`, `onReceiptSaved`), or for the receipt once the clipboard took it.
 * A Download click asks nothing: it shows a short status and Copy message becomes the one primary action. The only
 * question comes, once, when "Seal more files" would discard a part that is not saved (`unsaved`, the same predicate
 * the parent's unsaved-work gate uses, never a copy of it): Download (default focus), I saved it, Keep it, Discard it.
 */
export function Handoff({ headingRef, headingId, summary, kind, fileName, receiptName, unsaved, downloaded, receiptSaved, requested, onDownload, onSaved, onDownloadReceipt, onReceiptSaved, originals, handoverId, handover, onCopy, copyStatus, actions, shareNote, details, onSealMore, ask, onKeep, notHeld }) {
  const [asking, setAsking] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const askRef = useRef(null);
  const moreRef = useRef(null);
  const fileRequested = !!requested?.file && !downloaded;
  const receiptRequested = !!requested?.receipt && !receiptSaved;
  useEffect(() => { if (asking) askRef.current?.focus(); }, [asking, fileRequested, receiptRequested, downloaded]);
  useEffect(() => { if (asking && !unsaved) setAsking(false); }, [asking, unsaved]); // kept now: nothing left to ask
  useEffect(() => { if (ask && unsaved) setAsking(true); }, [ask]); // eslint-disable-line react-hooks/exhaustive-deps -- Jobs' Resume would replace this result: the same one question first
  const wasAsking = useRef(false);
  useEffect(() => { if (wasAsking.current && !asking) moreRef.current?.focus(); wasAsking.current = asking; }, [asking]); // a closed question hands focus back to Seal more files
  const list = kind === 'list';
  const keep = () => { setAsking(false); onKeep?.(); };
  const discard = () => { setAsking(false); onSealMore(); };
  useEffect(() => { // Escape keeps the result wherever focus is while the question is open
    if (!asking) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); keep(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [asking]);
  const keepButton = <button type="button" className="button secondary" onClick={keep}>Keep it</button>;
  const discardButton = <button type="button" className="button secondary discard" onClick={discard}>Discard it</button>;
  // One question names everything still unsaved. "I saved it" is offered only when every unsaved part was downloaded
  // (or the receipt copied), never for a part nobody tried to save, and it names what it confirms.
  const started = [fileRequested && fileName, receiptRequested && receiptName].filter(Boolean);
  const canConfirm = (downloaded || fileRequested) && (receiptSaved || receiptRequested);
  const savedThenMore = () => { if (fileRequested) onSaved(); if (receiptRequested) onReceiptSaved(); setAsking(false); onSealMore(); };
  const askText = [downloaded || fileRequested ? '' : `You haven't downloaded ${fileName}. Download it first?`,
    started.length ? `You started a download of ${started.join(' and ')}. Did ${started.length > 1 ? 'they' : 'it'} save?` : '',
    receiptSaved || receiptRequested ? '' : downloaded ? "You haven't kept the receipt message." : "The receipt message isn't saved yet."].filter(Boolean).join(' ');
  const askPrimary = !downloaded && !fileRequested ? 'download' : !receiptSaved && !receiptRequested ? 'copy' : fileRequested ? 'again' : 'copy';
  const shown = showAll ? originals : originals?.slice(0, 5);
  return <div className="handover handoff">
    <p className="seal-summary">{summary}</p>
    <h2 id={headingId} ref={headingRef} tabIndex="-1">Send these to your client</h2>
    <ol className="handoff-steps">
      <li>
        <div className="handoff-step-head"><span className="handoff-step-title">{list ? 'Download the list' : 'Download the sealed file'}</span><code className="wrap">{fileName}</code></div>
        <p className="field-hint">{list ? 'It holds the fingerprints, not your files.' : 'It holds your original file, byte for byte.'}</p>
        {notHeld ? <p className="field-hint jobs-not-held">{notHeld}</p> /* a resumed job whose bytes this tab no longer holds */
          : <div className="actions-row"><button type="button" className={`button ${downloaded || fileRequested || asking ? 'secondary' : 'primary'}`} aria-label={list ? 'Download sealed list' : 'Download sealed file'} onClick={onDownload}><Download aria-hidden="true" size={16} />Download</button></div>}
        <p className="field-hint download-status" role="status">{fileRequested ? `Download started: ${fileName}. Check your Downloads folder.` : ''}</p>{/* always mounted, so the text is announced */}
        {list && originals?.length > 0 && <div className="handoff-originals">
          <p>Send these originals separately (not inside the list):</p>
          <ul className="handoff-original-list">{shown.map((name, index) => <li key={`${index}-${name}`} className="wrap">{name}</li>)}</ul>
          {originals.length > 5 && <button type="button" className="text-action" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${originals.length}`}</button>}
        </div>}
      </li>
      <li>
        <div className="handoff-step-head"><label className="handoff-step-title" htmlFor={handoverId}>Send the receipt message</label></div>
        <textarea id={handoverId} className="mono-input" readOnly rows={list ? 8 : 9} value={handover} />
        <div className="actions-row"><button type="button" className={`button ${(downloaded || fileRequested) && !asking ? 'primary' : 'secondary'}`} onClick={onCopy}><Copy aria-hidden="true" size={16} />Copy message</button>{actions}<button type="button" className="button secondary" onClick={onDownloadReceipt}><Download aria-hidden="true" size={16} />Download receipt</button></div>
        <p className="field-hint download-status" role="status">{receiptRequested ? `Download started: ${receiptName}. Check your Downloads folder.` : ''}</p>
        {copyStatus && <p className="field-hint" role="status">{copyStatus}</p>}
      </li>
    </ol>
    <p className="field-hint">Copying the message does not show that your client kept it.</p>
    {details}
    {shareNote}
    {asking ? <div className="confirm-box">
      <p id="seal-more-ask">{askText}</p>
      <div className="actions-row">{askPrimary === 'copy'
        ? <button ref={askRef} id="seal-more-ask-action" type="button" className="button primary" aria-describedby="seal-more-ask" onClick={onCopy}><Copy aria-hidden="true" size={16} />Copy message</button>
        : <button ref={askRef} id="seal-more-ask-action" type="button" className="button primary" aria-describedby="seal-more-ask" onClick={onDownload}><Download aria-hidden="true" size={16} />{fileRequested ? 'Download again' : 'Download'}</button>}
        {askPrimary === 'copy' && fileRequested && <button type="button" className="button secondary" onClick={onDownload}><Download aria-hidden="true" size={16} />Download again</button>}
        {canConfirm && <button type="button" className="button secondary" onClick={savedThenMore}>{started.length > 1 ? 'I saved both' : 'I saved it'}</button>}{keepButton}{discardButton}</div>
    </div> : <div className="actions-row"><button ref={moreRef} type="button" className="button secondary" onClick={() => (unsaved ? setAsking(true) : onSealMore())}>Seal more files</button></div>}
  </div>;
}
