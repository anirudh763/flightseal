// Receipt registry UI. main.jsx renders and calls everything here only behind `__REGISTRY_URL__`, so with the flag off
// none of it ships. No top-level side effects: the session store is made by the first flag-guarded caller.
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, Cloud, HardDrive, Link2 } from 'lucide-react';
import { createRegistryClient, tokenOwner } from './registry-client.mjs';
import { attentionMessage, openOutbox, stateLabel } from './outbox.mjs';
import { openPendingStore } from './pending-store.mjs';
import { fingerprintHex, formatFingerprint } from './trusted-keys.mjs';

const TOKEN_KEY = 'hashwing-registry-token';
const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FULL = 'This device is holding 200 proofs waiting to send. Sign in or reconnect so they can send, or export them, before sealing more.';
const SIGN_IN = 'Sign in to the company registry to send these.';
const MEMORY = "This browser can't keep these proofs after you close the tab. Export them now.";
const NOTHING = "There's nothing waiting to export here. If this browser lost its saved data, only an export file you saved earlier can bring those proofs back.";
const LIST_ERROR = "Couldn't open this device's saved list. Your sealed files aren't affected. Try reloading.";
// The UX spec's "Registry errors" table: the message and the single action for each needs_attention reason.
const UNREADABLE = "The registry couldn't accept this receipt. Export it and contact your admin.";
const REASONS = {
  key_not_enrolled: ["This signing key isn't enrolled for your company yet. Ask your company's registry admin to enroll this key's fingerprint, then try again.", 'retry'],
  key_not_active: ["This signing key was replaced or marked compromised, so the registry won't accept new receipts from it. Seal again with your company's current key.", 'trust'],
  envelope_expired: ['This saved request was waiting too long and has expired. Try again to send it with a fresh request; the proof itself is unchanged.', 'retry'],
  epoch_mismatch: ['Your company reset its registry requests since this was saved. Try again to send it with a fresh request.', 'retry'],
  sub_mismatch: ['This request was prepared under a different sign-in. Try again to send it under your current sign-in.', 'retry'],
  quota_exceeded: [null, 'export'], // the text is attentionMessage(); "Try again" sits under More options
  conflict: ['The registry already holds a different request with this ID. Export this proof and contact your admin.', 'export'],
  registration_deleted: ["This receipt's hosted record was deleted, so it can't be registered again.", 'none'],
  bad_signature: [UNREADABLE, 'export'], bad_request: [UNREADABLE, 'export'], body_too_large: [UNREADABLE, 'export'],
  attempts_exhausted: ["This couldn't be sent after several tries. It is still saved here.", 'retry'],
};
const REFUSED = [UNREADABLE, 'export'];
const hex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
// A share record is shown only when every field has its exact shape; anything else gets the "unavailable" message.
const shareRecord = (d) => (d && hex64(d.head) && Number.isSafeInteger(d.count) && d.count >= 0 && hex64(d.key_fingerprint)
  && typeof d.received_at === 'string' && !Number.isNaN(Date.parse(d.received_at)) ? { head: d.head, count: d.count, key_fingerprint: d.key_fingerprint, received_at: d.received_at } : null);
const UNAVAILABLE = 'The registry is temporarily unavailable. Try the link again in a few minutes.';
const LINK_DEAD = "This link doesn't open. It may have been withdrawn or expired, or it was copied incompletely. Ask the sender for a new link.";

// Claims read WITHOUT verification, for display only (the registry verifies). null when unreadable.
function claimsOf(jwt) {
  const part = typeof jwt === 'string' ? jwt.split('.') : [];
  if (part.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(part[1])) return null;
  try {
    const b64 = part[1].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part[1].length % 4)) % 4);
    const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
    if (!c || typeof c !== 'object') return null;
    const org = c['custom:org_id'] ?? c.org_id, role = c['custom:role'] ?? c.role;
    return { org: typeof org === 'string' ? org : '', sub: typeof c.sub === 'string' ? c.sub : '', role: typeof role === 'string' ? role : '', exp: c.exp };
  } catch { return null; }
}
const isLoopback = (url) => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch { return false; } }; // as vite.config.js
const storage = { get() { try { return { token: sessionStorage.getItem(TOKEN_KEY) || '', at: Number(sessionStorage.getItem(`${TOKEN_KEY}-at`)) || 0 }; } catch { return { token: '', at: 0 }; } },
  set(v, at = Date.now()) { try { if (v) { sessionStorage.setItem(TOKEN_KEY, v); sessionStorage.setItem(`${TOKEN_KEY}-at`, String(at)); } else { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(`${TOKEN_KEY}-at`); } } catch { /* tab memory only */ } } };
