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
  return <div className="signing-line" aria-labelledby="signing-line-title">
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
 * After sealing: what to download and send, in order. Download is the one primary action until the sealed file or list
 * has been downloaded once, then Copy message is. "Seal more files" asks first while it has not been downloaded.
 */
export function Handoff({ headingRef, headingId, summary, kind, fileName, downloaded, onDownload, originals, handoverId, handover, onCopy, copyStatus, actions, shareNote, details, onSealMore }) {
  const [asking, setAsking] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const askRef = useRef(null);
  const moreRef = useRef(null);
  useEffect(() => { if (asking) askRef.current?.focus(); }, [asking]);
  const list = kind === 'list';
  const downloadNow = () => { onDownload(); if (asking) { setAsking(false); requestAnimationFrame(() => moreRef.current?.focus()); } };
  const shown = showAll ? originals : originals?.slice(0, 5);
  return <div className="handover handoff">
    <p className="seal-summary">{summary}</p>
    <h2 id={headingId} ref={headingRef} tabIndex="-1">Send these to your client</h2>
    <ol className="handoff-steps">
      <li>
        <div className="handoff-step-head"><span className="handoff-step-title">{list ? 'Download the list' : 'Download the sealed file'}</span><code className="wrap">{fileName}</code></div>
        <p className="field-hint">{list ? 'It holds the fingerprints, not your files.' : 'It holds your original file, byte for byte.'}</p>
        <div className="actions-row"><button type="button" className={`button ${downloaded ? 'secondary' : 'primary'}`} aria-label={list ? 'Download sealed list' : 'Download sealed file'} onClick={downloadNow}><Download aria-hidden="true" size={16} />Download</button></div>
        {list && originals?.length > 0 && <div className="handoff-originals">
          <p>Send these originals separately (not inside the list):</p>
          <ul className="handoff-original-list">{shown.map((name, index) => <li key={`${index}-${name}`} className="wrap">{name}</li>)}</ul>
          {originals.length > 5 && <button type="button" className="text-action" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${originals.length}`}</button>}
        </div>}
      </li>
      <li>
        <div className="handoff-step-head"><label className="handoff-step-title" htmlFor={handoverId}>Send the receipt message</label></div>
        <textarea id={handoverId} className="mono-input" readOnly rows={list ? 8 : 9} value={handover} />
        <div className="actions-row"><button type="button" className={`button ${downloaded ? 'primary' : 'secondary'}`} onClick={onCopy}><Copy aria-hidden="true" size={16} />Copy message</button>{actions}</div>
        {copyStatus && <p className="field-hint" role="status">{copyStatus}</p>}
      </li>
    </ol>
    <p className="field-hint">Copying the message does not show that your client kept it.</p>
    {details}
    {shareNote}
    {asking ? <div className="confirm-box">
      <p id="seal-more-ask">You haven't downloaded {fileName}. Download it first?</p>
      <div className="actions-row"><button ref={askRef} type="button" className="button secondary" aria-describedby="seal-more-ask" onClick={downloadNow}><Download aria-hidden="true" size={16} />Download</button><button type="button" className="button secondary" onClick={() => { setAsking(false); onSealMore(); }}>Discard it</button></div>
    </div> : <div className="actions-row"><button ref={moreRef} type="button" className="button secondary" onClick={() => (downloaded ? onSealMore() : setAsking(true))}>Seal more files</button></div>}
  </div>;
}
