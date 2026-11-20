// Trust: "Your company's keys". main.jsx renders this only behind `__REGISTRY_URL__`, so with the flag off none of it
// ships. No top-level side effects. Signing happens here, in the browser, with the key loaded under Your signing key;
// only the public key and the signature are sent (company-keys.mjs builds the challenge bytes itself).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Fingerprint } from 'lucide-react';
import { useRegistry } from './registry-ui.jsx';
import { authorizationError, enroll, enrolledLine, errorLine, keyRequest, listAllKeys, pastedAuthorization, pilotEnroll, pilotLabel, publicKeyHexFromPem, readKeyRequest, signerFromPem, stateKind, stateLabel } from './company-keys.mjs';
import { authorize, check as checkAuthorization, notAfterFor, toLine } from './pilot-authorization.mjs';
import { fingerprintHex, formatFingerprint } from './trusted-keys.mjs';

const DOWN = "Couldn't reach the company registry. Try again in a few minutes.";
const bytesOf = (hex) => Uint8Array.from(hex.match(/../g), (b) => Number.parseInt(b, 16));
const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function Note({ note }) {
  return note?.alert ? <div role="alert"><p className="field-hint receipt-error">{note.text}</p>
    {note.code && <details className="report-details"><summary>More options <ChevronDown size={17} aria-hidden="true" /></summary><p className="field-hint">Technical details: {note.code}</p></details>}</div>
    : <p className="field-hint" role="status">{note?.text || ''}</p>;
}
async function copyText(text, setNote, done) {
  try { await navigator.clipboard.writeText(text); setNote({ text: done }); }
  catch { setNote({ text: 'Copying was blocked. Select the text and copy it.' }); }
}

/** Option B, the pilot's device: make a key in this tab, copy its request, paste the authorization, enroll. */
function PilotDevice({ r, signingKey, loaded, unreadable, mine, online, onMakeKey, onPilotAuthorization, reload }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { setText(''); setNote(null); setError(''); setBusy(false); }, [signingKey]);
  const press = async () => {
    const snap = r.snapshot(), pem = signingKey?.privateKeyPem, pub = loaded?.pub;
    if (!snap.token || !snap.claims?.org || !pem || !pub) return;
    setError(''); setNote(null);
    const line = pastedAuthorization(text);
    if (!line) { setError(authorizationError('malformed')); return; }
    const { reason, auth } = await checkAuthorization(line.authorization, line.sig, bytesOf(pub), null, Math.floor(Date.now() / 1000));
    if (reason) { setError(authorizationError(reason)); return; }
    setBusy(true);
    const sign = await signerFromPem(pem).catch(() => async () => { throw new Error('no signer'); });
    const out = await pilotEnroll({ client: r.client, org: snap.claims.org, token: snap.token, sign, publicKeyHex: pub, authorization: line.authorization, sig: line.sig, companyFingerprint: await fingerprintHex(hexOf(auth.companyKey)) });
    if (r.snapshot().owner !== snap.owner) return;
    setBusy(false);
    if (out.ok) { onPilotAuthorization?.(signingKey, toLine(line.authorization, line.sig)); setText(''); setNote({ text: 'Your pilot key is enrolled. Seals from this tab carry its authorization.' }); reload(); }
    else setNote({ text: errorLine(out), code: out.code, alert: true });
  };
  let body;
  if (!signingKey) body = <><div className="actions-row"><button type="button" className="button primary" onClick={onMakeKey}>Make my pilot key</button></div>
    <p className="field-hint">Made in this tab and never sent. Download a backup under Your signing key if you need one.</p></>;
  else if (unreadable) body = <p className="field-hint">This key can't be used for enrollment in this browser.</p>;
  else if (!loaded) body = null;
  else if (mine) body = note ? null : <p className="field-hint">{mine.state === 'active' ? 'This pilot key is enrolled.' : "This key was enrolled before and can't be enrolled again."}</p>;
  else body = <>
    <label className="field-label" htmlFor="pilot-key-request">Key request <span>(public key and fingerprint only)</span></label>
    <textarea id="pilot-key-request" className="mono-input" rows={3} readOnly value={keyRequest(loaded.pub, loaded.fp)} spellCheck="false" />
    <div className="actions-row"><button type="button" className="button secondary" onClick={() => copyText(keyRequest(loaded.pub, loaded.fp), setNote, 'Key request copied. Send it to the company computer.')}>Copy key request</button></div>
    <label className="field-label" htmlFor="pilot-authorization">Authorization from the company computer</label>
    <textarea id="pilot-authorization" className="mono-input" rows={3} value={text} spellCheck="false" aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'pilot-authorization-error' : undefined} onChange={(e) => { setText(e.target.value); setError(''); }} />
    {error && <p id="pilot-authorization-error" className="field-hint field-error">{error}</p>}
    <div className="actions-row"><button type="button" className="button primary" disabled={!online || busy || !text.trim()} onClick={press}>Enroll my pilot key</button></div>
  </>;
  return <section className="pilot-step" aria-labelledby="pilot-device-title"><h3 id="pilot-device-title">Your pilot key</h3>{body}<Note note={note} /></section>;
}

