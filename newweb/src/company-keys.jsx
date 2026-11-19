// Trust: "Your company's keys". main.jsx renders this only behind `__REGISTRY_URL__`, so with the flag off none of it
// ships. No top-level side effects. Signing happens here, in the browser, with the key loaded under Your signing key;
// only the public key and the signature are sent (company-keys.mjs builds the challenge bytes itself).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Fingerprint } from 'lucide-react';
import { useRegistry } from './registry-ui.jsx';
import { enroll, enrolledLine, errorLine, listAllKeys, publicKeyHexFromPem, signerFromPem, stateKind, stateLabel } from './company-keys.mjs';
import { fingerprintHex, formatFingerprint } from './trusted-keys.mjs';

const DOWN = "Couldn't reach the company registry. Try again in a few minutes.";

export function CompanyKeysPanel({ signingKey }) {
  const [r, s] = useRegistry();
  const [list, setList] = useState({ status: 'idle', keys: [] }); // idle | loading | ok | error
  const [loaded, setLoaded] = useState(null); // { pub, fp } of the key loaded under Your signing key
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { text, code?, alert? }
  const [target, setTarget] = useState(''); // the fingerprint the compromise dialog is about
  const replaceRef = useRef(null), keepCurrentRef = useRef(null);
  const compromiseRef = useRef(null), keepItRef = useRef(null);
  const triggerRef = useRef(null);
  const seq = useRef(0);
  const owner = s.claims ? s.owner : null;

  const load = useCallback(async () => {
    const n = ++seq.current, snap = r.snapshot();
    setList((l) => ({ ...l, status: 'loading' }));
    const res = await listAllKeys(r.client, { token: snap.token });
    if (n !== seq.current || r.snapshot().owner !== snap.owner) return; // a newer load or another sign-in won
    setList(res.ok ? { status: 'ok', keys: res.keys, active: res.active_key, truncated: res.truncated } : { status: 'error', keys: [], res });
  }, [r]);
  useEffect(() => { // another sign-in never sees the last one's list or messages
    seq.current++;
    setList({ status: 'idle', keys: [] }); setNote(null); setBusy(false);
    if (owner) load();
  }, [owner, load]);
  useEffect(() => {
    let live = true;
    setLoaded(null);
    const pem = signingKey?.privateKeyPem;
    if (pem) publicKeyHexFromPem(pem) // generated or imported: the same path, from the PEM itself
      .then(async (pub) => ({ pub, fp: await fingerprintHex(pub) }))
      .then((v) => { if (live) setLoaded(v); }, () => {});
    return () => { live = false; };
  }, [signingKey]);

  const openDialog = (ref, safeRef, event) => { triggerRef.current = event?.currentTarget || null; ref.current?.showModal(); safeRef.current?.focus(); };
  const closeDialog = (ref) => ref.current?.close();
  const fail = (res) => {
    setNote({ text: errorLine(res), code: res.code, alert: true });
    if (res.code === 'conflict' || res.status === 404) load();
  };
  const press = async (confirmReplace) => {
    const snap = r.snapshot(), pem = signingKey?.privateKeyPem, pub = loaded?.pub;
    if (!snap.token || !snap.claims?.org || !pem || !pub) return;
    setBusy(true); setNote(null);
    const sign = await signerFromPem(pem).catch(() => async () => { throw new Error('no signer'); });
    const out = await enroll({ client: r.client, org: snap.claims.org, token: snap.token, sign, publicKeyHex: pub, confirmReplace });
    if (r.snapshot().owner !== snap.owner) return;
    setBusy(false);
    if (out.ok) { setNote({ text: "This key is now your company's active key." }); load(); }
    else if (out.reason === 'confirm_required') openDialog(replaceRef, keepCurrentRef, null);
    else fail(out);
  };
  const compromise = async () => {
    const snap = r.snapshot(), fp = target;
    closeDialog(compromiseRef);
    if (!snap.token || !fp) return;
    setBusy(true); setNote(null);
    const res = await r.client.compromiseKey(fp, { token: snap.token });
    if (r.snapshot().owner !== snap.owner) return;
    setBusy(false);
    if (res.ok) { setNote({ text: 'Marked compromised.' }); load(); }
    else fail(res);
  };
  const copy = async (fp) => {
    try { await navigator.clipboard.writeText(formatFingerprint(fp)); setNote({ text: 'Fingerprint copied.' }); }
    catch { setNote({ text: 'Copying was blocked. Select the fingerprint and copy it.' }); }
  };

  const admin = s.claims?.role === 'admin';
  const online = s.online;
  const keys = list.keys;
  const mine = loaded ? keys.find((k) => k.key_fingerprint === loaded.fp) : null;
  const replacing = !!list.active || keys.some((k) => k.state === 'active');
  const down = list.res && (list.res.kind === 'network' || list.res.kind === 'timeout' || list.res.status >= 500);
  let actions = null;
  if (admin && list.status === 'ok') {
    if (mine?.state === 'active') actions = <p className="field-hint">The key loaded here is your company's active key.</p>;
    else if (mine) actions = <p>This key was enrolled before and can't be enrolled again.</p>;
    else actions = <>
      <div className="actions-row"><button type="button" className="button primary" disabled={!loaded || !online || busy} aria-describedby={!signingKey ? 'company-keys-load-hint' : undefined}
        onClick={(e) => (replacing ? openDialog(replaceRef, keepCurrentRef, e) : press(false))}>{replacing ? 'Replace with this key' : 'Enroll this key'}</button></div>
      {!signingKey && <p id="company-keys-load-hint" className="field-hint">Load your company's signing key under Your signing key first.</p>}
    </>;
  }

  return <section className="panel trust-wide" id="company-keys" aria-labelledby="company-keys-title"><div className="panel-head"><Fingerprint aria-hidden="true" size={18} /><h2 id="company-keys-title">Your company's keys</h2></div><div className="panel-body">
    {!owner ? <p>Sign in under Company registry to see your company's keys.</p> : <>
      {admin && !online && <p className="registry-notice">You're offline. Key changes need a connection.</p>}
      {list.status === 'error' && <div className="registry-notice" role="alert"><p>{down ? DOWN : errorLine(list.res)}</p><button type="button" className="button secondary" onClick={load}>Try again</button></div>}
      {(list.status === 'loading' || list.status === 'idle') && !keys.length && <p role="status">Loading your company's keys…</p>}
      {list.status === 'ok' && !keys.length && <p>No company key enrolled yet.</p>}
      {keys.length > 0 && <ul className="company-list company-keys">{keys.map((k) => {
        const id = `company-key-${k.key_fingerprint.slice(0, 16)}`, enrolled = enrolledLine(k);
        return <li key={k.key_fingerprint}>
          <code id={id} className="wrap fingerprint">{formatFingerprint(k.key_fingerprint)}</code>
          <p className="company-key-state"><span className={`status-label ${stateKind(k)}`}>{stateLabel(k)}</span>{enrolled && <span className="field-hint"> {enrolled}</span>}</p>
          <div className="actions-row"><button type="button" className="button secondary" aria-describedby={id} onClick={() => copy(k.key_fingerprint)}>Copy</button>
            {admin && k.state !== 'compromised' && <button type="button" className="button secondary" aria-describedby={id} disabled={!online || busy} onClick={(e) => { setTarget(k.key_fingerprint); setNote(null); openDialog(compromiseRef, keepItRef, e); }}>Mark compromised</button>}</div>
        </li>;
      })}</ul>}
      {list.truncated && <p className="field-hint">Showing the first 1,000 keys.</p>}
      {list.status === 'ok' && <p className="field-hint">Only the company computer holds this key. Pilots on other devices seal with a one-time key, which reads 'signer not confirmed'.</p>}
      {actions}
      {note?.alert ? <div role="alert"><p className="field-hint receipt-error">{note.text}</p>
        {note.code && <details className="report-details"><summary>More options <ChevronDown size={17} aria-hidden="true" /></summary><p className="field-hint">Technical details: {note.code}</p></details>}</div>
        : <p className="field-hint" role="status">{note?.text || ''}</p>}
    </>}
    <dialog ref={replaceRef} className="registry-dialog" aria-labelledby="company-keys-replace-title" onClose={() => triggerRef.current?.focus()}>
      <h2 id="company-keys-replace-title">Replace your company's key?</h2>
      <p>The key loaded here becomes your company's key. New receipts signed with the current key will be refused.</p>
      <div className="actions-row"><button type="button" className="button secondary" disabled={busy} onClick={() => { closeDialog(replaceRef); press(true); }}>Replace key</button><button ref={keepCurrentRef} type="button" className="button secondary" onClick={() => closeDialog(replaceRef)}>Keep the current key</button></div>
    </dialog>
    <dialog ref={compromiseRef} className="registry-dialog" aria-labelledby="company-keys-compromise-title" onClose={() => triggerRef.current?.focus()}>
      <h2 id="company-keys-compromise-title">Mark this key compromised?</h2>
      <p>New receipts signed with it will be refused. Older proofs from it will show a warning.</p>
      {target && <p><code className="wrap fingerprint">{formatFingerprint(target)}</code></p>}
      <div className="actions-row"><button type="button" className="button registry-bad" disabled={busy} onClick={compromise}>Mark compromised</button><button ref={keepItRef} type="button" className="button secondary" onClick={() => closeDialog(compromiseRef)}>Keep it</button></div>
    </dialog>
  </div></section>;
}