// When each owner last signed out (keyed by a hash of the owner, never a token), so a tab that missed the message
// (frozen, discarded, restored, or without BroadcastChannel) does not sign back in with an older saved token.
const SIGNOUTS = 'hashwing-registry-signouts';
const ownerKey = async (owner) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner)))].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
const readSignouts = () => { try { const v = JSON.parse(localStorage.getItem(SIGNOUTS) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
async function markSignedOut(owner, at) {
  try {
    const key = await ownerKey(owner);
    const all = { ...readSignouts(), [key]: at };
    const keep = Object.entries(all).sort((x, y) => y[1] - x[1]).slice(0, 50); // bounded
    localStorage.setItem(SIGNOUTS, JSON.stringify(Object.fromEntries(keep)));
  } catch { /* no shared storage: BroadcastChannel still reaches the open tabs */ }
}
async function signedOutSince(owner, since) {
  try { return Number(readSignouts()[await ownerKey(owner)]) > since; } catch { return false; }
}
function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function closeDisclosure(event) {
  if (event.key !== 'Escape' || !event.currentTarget.open || event.target.closest?.('dialog')) return; // a dialog handles its own Escape
  event.preventDefault(); event.stopPropagation();
  event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus();
}

// ------------------------------------------------------------------ session store

let registry = null;
export function getRegistry() { return (registry ??= createRegistry()); }

function createRegistry() {
  const listeners = new Set();
  const names = new Map(); // receipt -> display name; memory only, never persisted
  let token = ''; // the only copy outside sessionStorage
  let signedInAt = 0; // when this tab's current sign-in began; older sign-out messages and markers do not apply to it
  let gen = 0, seq = 0, unsubscribe = null;
  let scopeGen = 0, store = null; // the pending store of the current local scope (profile or guest)
  let lastOwner = null; // the owner the display names belong to
  let state = { token: '', claims: null, owner: null, outbox: null, rows: [], listed: false, scope: null, pending: [], pendingStorage: null,
    needsSignIn: false, online: navigator.onLine !== false, memory: false, listError: '', enqueueError: '' };
  const set = (patch) => { state = { ...state, ...patch }; for (const fn of listeners) fn(); };
  const client = createRegistryClient({ baseUrl: __REGISTRY_URL__, getToken: async () => token });
  addEventListener('online', () => set({ online: true }));
  addEventListener('offline', () => set({ online: false }));
  // Other tabs of this browser (a duplicated tab copies sessionStorage, token included) drop their registry sign-in
  // with this one. The message names the owner and when, never a token. An app logout is not sent here: the app's own
  // logout message names the local profile, and only that profile's tabs call registryLogout().
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('hashwing-registry') : null;
  channel?.addEventListener('message', ({ data }) => {
    if (data?.type === 'signout' && typeof data.owner === 'string' && data.owner === state.owner && !(Number(data.at) < signedInAt)) signOutHere();
  });
  // A tab that was frozen, discarded or has no BroadcastChannel checks the shared sign-out marker when it wakes.
  const wake = () => { if (state.owner) signedOutSince(state.owner, signedInAt).then((yes) => { if (yes && state.owner) signOutHere(); }); };
  addEventListener('pageshow', wake); addEventListener('focus', wake);
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  globalThis.document?.addEventListener?.('resume', wake);
  const mayName = (p, owner) => !p.owner || p.owner === owner; // a held proof's file name is never shown to another owner
  const unsaved = (p) => !p.exported && (state.pendingStorage !== 'indexeddb' || p.memoryOnly);

  async function refresh(ob) {
    const n = ++seq;
    try {
      const rows = await ob.list();
      if (n !== seq || state.outbox !== ob) return; // a newer refresh, a close or an owner change won
      const st = ob.status();
      set({ rows, listed: true, needsSignIn: st.needsSignIn, memory: st.storage === 'memory' || st.exportOffered, listError: '' });
      // A pending proof this outbox already holds (an assign or flush cut short by a reload) is not pending any more.
      const queued = new Set(rows.map((row) => row.receipt));
      for (const p of state.pending.filter((q) => queued.has(q.receipt))) await dropPending(p.receipt);
      // A proof kept because this owner's queue was full is retried whenever the queue changes.
      if (state.outbox === ob && state.pending.some((p) => p.owner === state.owner)) flushOwned(ob, state.owner);
    } catch { if (state.outbox === ob) set({ listError: LIST_ERROR }); }
  }
  async function enqueueOn(ob, receipt) {
    try { await ob.enqueue({ receipt }); set({ enqueueError: '' }); return true; }
    catch (err) { if (state.outbox === ob) set({ enqueueError: err instanceof RangeError ? FULL : "Couldn't save this proof on this device. Export pending proofs, then try again." }); return false; }
  }
  async function importProofs(text) {
    if (!state.outbox) return { ok: false, reason: 'signed_out' };
    try { return await state.outbox.importProofs(text); }
    catch (err) { return { ok: false, reason: err instanceof RangeError ? 'full' : 'failed' }; }
  }
  // ---- pending proofs: saved per local scope, removed only once the owner's outbox holds them
  async function keepPending(row) {
    if (state.pending.some((p) => p.receipt === row.receipt)) return;
    set({ pending: [...state.pending, row] });
    if (!store) return; // the scope is still opening: setScope saves it
    const g = scopeGen;
    try { await store.put({ receipt: row.receipt, owner: row.owner, at: row.at }); }
    catch (err) {
      if (g !== scopeGen) return;
      set({ pending: state.pending.map((p) => (p.receipt === row.receipt ? { ...p, memoryOnly: true } : p)),
        enqueueError: err instanceof RangeError ? FULL : "Couldn't save this proof on this device. Export pending proofs, then try again." });
    }
  }
  async function dropPending(receipt) {
    set({ pending: state.pending.filter((p) => p.receipt !== receipt) });
    try { await store?.remove(receipt); } catch { /* still in the outbox, which is what counts; a later flush finds it already queued */ }
  }
  let flushing = null;
  async function flushOwned(ob, owner) { // only proofs sealed under this same owner go to its outbox by themselves
    if (flushing === ob) return; // one flush per outbox at a time; the next queue change retries
    flushing = ob;
    try {
      for (const p of state.pending.filter((q) => q.owner === owner)) {
        if (state.outbox !== ob) return;
        if (!(await enqueueOn(ob, p.receipt))) return; // kept; the list shows why
        if (state.outbox === ob) await dropPending(p.receipt);
      }
    } finally { if (flushing === ob) flushing = null; }
  }
  async function setScope(scope) {
    if ((scope || null) === state.scope) return;
    const g = ++scopeGen;
    store?.close(); store = null;
    names.clear();
    set({ scope: scope || null, pending: [], pendingStorage: null });
    if (!scope) return;
    const st = await openPendingStore(scope);
    if (g !== scopeGen) { st.close(); return; }
    let saved = [];
    try { saved = await st.list(); } catch { saved = []; }
    if (g !== scopeGen) { st.close(); return; }
    store = st;
    const early = state.pending.filter((p) => !saved.some((q) => q.receipt === p.receipt)); // sealed while the store opened
    set({ pending: [...saved, ...early], pendingStorage: st.storage });
    for (const p of early) { try { await st.put({ receipt: p.receipt, owner: p.owner, at: p.at }); } catch { if (g === scopeGen) set({ pending: state.pending.map((q) => (q.receipt === p.receipt ? { ...q, memoryOnly: true } : q)) }); } }
    if (state.outbox && g === scopeGen) await flushOwned(state.outbox, state.owner);
  }
  function closeOutbox() {
    gen += 1; seq += 1;
    unsubscribe?.(); unsubscribe = null;
    state.outbox?.close();
    set({ outbox: null, rows: [], listed: false, needsSignIn: false, memory: false, listError: '', enqueueError: '' });
  }
  async function signIn(raw, at = Date.now()) {
    const tok = String(raw || '').trim();
    const owner = tokenOwner(tok), claims = claimsOf(tok);
    if (!owner || !claims) return false;
    if (owner === state.owner && state.outbox) { // a fresh token for the same owner: keep the outbox, send now
      token = tok; storage.set(tok, at); signedInAt = at; set({ token: tok, claims });
      state.outbox.retryNow();
      return true;
    }
    closeOutbox();
    if (lastOwner && lastOwner !== owner) { // another owner: forget the last one's file names, except unsent seals it may see
      for (const receipt of names.keys()) if (!state.pending.some((p) => p.receipt === receipt && mayName(p, owner))) names.delete(receipt);
    }
    lastOwner = owner;
    token = tok; storage.set(tok, at); signedInAt = at;
    set({ token: tok, claims, owner });
    const g = gen;
    let ob;
    try { ob = await openOutbox({ ownerId: owner, client, getToken: async () => token }); }
    catch { if (g === gen) set({ listError: LIST_ERROR }); return true; }
    if (g !== gen) { ob.close(); return true; } // the owner changed while it opened: never use it
    unsubscribe = ob.subscribe(() => refresh(ob));
    set({ outbox: ob });
    await flushOwned(ob, owner);
    if (state.outbox === ob) await refresh(ob);
    return true;
  }
  function signOutHere() {
    closeOutbox();
    token = ''; storage.set('');
    set({ token: '', claims: null, owner: null });
  }
  // App logout: credentials go and dispatch stops; saved pending proofs stay in that profile's store (AD-17).
  function logoutHere() { signOutHere(); names.clear(); }
  function markExported(receipts) { // exported proofs stay listed and saved; they no longer count as unsaved work
    const done = new Set(receipts);
    if (state.pending.some((p) => !p.exported && done.has(p.receipt))) set({ pending: state.pending.map((p) => (done.has(p.receipt) ? { ...p, exported: true } : p)) });
  }

  const saved = storage.get();
  if (saved.token) { // a reload, a restored or a duplicated tab: unless that owner signed out since this sign-in began
    const owner = tokenOwner(saved.token);
    (owner ? signedOutSince(owner, saved.at) : Promise.resolve(true))
      .then((gone) => (gone ? false : signIn(saved.token, saved.at))).then((ok) => { if (!ok) storage.set(''); });
  }

  return {
    client, names,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot: () => state,
    signIn, importProofs, setScope,
    signOut() {
      const owner = state.owner, at = Date.now();
      signOutHere();
      if (owner) { channel?.postMessage({ type: 'signout', owner, at }); markSignedOut(owner, at); }
    },
    logout: logoutHere, // this tab only (AD-17); the app's profile logout message reaches that profile's other tabs
    sealStart: () => ({ owner: state.owner, g: scopeGen }),
    async sealed(receipt, name, start = { owner: state.owner, g: scopeGen }) {
      // The registry owner signed in when sealing began (null: unassigned), so a sign-in during a long seal never adopts it.
      const { owner, g } = start;
      if (g !== scopeGen) return; // the local profile changed meanwhile: the app keeps the sealed files for that user
      if (name && (!owner || owner === state.owner)) names.set(receipt, name);
      if (owner && owner === state.owner && state.outbox && await enqueueOn(state.outbox, receipt)) return; // a failed enqueue (queue full) keeps it below
      if (g !== scopeGen) return; // the local profile changed meanwhile: the app keeps the sealed files for that user
      await keepPending({ receipt, owner, at: Date.now() });
    },
    /** Send an unassigned proof under the current sign-in, on the user's explicit request. The registry still checks
     * that its key is enrolled for this company and that the user is a member. */
    async assign(receipt) {
      const ob = state.outbox, owner = state.owner;
      const row = state.pending.find((p) => p.receipt === receipt && !p.owner);
      if (!ob || !row) return false;
      // Bind it to this owner first, so a reload between saving and sending can never offer it to another company.
      const bound = { receipt, owner, at: row.at };
      set({ pending: state.pending.map((p) => (p.receipt === receipt ? { ...p, owner } : p)) });
      try { await store?.put(bound); } catch { /* the in-memory row is bound; the outbox below is what counts */ }
      if (!(await enqueueOn(ob, receipt))) return false; // kept under this owner; retried when the queue changes
      if (state.outbox === ob) await dropPending(receipt);
      return true;
    },
    async exportPending() {
      const queued = state.outbox ? await state.outbox.exportPending() : { ok: false };
      const receipts = [...new Set([...(queued.ok ? JSON.parse(queued.text).receipts : []), ...state.pending.map((p) => p.receipt)])];
      if (!receipts.length) return { ok: false, reason: 'needs_previous_export' };
      markExported(receipts);
      return { ok: true, count: receipts.length, text: exportText(receipts) };
    },
    /** Unsent proofs that only this tab's memory holds (no IndexedDB, or a failed save), as an export file. */
    unsentExport() {
      const receipts = state.pending.filter(unsaved).map((p) => p.receipt);
      return receipts.length ? { count: receipts.length, text: exportText(receipts), markSaved: () => markExported(receipts) } : null;
    },
    unsavedCount: () => state.pending.filter(unsaved).length,
  };
}
export const useRegistry = () => { const r = getRegistry(); return [r, useSyncExternalStore(r.subscribe, r.snapshot)]; };
const exportText = (receipts) => JSON.stringify({ format: 'hashwing-outbox-export', version: 1, receipts }, null, 2) + '\n';
/** How many unsent proofs this tab holds in memory only (lost on reload unless exported). */
export function useRegistryUnsent() { const [r] = useRegistry(); return r.unsavedCount(); }
/** main.jsx tells the registry which local scope (a profile, or the shared guest scope) owns the pending proofs. */
export function registryScope(scope) { getRegistry().setScope(scope).catch(() => {}); }

// Called by main.jsx after a seal passed its own check. Only the receipt line goes to the outbox.
export function registrySealStart() { return getRegistry().sealStart(); }
/** The one receipt line the registry gets: the last receipt line of a receipts file or a whole receipt message. Jobs matches on this too. */
export function registryLine(receipts) {
  return String(receipts || '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('fseal-receipt ')).pop();
}
export function registrySealed(receipts, name, start) {
  const receipt = registryLine(receipts);
  if (receipt) getRegistry().sealed(receipt, name, start || undefined).catch(() => {}); // a seal never waits on or fails because of the registry
}
// The "Registry acceptance" time row for a checked receipt message: this device's outbox row for one of its receipt
// lines, matched on the stored receipt line. Only these strings reach the screen and the reports, never a row.
const REGISTERED_BASIS = "the registry's clock; the registry's statement, not proof of the files";
export function useRegistryTimeField(receipts, options) { return registryTimeField(useRegistry()[1], receipts, options); }
/** The same row from a session snapshot (pure, for tests). fromLink: a share link is open on Verify (a client, who needs no account). */
export function registryTimeField(s, receipts, { fromLink = false } = {}) {
  const lines = new Set(String(receipts || '').split('\n').map((line) => line.trim()).filter(Boolean));
  if (!lines.size) return null;
  const row = s.rows.find((r) => lines.has(r.receipt));
  if (row?.state === 'registered' && row.disposition === 'deleted') return { value: 'Registered, later deleted', basis: "the registry's statement, not proof of the files; its hosted record was deleted" };
  if (row?.state === 'registered') return { value: `Registered at ${row.received_at}`, basis: REGISTERED_BASIS };
  if (row?.state === 'needs_attention') return { value: 'Needs attention', basis: attentionMessage(row) ?? (REASONS[row.reason] ?? REFUSED)[0] };
  if (row) return { value: 'Not yet registered', basis: `this device's list: ${s.online || row.state !== 'sealed_local' ? row.label : stateLabel('waiting_for_connection')}` };
  if (s.pending.some((p) => lines.has(p.receipt))) return { value: 'Not yet registered', basis: "this device's list: Sealed locally" };
  if (!s.owner && fromLink) return { value: 'No account needed', basis: "not needed to check files from a share link" };
  if (!s.owner) return { value: 'Not signed in', basis: "sign in to the company registry to see this device's record" };
  if (!s.outbox || !s.listed) return { value: 'Not available yet', basis: "this device's registry list isn't open yet" };
  return { value: 'No registry record on this device', basis: 'this device has no registry record for this receipt' };
}

// Called from the app's logout paths: close the outbox and forget the registry token.
export function registryLogout() {
  if (registry) registry.logout();
  else storage.set('');
}

// ------------------------------------------------------------------ Trust: Company registry

/** Command bar, flag on: "{company} registry" while signed in. Sign-in and sign-out stay on Trust. */
export function RegistryBarLink({ href, onOpen }) {
  const [, s] = useRegistry();
  return s.claims && !s.needsSignIn ? <a className="registry-bar-link" href={href} onClick={onOpen} aria-label={`Company registry (${s.claims.org})`} title={s.claims.org}>Company registry</a> : null;
}
/** Seal & send, flag on and signed in: who the next seal registers for (EXPERIENCE.md signing line 3). */
export function RegistrySigningLine() {
  const [, s] = useRegistry();
  return s.claims && !s.needsSignIn ? <p className="registry-signing">Registering for <span className="wrap">{s.claims.org}</span> as <span className="wrap">{s.claims.sub}</span></p> : null;
}
/** After sealing, flag on: what a share link carries. Links are made from the row in "Sealed on this device". */
export function RegistryShareNote() {
  return <details className="report-details" onKeyDown={closeDisclosure}><summary>Share link <ChevronDown size={17} aria-hidden="true" /></summary>
    <p className="field-hint">A share link opens the registry's record of this receipt, not the files. Your client still needs the files and the receipt message. Make one from Sealed on this device once it shows Registered.</p>
  </details>;
}
export function RegistryPanel() {
  const [r, s] = useRegistry();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const local = isLoopback(__REGISTRY_URL__);
  const submit = async (event) => {
    event.preventDefault(); setError('');
    if (await r.signIn(draft)) setDraft('');
    else setError("This token can't be read. Paste the whole token.");
  };
  const role = s.claims?.role === 'admin' ? 'Admin' : 'Member';
  return <section className="panel registry-panel" id="company-registry" aria-labelledby="company-registry-title"><div className="panel-head"><Cloud aria-hidden="true" size={18} /><h2 id="company-registry-title">Company registry</h2></div><div className="panel-body">
    {s.claims && <>
      <p role="status">Signed in to the company registry as <span className="wrap">{s.claims.sub}</span> · <span className="wrap">{s.claims.org}</span> · {role}</p>
      {s.needsSignIn && <p className="registry-notice">Your registry sign-in has ended. Sign in again to send waiting proofs.</p>}
      <div className="actions-row"><button type="button" className="button secondary" onClick={() => r.signOut()}>Sign out</button></div>
    </>}
    {(!s.claims || s.needsSignIn) && (!local ? <p>Registry sign-in isn't available in this build yet.</p> : <form className="registry-signin" noValidate onSubmit={submit}>
      <h3>Test sign-in (local only)</h3>
      <label className="field-label" htmlFor="registry-token">Dev token</label>
      <input id="registry-token" type="password" className="mono-input" autoComplete="off" spellCheck="false" value={draft} aria-describedby={`registry-token-hint${error ? ' registry-token-error' : ''}`} onChange={(e) => setDraft(e.target.value)} />
      <p id="registry-token-hint" className="field-hint">Paste a token from the local test registry. It is kept in this tab only.</p>
      {error && <p id="registry-token-error" className="field-hint receipt-error" role="alert">{error}</p>}
      <div className="actions-row"><button type="submit" className="button secondary">Sign in</button></div>
    </form>)}
  </div></section>;
}

// ------------------------------------------------------------------ Seal & send: Sealed on this device

const isDeleted = (row) => row.state === 'registered' && row.disposition === 'deleted';
function chipOf(row) { // the outbox's own labels, verbatim
  if (isDeleted(row)) return [row.label, 'neutral'];
  if (row.state === 'registered') return [row.label, 'ok'];
  if (row.state === 'needs_attention') return [row.label, 'warn'];
  return [row.label, row.state === 'registering' ? 'neutral registry-dots' : 'neutral'];
}
const utc = (iso) => String(iso || '').replace('T', ' ').replace(/Z$/, ' UTC');

// Jobs (flag on): each job's status from this snapshot's outbox rows and pending proofs, matched on registryLine (the line the registry got).
// No request. Labels are the outbox's own, as in the list below; no record reads "Sealed locally" and is in no filter.
const JOB_FILTERS = [['waiting', 'Waiting to send'], ['registered', 'Registered'], ['problems', 'Needs attention']];
const JOB_DETAIL = 'Registry status';
function jobLine(row) { // the same sentences RegistryRow shows
  if (isDeleted(row)) return "The registry's record of this receipt was deleted. Links to it no longer open.";
  if (row.state === 'registered') return `Registered at ${utc(row.received_at)}. This is the registry's statement, not proof of the files.`;
  if (row.state === 'needs_attention') return attentionMessage(row) ?? (REASONS[row.reason] ?? REFUSED)[0];
  if (row.state === 'registering') return 'Sending the receipt to the registry…';
  if (row.state === 'waiting_for_connection') return row.reason === 'unavailable' || row.reason === 'http_503' ? 'The registry is busy right now. It will try again by itself.' : "Saved on this device. It will register when you're back online. You can close this tab.";
  return 'Sealed on this device. Not sent to the registry yet.';
}
/** Pure, for tests: receipt line -> { label, kind, group, line, at }. */
export function jobsStatusMap(s) {
  const map = new Map();
  for (const raw of s.rows) {
    const row = !s.online && raw.state === 'sealed_local' ? { ...raw, state: 'waiting_for_connection', label: stateLabel('waiting_for_connection') } : raw;
    const [label, kind] = chipOf(row);
    const group = row.state === 'registered' ? 'registered' : row.state === 'needs_attention' ? 'problems' : 'waiting';
    const at = row.state === 'registered' && !isDeleted(row) ? null : row.updated_at ?? null; // Registered carries the registry's own time in its line
    map.set(row.receipt, { label, kind: kind.split(' ')[0], group, line: jobLine(row), at });
  }
  for (const p of s.pending) {
    if (map.has(p.receipt)) continue;
    const line = !p.owner ? "Sealed while signed out, so it isn't assigned to a company yet. Assign it on Seal & send."
      : s.owner && p.owner !== s.owner ? "Sealed under another registry sign-in, so it won't be sent under yours."
      : 'Sealed on this device. Not sent to the registry yet.';
    map.set(p.receipt, { label: 'Sealed locally', kind: 'neutral', group: 'waiting', line, at: p.at ?? null });
  }
  const none = { label: 'Sealed locally', kind: 'neutral', group: null, at: null,
    line: !s.owner ? "Sign in to the company registry to see this job's registry status."
      : s.listed ? 'This device has no registry record for this job under the current sign-in.' : "This device's registry list isn't open yet." };
  return { map, none };
}
export function jobStatus({ map, none }, receipt) { return map.get(registryLine(receipt)) ?? none; }
export function useJobsRegistry() {
  const [, s] = useRegistry();
  const statusOf = useMemo(() => { const m = jobsStatusMap(s); return (job) => jobStatus(m, job.receipt); }, [s]);
  // Wait for the outbox list (or a saved sign-in still resuming) before an out-of-range ?page settles on a real one.
  const ready = s.listed || !!s.listError || (!s.owner && !storage.get().token);
  return { statusOf, filters: JOB_FILTERS, detailLabel: JOB_DETAIL, ready };
}

export function SealedOnDevice({ onSignIn }) {
  const [r, s] = useRegistry();
  const [exportStatus, setExportStatus] = useState('');
  const [exported, setExported] = useState(false);
  const importRef = useRef(null);
  const [announce, setAnnounce] = useState('');
  const seen = useRef(null);
  useEffect(() => { setAnnounce(''); seen.current = null; }, [s.owner]); // a new owner never hears the last one's file names
  // Offline, the outbox leaves a new row in sealed_local (it doesn't try to send); to the user it is waiting for the connection.
  const shown = s.online ? s.rows : s.rows.map((row) => (row.state === 'sealed_local' ? { ...row, state: 'waiting_for_connection', label: stateLabel('waiting_for_connection') } : row));
  const rows = [...shown, ...s.pending.map((p) => ({ id: `pending:${p.receipt}`, receipt: p.receipt, state: 'sealed_local', label: 'Sealed locally', created_at: p.at, pending: true, held: !!(s.owner && p.owner && p.owner !== s.owner), unassigned: !p.owner }))];
  const nameOf = (row) => r.names.get(row.receipt) || 'Sealed item';
  const chipKey = rows.map((row) => `${row.id}=${chipOf(row)[0]}`).join('|');
  useEffect(() => {
    const now = new Map(rows.map((row) => [row.id, chipOf(row)[0]]));
    if (seen.current) {
      const changed = rows.filter((row) => seen.current.get(row.id) !== now.get(row.id));
      if (changed.length) setAnnounce(changed.map((row) => `${nameOf(row)}: ${now.get(row.id)}`).join('. '));
    }
    seen.current = now;
  }, [chipKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const registered = rows.filter((row) => row.state === 'registered').length; // "later deleted" rows were registered too
  const waiting = rows.filter((row) => row.state !== 'registered').length;
  const exportProofs = async () => {
    setExportStatus('');
    const out = await r.exportPending();
    if (!out.ok) { setExportStatus(NOTHING); return; }
    saveFile('hashwing-pending-proofs.json', out.text);
    setExported(true);
    setExportStatus(`Exported ${out.count} proofs. Keep this file until they show Registered.`);
  };
  const importFile = async (file) => {
    if (importRef.current) importRef.current.value = '';
    if (!file) return;
    setExportStatus('');
    let text = '';
    try { text = file.size > 4 * 1024 * 1024 ? '' : await file.text(); } catch { text = ''; }
    const out = await r.importProofs(text);
    if (out.ok) setExportStatus(`Added ${out.added} proofs to send.`);
    else if (out.reason === 'signed_out') setExportStatus('Sign in to the company registry first, then import the file again.');
    else if (out.reason === 'full') setExportStatus(FULL);
    else if (out.reason === 'not_an_export') setExportStatus("This file isn't a HashWing pending-proofs export.");
    else setExportStatus("Couldn't read this file. Choose it again.");
  };
  return <section className="panel registry-list" aria-labelledby="sealed-on-device-title"><div className="panel-head"><HardDrive aria-hidden="true" size={18} /><h2 id="sealed-on-device-title">Sealed on this device</h2></div><div className="panel-body">
    {!s.online && <p className="registry-notice">You're offline. Sealing and checking still work. Registrations will send when you reconnect.</p>}
    {(s.needsSignIn || !s.claims) && rows.some((row) => row.state !== 'registered') && <div className="registry-notice"><p>{SIGN_IN}</p><button type="button" className="button secondary" onClick={onSignIn}>Sign in</button></div>}
    {(s.memory || (s.pendingStorage === 'memory' && s.pending.length > 0)) && !exported && <div className="registry-notice"><p>{MEMORY}</p><button type="button" className="button secondary" onClick={exportProofs}>Export pending proofs</button></div>}
    {s.listError && <p className="registry-notice" role="alert">{s.listError}</p>}
    {s.enqueueError && <p className="registry-notice" role="alert">{s.enqueueError}</p>}
    {rows.length ? <>
      <p className="registry-summary">{registered} registered · {waiting} not yet registered</p>
      <ul className="registry-rows">{rows.map((row) => <li key={row.id}><RegistryRow row={row} name={nameOf(row)} registry={r} org={s.claims?.org || ''} signedIn={!!s.owner} admin={s.claims?.role === 'admin'} outbox={s.outbox} onSignIn={onSignIn} onExport={exportProofs} /></li>)}</ul>
    </> : <p className="field-hint">Nothing sealed on this device yet.</p>}
    <p className="visually-hidden registry-announce" role="status">{announce}</p>
    <details className="report-details registry-more" onKeyDown={closeDisclosure}><summary>More options <ChevronDown size={17} aria-hidden="true" /></summary>
      <div className="actions-row"><button type="button" className="button secondary" onClick={exportProofs}>Export pending proofs</button>
        {s.outbox && <label className="button secondary key-import-button" htmlFor="registry-import">Import pending proofs<input id="registry-import" ref={importRef} type="file" accept=".json,application/json" onChange={(e) => importFile(e.target.files?.[0] || null)} /></label>}</div>
      {exportStatus && <p className="field-hint" role="status">{exportStatus}</p>}
    </details>
  </div></section>;
}

function RegistryRow({ row, name, registry, org, signedIn, admin, outbox, onSignIn, onExport }) {
  const [chip, kind] = chipOf(row);
  const when = new Date(row.created_at).toLocaleString();
  const retry = () => outbox?.retryNow(row.id);
  let body;
  if (row.unassigned) { // never sent by itself: the user chooses the company, and the registry re-checks key and membership
    body = outbox ? <><p>Sealed while signed out, so it isn't assigned to a company yet.</p>
      <div className="actions-row"><button type="button" className="button secondary" onClick={() => registry.assign(row.receipt)}>{org ? `Assign to ${org}` : 'Assign to this company'}</button></div></>
      : signedIn ? <p>Sealed while signed out, so it isn't assigned to a company yet. It can be assigned once this device's list opens; export it to keep a copy.</p>
      : <p>Sealed while signed out, so it isn't assigned to a company yet. Sign in to the company registry to assign it, or export it.</p>;
  } else if (row.held) {
    body = <><p>This was sealed under another registry sign-in, so it won't be sent under yours. Export it, or sign in as that account to send it.</p>
      <div className="actions-row"><button type="button" className="button secondary" onClick={onExport}>Export pending proofs</button></div></>;
  } else if (row.state === 'sealed_local') {
    body = <p>Sealed on this device. Not sent to the registry yet.</p>;
  } else if (row.state === 'waiting_for_connection') {
    const busy = row.reason === 'unavailable' || row.reason === 'http_503';
    body = <><p>{busy ? 'The registry is busy right now. It will try again by itself.' : "Saved on this device. It will register when you're back online. You can close this tab."}</p>
      <div className="actions-row"><button type="button" className="button secondary" onClick={retry}>Try now</button></div></>;
  } else if (row.state === 'registering') {
    body = <p>Sending the receipt to the registry…</p>;
  } else if (row.state === 'registered' && row.disposition === 'deleted') {
    body = <p>The registry's record of this receipt was deleted. Links to it no longer open.</p>;
  } else if (row.state === 'registered') {
    body = <><p>Registered at {utc(row.received_at)}. This is the registry's statement, not proof of the files.</p>
      <ShareLinks row={row} client={registry.client} />
      {admin && <DeleteRecord row={row} client={registry.client} outbox={outbox} />}</>;
  } else {
    const [text, action] = REASONS[row.reason] ?? REFUSED;
    body = <><p>{attentionMessage(row) ?? text}</p>
      {row.reason === 'key_not_enrolled' && <KeyFingerprint receipt={row.receipt} />}
      {action === 'retry' && <div className="actions-row"><button type="button" className="button secondary" onClick={retry}>Try again</button></div>}
      {action === 'export' && <div className="actions-row"><button type="button" className="button secondary" onClick={onExport}>Export pending proofs</button></div>}
      {action === 'trust' && <div className="actions-row"><button type="button" className="button secondary" onClick={onSignIn}>Open Trust</button></div>}
      <details className="report-details registry-tech" onKeyDown={closeDisclosure}><summary>More options <ChevronDown size={17} aria-hidden="true" /></summary>
        {row.reason === 'quota_exceeded' && <div className="actions-row"><button type="button" className="button secondary" onClick={retry}>Try again</button></div>}
        <p className="field-hint">Technical details: {row.reason}</p></details></>;
  }
  return <details className="registry-row" onKeyDown={closeDisclosure}>
    <summary><span className="registry-name wrap">{name}</span><span className="registry-when">sealed {when}</span><span className={`status-label ${kind}`}>{chip}</span></summary>
    <div className="registry-detail">{body}</div>
  </details>;
}

// The registry's key_fingerprint is SHA-256 of the receipt's raw public key (registry/registry/receipt.py fingerprint).
function KeyFingerprint({ receipt }) {
  const [fp, setFp] = useState('');
  useEffect(() => {
    let live = true;
    const key = / key=([0-9a-f]{64}) /.exec(receipt || '')?.[1];
    if (key) fingerprintHex(key).then((v) => { if (live) setFp(v); }, () => {});
    return () => { live = false; };
  }, [receipt]);
  return fp ? <dl className="detail-grid registry-fingerprint"><dt>Key fingerprint</dt><dd><code className="wrap fingerprint">{formatFingerprint(fp)}</code></dd></dl> : null;
}

function shareError(res) {
  if (res.kind === 'network' || res.kind === 'timeout') return "The registry didn't answer. Check your connection, then try again.";
  if (res.status === 401) return 'Your registry sign-in has ended. Sign in again on the Trust page, then try again.';
  if (res.status === 404) return "The registry no longer has this record, so its link can't be changed. Make a new link if the record is still registered.";
  if (res.code === 'share_limit') return 'This record has as many links as it can hold. Withdraw one, then try again.';
  if (res.kind === 'client') return "This browser can't make a link here. Open HashWing over HTTPS, then try again.";
  return "The registry couldn't do that right now. Try again in a few minutes.";
}

function ShareLinks({ row, client }) {
  const [days, setDays] = useState(30);
  const [link, setLink] = useState(null); // { token, url, expires } in React state only, never stored
  const [retryShare, setRetryShare] = useState(null); // the share object of a call whose answer was lost
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fieldRef = useRef(null);
  const id = `share-${row.id.slice(0, 16)}`;
  const make = async () => {
    setBusy(true); setError(''); setMessage('');
    const res = await client.createShare({ registration_id: row.registration_id, expires_days: days, ...(retryShare || {}) });
    setBusy(false);
    if (res.ok && res.data?.disposition === 'active') {
      setRetryShare(null);
      setLink({ token: res.share.token, url: `${location.origin}${location.pathname}#/app/verify?share=${res.share.token}`, expires: res.data.expires_at ? new Date(res.data.expires_at).toLocaleDateString() : '' });
      return;
    }
    setRetryShare(res.kind === 'network' || res.kind === 'timeout' ? res.share : null); // a retry returns the same link
    setError(res.ok ? "This link can't be used any more. Make a new link." : shareError(res));
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link.url); setMessage('Link copied'); }
    catch { fieldRef.current?.select(); setMessage('Copying was blocked. The link is selected, so copy it from the field.'); }
  };
  const withdraw = async () => {
    setBusy(true); setError(''); setMessage('');
    const res = await client.withdrawShare(link.token);
    setBusy(false);
    if (res.ok || res.status === 404) { setLink(null); setMessage("Link withdrawn. It no longer opens. Copies of the receipt someone already has aren't affected."); }
    else setError(shareError(res));
  };
  return <div className="registry-share">
    {link ? <>
      <label className="field-label" htmlFor={`${id}-url`}>Share link</label>
      <input id={`${id}-url`} ref={fieldRef} type="text" className="mono-input" readOnly value={link.url} aria-describedby={`${id}-hint`} onFocus={(e) => e.target.select()} />
      <p id={`${id}-hint`} className="field-hint">Anyone with this link can see that the registry received this receipt. They still need the files and the receipt message to check the files. {link.expires ? `This link stops working on ${link.expires}.` : 'It stops working when it expires.'}</p>
      <div className="actions-row registry-share-actions"><button type="button" className="button secondary" onClick={copy}>Copy link</button><button type="button" className="button secondary" disabled={busy} onClick={withdraw}>Withdraw link</button></div>
    </> : <>
      <div className="actions-row"><button type="button" className="button secondary" disabled={busy} onClick={make}><Link2 aria-hidden="true" size={16} />Make a share link</button></div>
      <details className="report-details registry-tech" onKeyDown={closeDisclosure}><summary>More options <ChevronDown size={17} aria-hidden="true" /></summary>
        <label className="field-label" htmlFor={`${id}-days`}>Link lasts</label>
        <select id={`${id}-days`} value={days} onChange={(e) => { setDays(Number(e.target.value)); setRetryShare(null); }}>{[7, 30].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
      </details>
    </>}
    {error && <p className="field-hint receipt-error" role="alert">{error}</p>}
    <p className="field-hint" role="status">{message}</p>
  </div>;
}

function DeleteRecord({ row, client, outbox }) {
  const dialogRef = useRef(null);
  const triggerRef = useRef(null);
  const keepRef = useRef(null); // the safe choice has the focus
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const close = () => { dialogRef.current?.close(); };
  const confirm = async () => {
    setBusy(true); setError('');
    const res = await client.deleteRegistration(row.registration_id);
    setBusy(false);
    if (res.ok || res.status === 404) {
      close();
      let saved = false;
      try { saved = (await outbox?.markDeleted(row.id)) === true; } catch { saved = false; }
      if (!saved) setError("The hosted record was deleted, but this device couldn't update its saved list. Reload to see the change.");
      return;
    }
    close();
    setError(res.status === 403 ? 'Only a company admin can delete a hosted record.' : res.kind === 'network' || res.kind === 'timeout' ? "The registry didn't answer. Check your connection, then try again." : "The registry couldn't delete this record right now. Try again in a few minutes.");
  };
  const titleId = `delete-${row.id.slice(0, 16)}-title`;
  return <div className="registry-delete">
    <button ref={triggerRef} type="button" className="button secondary" onClick={() => { setError(''); dialogRef.current?.showModal(); keepRef.current?.focus(); }}>Delete hosted record</button>
    {error && <p className="field-hint receipt-error" role="alert">{error}</p>}
    <dialog ref={dialogRef} className="registry-dialog" aria-labelledby={titleId} onClose={() => triggerRef.current?.focus()}>
      <h2 id={titleId}>Delete the hosted record?</h2>
      <p>This removes the registry's record of this receipt and stops every link to it. Your sealed files and receipt messages are not touched. Anyone who already downloaded a report keeps it; HashWing can't recall copies.</p>
      <div className="actions-row"><button type="button" className="button registry-bad" disabled={busy} onClick={confirm}>Delete hosted record</button><button ref={keepRef} type="button" className="button secondary" onClick={close}>Keep it</button></div>
    </dialog>
  </div>;
}

// One registry panel that fails to render shows this notice instead of blanking the whole app.
export class RegistryBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="registry-notice" role="alert">This registry section couldn't be shown. Sealing and checking still work. Reload the page to try again.</p> : this.props.children; }
}

// ------------------------------------------------------------------ Verify: the recipient's share view

export function ShareRecordPanel({ token }) {
  const [view, setView] = useState({ state: 'loading' });
  useEffect(() => {
    let live = true;
    if (!SHARE_TOKEN.test(token || '')) { setView({ state: 'error', message: LINK_DEAD }); return undefined; }
    setView({ state: 'loading' });
    createRegistryClient({ baseUrl: __REGISTRY_URL__ }).getShare(token).then((res) => {
      if (!live) return;
      const record = res.ok ? shareRecord(res.data) : null;
      if (record) setView({ state: 'ok', data: record });
      else if (res.kind === 'network' || res.kind === 'timeout') setView({ state: 'error', message: "You're offline. Opening a link needs a connection. You can still check files." });
      else if (res.ok || res.status === 503 || res.status === 429) setView({ state: 'error', message: UNAVAILABLE });
      else setView({ state: 'error', message: LINK_DEAD });
    });
    return () => { live = false; };
  }, [token]);
  const d = view.data;
  return <section className="panel registry-record" aria-labelledby="registry-record-title"><div className="panel-head"><Cloud aria-hidden="true" size={18} /><h2 id="registry-record-title">The registry's record</h2></div><div className="panel-body">
    {view.state === 'loading' && <p role="status">Checking the link…</p>}
    {view.state === 'error' && <p className="registry-notice" role="alert">{view.message}</p>}
    {view.state === 'ok' && <>
      <dl className="detail-grid">
        <dt>Chain head</dt><dd><code className="wrap">{d.head}</code></dd>
        <dt>Records</dt><dd className="mono-values">{d.count}</dd>
        <dt>Key fingerprint</dt><dd><code className="wrap fingerprint">{formatFingerprint(d.key_fingerprint)}</code></dd>
        <dt>Received by the registry</dt><dd>{utc(d.received_at)}<span className="field-hint registry-basis">the registry's clock; the registry's statement, not proof of the files</span></dd>
      </dl>
      <p>The registry checked that this key is enrolled for the company's account. It did not check who the company is. Compare the fingerprint with one you got from the company yourself.</p>
      <p><strong>This record is not a check of your files. To check them, use the sealed file and the receipt message you were sent, below.</strong></p>
    </>}
  </div></section>;
}