/** Option B, the company computer: authorize a pilot key with the company key loaded here (admins only). */
function AuthorizePilot({ signingKey, loaded, isActive }) {
  const [text, setText] = useState('');
  const [request, setRequest] = useState(null); // { pub, hex, fingerprint } or { error }
  const [ticked, setTicked] = useState(false);
  const [days, setDays] = useState(14);
  const [line, setLine] = useState('');
  const [note, setNote] = useState(null);
  const seq = useRef(0);
  useEffect(() => { setText(''); setRequest(null); setTicked(false); setLine(''); setNote(null); }, [signingKey]);
  const paste = (value) => {
    const n = ++seq.current;
    setText(value); setTicked(false); setLine(''); setNote(null); setRequest(null);
    if (!value.trim()) return;
    readKeyRequest(value, loaded?.pub).then((req) => { if (n === seq.current) setRequest(req); });
  };
  const sign = async () => {
    const pem = signingKey?.privateKeyPem, n = seq.current;
    if (!pem || !isActive || !ticked || !request?.pub) return;
    setNote(null);
    try {
      const signer = await signerFromPem(pem);
      const nowSec = Date.now() / 1000;
      const out = await authorize(request.pub, bytesOf(loaded.pub), notAfterFor(days, nowSec), signer, Math.floor(nowSec));
      if (n === seq.current) setLine(out);
    } catch { if (n === seq.current) setNote({ text: "This browser couldn't sign the authorization. Nothing was made.", alert: true }); }
  };
  if (!isActive) return <section className="pilot-step" aria-labelledby="pilot-authorize-title"><h3 id="pilot-authorize-title">Authorize a pilot key</h3>
    <p className="field-hint">Load your company's active key under Your signing key to authorize pilot keys.</p></section>;
  const ready = !!request?.pub && ticked;
  return <section className="pilot-step" aria-labelledby="pilot-authorize-title"><h3 id="pilot-authorize-title">Authorize a pilot key</h3>
    <label className="field-label" htmlFor="pilot-request">Pilot's key request</label>
    <textarea id="pilot-request" className="mono-input" rows={3} value={text} spellCheck="false" aria-invalid={request?.error ? 'true' : undefined} aria-describedby={request?.error ? 'pilot-request-error' : undefined} onChange={(e) => paste(e.target.value)} />
    {request?.error && <p id="pilot-request-error" className="field-hint field-error">{request.error}</p>}
    {request?.fingerprint && <>
      <p className="field-label">Fingerprint of this key</p>
      <p><code className="wrap fingerprint">{formatFingerprint(request.fingerprint)}</code></p>
      <p className="field-hint">Read it back to the pilot. Don't authorize a key from the same message alone.</p>
      <label className="check-row" htmlFor="pilot-read-back"><input id="pilot-read-back" type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />I read this fingerprint back to the pilot</label>
      <fieldset className="source-choice"><legend>Authorization lasts</legend>
        {[14, 30].map((d) => <label key={d} className="check-row"><input type="radio" name="pilot-days" value={d} checked={days === d} onChange={() => { setDays(d); setLine(''); }} />{d} days</label>)}
      </fieldset>
    </>}
    <div className="actions-row"><button type="button" className="button primary" disabled={!ready} aria-describedby={!ready ? 'pilot-sign-hint' : undefined} onClick={sign}>Sign the authorization</button></div>
    {!ready && <p id="pilot-sign-hint" className="field-hint">Paste the pilot's request and tick the box once you read the fingerprint back.</p>}
    {line && <>
      <label className="field-label" htmlFor="pilot-authorization-line">Authorization for the pilot</label>
      <textarea id="pilot-authorization-line" className="mono-input" rows={4} readOnly value={line} spellCheck="false" />
      <div className="actions-row"><button type="button" className="button secondary" onClick={() => copyText(line, setNote, 'Authorization copied. Send it back to the pilot.')}>Copy authorization</button></div>
    </>}
    <Note note={note} />
  </section>;
}

export function CompanyKeysPanel({ signingKey, onMakeKey, onPilotAuthorization }) {
  const [r, s] = useRegistry();
  const [list, setList] = useState({ status: 'idle', keys: [] }); // idle | loading | ok | error
  const [loaded, setLoaded] = useState(null); // { pub, fp } of the key loaded under Your signing key
  const [unreadable, setUnreadable] = useState(false); // a key is loaded but this browser couldn't read its public key
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { text, code?, alert? }
  const [target, setTarget] = useState(''); // the fingerprint the compromise dialog is about
  const replaceRef = useRef(null), keepCurrentRef = useRef(null);
  const compromiseRef = useRef(null), keepItRef = useRef(null);
  const retireRef = useRef(null), keepPilotRef = useRef(null);
  const triggerRef = useRef(null), headingRef = useRef(null);
  const seq = useRef(0);
  const owner = s.claims ? s.owner : null;

  const load = useCallback(async () => {
    const n = ++seq.current, snap = r.snapshot();
    setList((l) => ({ ...l, status: 'loading' }));
    const res = await listAllKeys(r.client, { token: snap.token });
    if (n !== seq.current || r.snapshot().owner !== snap.owner) return; // a newer load or another sign-in won
    setList(res.ok ? { status: 'ok', keys: res.keys, active: res.active_key, pilot: res.pilot_keys === true, truncated: res.truncated } : { status: 'error', keys: [], res });
  }, [r]);
  useEffect(() => { // another sign-in never sees the last one's list or messages
    seq.current++;
    setList({ status: 'idle', keys: [] }); setNote(null); setBusy(false);
    if (owner) load();
  }, [owner, load]);
  useEffect(() => {
    let live = true;
    setLoaded(null); setUnreadable(false); setNote(null); // a message about the last key never sits next to this one
    const pem = signingKey?.privateKeyPem;
    if (pem) publicKeyHexFromPem(pem) // generated or imported: the same path, from the PEM itself
      .then(async (pub) => ({ pub, fp: await fingerprintHex(pub) }))
      .then((v) => { if (live) setLoaded(v); }, () => { if (live) setUnreadable(true); });
    return () => { live = false; };
  }, [signingKey]);

  const openDialog = (ref, safeRef, event) => { triggerRef.current = event?.currentTarget || null; ref.current?.showModal(); safeRef.current?.focus(); };
  const closeDialog = (ref) => ref.current?.close();
  // Focus goes back to the button that opened a dialog, or to the heading when that button is gone (or there was none).
  const restoreFocus = () => { const t = triggerRef.current; (t?.isConnected ? t : headingRef.current)?.focus(); };
  useEffect(() => { // a reload after an action can remove the button that had the focus
    const t = triggerRef.current;
    if (t && !t.isConnected && (!document.activeElement || document.activeElement === document.body)) { triggerRef.current = null; headingRef.current?.focus(); }
  }, [list]);
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
  const retire = async () => {
    const snap = r.snapshot(), fp = target;
    closeDialog(retireRef);
    if (!snap.token || !fp) return;
    setBusy(true); setNote(null);
    const res = await r.client.retirePilotKey(fp, { token: snap.token });
    if (r.snapshot().owner !== snap.owner) return;
    setBusy(false);
    if (res.ok) { setNote({ text: 'Pilot key removed.' }); load(); }
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
  // Option B is shown only when the registry says so; kept through a reload so the pilot steps keep their state.
  const pilotOn = list.pilot === true && list.status !== 'error' && list.status !== 'idle';
  const isActive = !!loaded && !!list.active && loaded.fp === list.active;
  let actions = null;
  if (admin && list.status === 'ok' && !(pilotOn && mine?.kind === 'pilot')) {
    if (mine?.state === 'active') actions = <p className="field-hint">The key loaded here is your company's active key.</p>;
    else if (mine) actions = <p>This key was enrolled before and can't be enrolled again.</p>;
    else actions = <>
      <div className="actions-row"><button type="button" className="button primary" disabled={!loaded || !online || busy} aria-describedby={!signingKey ? 'company-keys-load-hint' : undefined}
        onClick={(e) => (replacing ? openDialog(replaceRef, keepCurrentRef, e) : press(false))}>{replacing ? 'Replace with this key' : 'Enroll this key'}</button></div>
      {signingKey && unreadable && <p className="field-hint">This key can't be used for enrollment in this browser.</p>}
      {!signingKey && <p id="company-keys-load-hint" className="field-hint">Load your company's signing key under Your signing key first.</p>}
    </>;
  }

  return <section className="panel trust-wide" id="company-keys" aria-labelledby="company-keys-title"><div className="panel-head"><Fingerprint aria-hidden="true" size={18} /><h2 id="company-keys-title" ref={headingRef} tabIndex={-1}>Your company's keys</h2></div><div className="panel-body">
    {!owner ? <p>Sign in under Company registry to see your company's keys.</p> : <>
      {!online && <p className="registry-notice">You're offline. Key changes need a connection.</p>}
      {list.status === 'error' && <div className="registry-notice" role="alert"><p>{down ? DOWN : errorLine(list.res)}</p><button type="button" className="button secondary" onClick={load}>Try again</button></div>}
      {(list.status === 'loading' || list.status === 'idle') && !keys.length && <p role="status">Loading your company's keys…</p>}
      {list.status === 'ok' && !keys.length && <p>No company key enrolled yet.</p>}
      {keys.length > 0 && <ul className="company-list company-keys">{keys.map((k) => {
        const id = `company-key-${k.key_fingerprint.slice(0, 16)}`, enrolled = enrolledLine(k);
        return <li key={k.key_fingerprint}>
          <code id={id} className="wrap fingerprint">{formatFingerprint(k.key_fingerprint)}</code>
          <p className="company-key-state"><span className={`status-label ${stateKind(k)}`}>{stateLabel(k)}</span>{enrolled && <span className="field-hint"> {enrolled}</span>}</p>
          {k.kind === 'pilot' && <p className="field-hint">{pilotLabel(k)}</p>}
          <div className="actions-row"><button type="button" className="button secondary" aria-describedby={id} onClick={() => copy(k.key_fingerprint)}>Copy</button>
            {admin && k.state !== 'compromised' && <button type="button" className="button secondary" aria-describedby={id} disabled={!online || busy} onClick={(e) => { setTarget(k.key_fingerprint); setNote(null); openDialog(compromiseRef, keepItRef, e); }}>Mark compromised</button>}
            {admin && k.kind === 'pilot' && k.state === 'active' && <button type="button" className="button secondary" aria-describedby={id} disabled={!online || busy} onClick={(e) => { setTarget(k.key_fingerprint); setNote(null); openDialog(retireRef, keepPilotRef, e); }}>Remove</button>}</div>
        </li>;
      })}</ul>}
      {list.truncated && <p className="field-hint">Showing the first 1,000 keys.</p>}
      {list.status === 'ok' && <p className="field-hint">Only the company computer holds this key. Pilots on other devices seal with a one-time key, which reads 'signer not confirmed'.</p>}
      {actions}
      <Note note={note} />
      {pilotOn && !isActive && <PilotDevice r={r} signingKey={signingKey} loaded={loaded} unreadable={unreadable} mine={mine} online={online} onMakeKey={onMakeKey} onPilotAuthorization={onPilotAuthorization} reload={load} />}
      {pilotOn && admin && <AuthorizePilot signingKey={signingKey} loaded={loaded} isActive={isActive} />}
    </>}
    <dialog ref={replaceRef} className="registry-dialog" aria-labelledby="company-keys-replace-title" onClose={restoreFocus}>
      <h2 id="company-keys-replace-title">Replace your company's key?</h2>
      <p>The key loaded here becomes your company's key. New receipts signed with the current key will be refused.</p>
      <div className="actions-row"><button type="button" className="button secondary" disabled={busy} onClick={() => { closeDialog(replaceRef); press(true); }}>Replace key</button><button ref={keepCurrentRef} type="button" className="button secondary" onClick={() => closeDialog(replaceRef)}>Keep the current key</button></div>
    </dialog>
    <dialog ref={compromiseRef} className="registry-dialog" aria-labelledby="company-keys-compromise-title" onClose={restoreFocus}>
      <h2 id="company-keys-compromise-title">Mark this key compromised?</h2>
      <p>New receipts signed with it will be refused. Older proofs from it show a warning once the people who check them mark it compromised too.</p>
      {target && <p><code className="wrap fingerprint">{formatFingerprint(target)}</code></p>}
      <div className="actions-row"><button type="button" className="button registry-bad" disabled={busy} onClick={compromise}>Mark compromised</button><button ref={keepItRef} type="button" className="button secondary" onClick={() => closeDialog(compromiseRef)}>Keep it</button></div>
    </dialog>
    <dialog ref={retireRef} className="registry-dialog" aria-labelledby="company-keys-retire-title" onClose={restoreFocus}>
      <h2 id="company-keys-retire-title">Remove this pilot key?</h2>
      <p>New receipts signed with it will be refused. Proofs it signed before can still read Verified until its authorization ends.</p>
      {target && <p><code className="wrap fingerprint">{formatFingerprint(target)}</code></p>}
      <div className="actions-row"><button type="button" className="button registry-bad" disabled={busy} onClick={retire}>Remove</button><button ref={keepPilotRef} type="button" className="button secondary" onClick={() => closeDialog(retireRef)}>Keep it</button></div>
    </dialog>
  </div></section>;
}
