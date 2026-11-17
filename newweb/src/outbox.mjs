// Owner-scoped offline outbox for receipt registration. See docs/OUTBOX.md.
// One IndexedDB database per owner; an in-memory store with the same interface backs the tests and is the
// fallback when IndexedDB cannot be opened. Nothing but the receipt line and registry bookkeeping is stored.
import { tokenOwner } from './registry-client.mjs';

export const MAX_QUEUE = 200;
export const MAX_ACKS = 1000;
export const MAX_ATTEMPTS = 10;
const BACKOFF_BASE = 2000;
const BACKOFF_CAP = 15 * 60 * 1000;
const ENVELOPE_MARGIN = 5 * 60 * 1000; // do not bind an envelope that expires sooner than this
const LOCK_BUSY_RETRY = 5000;
const SIGNIN_RECHECK = 30000; // with no usable token, look for a new one this often
const EXPORT_FORMAT = 'hashwing-outbox-export';

const BASE_FIELDS = ['id', 'receipt', 'envelope_id', 'envelope_expires_at', 'envelope_epoch', 'idempotency_key', 'state',
  'reason', 'attempts', 'next_attempt_at', 'created_at', 'updated_at'];
const ACK_FIELDS = ['registration_id', 'received_at', 'count', 'head', 'key_fingerprint', 'disposition', 'acked_at'];
export const ROW_FIELDS = Object.freeze([...BASE_FIELDS, ...ACK_FIELDS]);
export const STATES = Object.freeze(['sealed_local', 'registering', 'waiting_for_connection', 'registered', 'needs_attention']);
// needs_attention reasons that retryNow(id) may act on; every other reason is terminal.
// The three envelope refusals: each needs a new envelope (and so a new key), bound only by an explicit retryNow(id).
const ENVELOPE_REASONS = new Set(['envelope_expired', 'epoch_mismatch', 'sub_mismatch']);
// quota_exceeded is never retried automatically; an explicit retryNow(id) (for example next month) may try again.
const RETRYABLE = new Set([...ENVELOPE_REASONS, 'key_not_enrolled', 'key_not_active', 'attempts_exhausted', 'quota_exceeded']);
const REASONS = { idempotency_conflict: 'conflict' };

// Same shape as registry/registry/receipt.py parse(): six tokens, lowercase hex, 0 < count < 2^64.
const RECEIPT_RE = /^fseal-receipt v1 count=([0-9]{1,20}) head=[0-9a-f]{64} key=[0-9a-f]{64} sig=[0-9a-f]{128}$/;
export function isReceipt(text) {
  const m = typeof text === 'string' && RECEIPT_RE.exec(text);
  if (!m) return false;
  const n = BigInt(m[1]);
  return n > 0n && n < 2n ** 64n;
}

// Attempt n (from 1): d = min(15 min, 2 s * 2^(n-1)); delay drawn from [d/2, d] (equal jitter).
export function backoffDelay(n, random = Math.random) {
  const d = Math.min(BACKOFF_CAP, BACKOFF_BASE * 2 ** (Math.max(1, n) - 1));
  return d / 2 + random() * (d / 2);
}

const STATE_LABELS = { sealed_local: 'Sealed locally', registering: 'Registering', waiting_for_connection: 'Waiting for connection',
  registered: 'Registered', needs_attention: 'Needs attention' };
export const stateLabel = (state) => STATE_LABELS[state] ?? 'Unknown';
export const registrationLabel = (ack) => (ack?.disposition === 'deleted' ? 'Registered, later deleted' : 'Registered');
const ATTENTION_MESSAGES = {
  quota_exceeded: "Your company's monthly registration limit is reached; this proof is saved and can be exported",
};
// Plain text for a needs_attention row whose reason has a dedicated message; undefined otherwise.
export const attentionMessage = (row) => (row?.state === 'needs_attention' ? ATTENTION_MESSAGES[row.reason] : undefined);
const withLabel = (row) => {
  const out = { ...row, label: row.state === 'registered' ? registrationLabel(row) : stateLabel(row.state) };
  const message = attentionMessage(row);
  if (message) out.message = message;
  return out;
};

function checkRow(row, acked) {
  for (const k of Object.keys(row)) {
    if (!ROW_FIELDS.includes(k)) throw new TypeError(`outbox: field not allowed: ${k}`);
    if (!acked && ACK_FIELDS.includes(k)) throw new TypeError(`outbox: ack field on a row with no ack: ${k}`);
  }
  if (typeof row.id !== 'string') throw new TypeError('outbox: row id missing');
}
const clean = (row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
const byCreated = (a, b) => (a.created_at - b.created_at) || (a.id < b.id ? -1 : 1);

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const idempotencyKey = async (ownerId, receipt, envelopeId) => b64url(await sha256(`${ownerId}\n${receipt}\n${envelopeId}`));

// ------------------------------------------------------------------ stores

// `fail(op)` returning true makes that call throw (tests: quota, commit failure).
export function createMemoryStore({ fail = () => false } = {}) {
  const queue = new Map(), acks = new Map(), meta = new Map();
  const guard = (op) => { if (fail(op)) throw new Error(`memory store: ${op} failed`); };
  const copy = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    kind: 'memory',
    has: (id) => queue.has(id),
    async getRow(id) { guard('getRow'); return copy(queue.get(id)); },
    async getAck(id) { guard('getAck'); return copy(acks.get(id)); },
    async putRow(row) { checkRow(row, false); guard('putRow'); queue.set(row.id, copy(row)); },
    async commitAck(ack) {
      checkRow(ack, true);
      guard('commitAck');
      acks.set(ack.id, copy(ack));
      queue.delete(ack.id);
      if (acks.size > MAX_ACKS) {
        const old = [...acks.values()].sort((a, b) => a.acked_at - b.acked_at).slice(0, acks.size - MAX_ACKS);
        for (const a of old) acks.delete(a.id);
      }
    },
    async listQueue() { guard('listQueue'); return [...queue.values()].map(copy); },
    async listAcks() { guard('listAcks'); return [...acks.values()].map(copy); },
    async getMeta(k) { guard('getMeta'); return copy(meta.get(k)); },
    async putMeta(k, v) { guard('putMeta'); meta.set(k, copy(v)); },
    async deleteMeta(k) { guard('deleteMeta'); meta.delete(k); },
    close() {},
  };
}

const idbRequest = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const idbDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});

async function openIdbStore(idb, name) {
  const db = await new Promise((resolve, reject) => {
    const r = idb.open(name, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('queue', { keyPath: 'id' });
      d.createObjectStore('acks', { keyPath: 'id' }).createIndex('acked_at', 'acked_at');
      d.createObjectStore('meta');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('indexedDB open blocked'));
  });
  async function run(names, mode, fn) {
    const tx = db.transaction(names, mode);
    const req = fn(tx);
    await idbDone(tx);
    return req?.result;
  }
  return {
    kind: 'indexeddb',
    getRow: (id) => run(['queue'], 'readonly', (tx) => tx.objectStore('queue').get(id)),
    getAck: (id) => run(['acks'], 'readonly', (tx) => tx.objectStore('acks').get(id)),
    async putRow(row) { checkRow(row, false); await run(['queue'], 'readwrite', (tx) => { tx.objectStore('queue').put(row); }); },
    async commitAck(ack) {
      checkRow(ack, true);
      await run(['queue', 'acks'], 'readwrite', (tx) => {
        const acks = tx.objectStore('acks');
        acks.put(ack);
        tx.objectStore('queue').delete(ack.id);
        const count = acks.count();
        count.onsuccess = () => {
          let extra = count.result - MAX_ACKS;
          if (extra <= 0) return;
          const cur = acks.index('acked_at').openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c || extra <= 0) return;
            c.delete();
            extra -= 1;
            c.continue();
          };
        };
      });
    },
    listQueue: () => run(['queue'], 'readonly', (tx) => tx.objectStore('queue').getAll()),
    listAcks: () => run(['acks'], 'readonly', (tx) => tx.objectStore('acks').getAll()),
    getMeta: (k) => run(['meta'], 'readonly', (tx) => tx.objectStore('meta').get(k)),
    async putMeta(k, v) { await run(['meta'], 'readwrite', (tx) => { tx.objectStore('meta').put(v, k); }); },
    async deleteMeta(k) { await run(['meta'], 'readwrite', (tx) => { tx.objectStore('meta').delete(k); }); },
    close() { db.close(); },
  };
}

function defaultOnline() {
  const w = globalThis;
  return {
    isOnline: () => w.navigator?.onLine !== false,
    subscribe(cb) {
      if (typeof w.addEventListener !== 'function') return () => {};
      const on = () => cb(true), off = () => cb(false);
      w.addEventListener('online', on);
      w.addEventListener('offline', off);
      return () => { w.removeEventListener('online', on); w.removeEventListener('offline', off); };
    },
  };
}

// ------------------------------------------------------------------ outbox

const STOP = 'stop', NEXT = 'next';

export async function openOutbox({
  ownerId, client, getToken,
  indexedDB = globalThis.indexedDB,
  locks = globalThis.navigator?.locks,
  now = Date.now, random = Math.random,
  setTimeout: setT = globalThis.setTimeout.bind(globalThis),
  clearTimeout: clearT = globalThis.clearTimeout.bind(globalThis),
  online = defaultOnline(),
  store: injectedStore, // test seam: a createMemoryStore() instance
} = {}) {
  if (typeof ownerId !== 'string' || !/^[^/]+\/[^/]+$/.test(ownerId)) throw new TypeError('outbox: ownerId must be <org>/<sub>');
  if (!client || typeof getToken !== 'function') throw new TypeError('outbox: client and getToken are required');
  const hash = hex(await sha256(ownerId));
  const lockName = `hashwing-outbox:${hash}`;

  let store, storage, exportOffered = false;
  if (injectedStore) {
    store = injectedStore; storage = injectedStore.kind || 'memory';
  } else {
    try {
      if (!indexedDB) throw new Error('no indexedDB');
      store = await openIdbStore(indexedDB, `hashwing-outbox-v1-${hash}`);
      storage = 'indexeddb';
    } catch {
      store = createMemoryStore(); storage = 'memory'; exportOffered = true;
    }
  }
  let spill = null; // rows whose persistent write failed
  let gen = 0, closed = false, needsSignIn = false, badToken = null;
  let timer = null, inflight = null, running = null, rerun = false, force = false, prefetched = false, wakeAt = Infinity;
  let serverEpoch = null; // read once per open, before anything is dispatched
  const listeners = new Set();

  const emit = () => { for (const fn of listeners) { try { fn(); } catch { /* listener errors stay with the listener */ } } };
  const storeOf = (id) => (spill && spill.has(id) ? spill : store);
  const safe = async (p, fallback) => { try { return await p; } catch { return fallback; } };
  const allQueue = async () => [...(await safe(store.listQueue(), [])), ...(spill ? await spill.listQueue() : [])];
  const save = async (row) => { await storeOf(row.id).putRow(clean(row)); };
  const setSignIn = (v) => { if (needsSignIn !== v) { needsSignIn = v; emit(); } };
  const clearTimer = () => { if (timer) { clearT(timer); timer = null; } };
  const schedule = (ms) => { clearTimer(); if (!closed) timer = setT(() => { timer = null; kick(); }, Math.max(0, ms)); };

  async function authToken(g) {
    let tok;
    try { tok = await getToken(); } catch { tok = null; }
    if (g !== gen) return null;
    if (!tok || tokenOwner(tok) !== ownerId) { setSignIn(true); return null; } // never send another owner's rows
    if (needsSignIn && tok === badToken) return null;
    badToken = null;
    setSignIn(false);
    return tok;
  }

  async function bind(row, env) {
    return { ...row, envelope_id: env.envelope_id, envelope_expires_at: env.expires_at, envelope_epoch: env.epoch,
      idempotency_key: await idempotencyKey(ownerId, row.receipt, env.envelope_id) };
  }
  const usable = (env) => env && typeof env.envelope_id === 'string' && env.expires_at - ENVELOPE_MARGIN > now();

  // {env} from the cache or a fresh fetch, {result} on a failed fetch, {stop} when closed meanwhile.
  async function ensureEnvelope(g, token) {
    const cached = await safe(store.getMeta('envelope'), null);
    if (g !== gen) return { stop: true };
    if (usable(cached)) return { env: cached };
    inflight = new AbortController();
    const r = await client.envelope({ signal: inflight.signal, token });
    inflight = null;
    if (g !== gen) return { stop: true };
    if (!r.ok) return { result: r };
    const env = { envelope_id: r.data?.envelope_id, expires_at: Date.parse(r.data?.expires_at), epoch: r.data?.epoch };
    if (!/^[0-9a-f]{32}$/.test(env.envelope_id || '') || !Number.isFinite(env.expires_at) || !Number.isInteger(env.epoch)) {
      return { result: { ok: false, kind: 'http', status: r.status, code: 'bad_response' } };
    }
    await safe(store.putMeta('envelope', env));
    if (g !== gen) return { stop: true };
    return { env };
  }

  async function handleResult(row, prev, res, token, g) {
    const t = now();
    if (res.ok) {
      const d = res.data || {};
      if (typeof d.registration_id !== 'string' || typeof d.received_at !== 'string') { // not an ack: retry, same key
        return handleResult(row, prev, { ok: false, kind: 'http', status: res.status, code: 'bad_response' }, token, g);
      }
      const ack = clean({ ...row, state: 'registered', reason: undefined, next_attempt_at: undefined, updated_at: t,
        registration_id: d.registration_id, received_at: d.received_at, count: d.count, head: d.head,
        key_fingerprint: d.key_fingerprint, disposition: d.disposition, acked_at: t });
      try {
        await storeOf(row.id).commitAck(ack);
      } catch {
        exportOffered = true; emit(); // the queue row stays; the scheduled retry replays the same key
        wakeAt = Math.min(wakeAt, now() + backoffDelay(1, random));
        return STOP;
      }
      if (g !== gen) return STOP;
      emit();
      return NEXT;
    }
    if (res.kind === 'aborted') return STOP;
    if (res.status === 401) {
      badToken = token;
      await save({ ...row, state: prev, updated_at: t });
      if (g === gen) setSignIn(true);
      return STOP;
    }
    // A 429 with the registry's quota_exceeded code is the monthly limit: final for the month (below). Any other 429
    // is API Gateway throttling and is retried later.
    if (res.kind === 'network' || res.kind === 'timeout' || res.code === 'bad_response'
        || (res.status === 429 && res.code !== 'quota_exceeded')
        || res.status === 408 || res.status >= 500) {
      const attempts = (row.attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await save({ ...row, attempts, state: 'needs_attention', reason: 'attempts_exhausted', next_attempt_at: undefined, updated_at: t });
      } else {
        await save({ ...row, attempts, state: 'waiting_for_connection', reason: res.code, next_attempt_at: t + backoffDelay(attempts, random), updated_at: t });
      }
      if (g === gen) emit();
      return STOP;
    }
    const reason = REASONS[res.code] ?? res.code;
    if (ENVELOPE_REASONS.has(reason)) {
      prefetched = true; // no new envelope until an explicit retryNow(id)
      const cached = await safe(store.getMeta('envelope'), null);
      if (g !== gen) return STOP;
      if (cached?.envelope_id === row.envelope_id) await safe(store.deleteMeta('envelope'));
      if (g !== gen) return STOP;
    }
    await save({ ...row, state: 'needs_attention', reason, next_attempt_at: undefined, updated_at: t });
    if (g === gen) emit();
    return NEXT;
  }

  async function dispatchRow(row, g) {
    const token = await authToken(g);
    if (!token) return STOP;
    const prev = row.state === 'registering' ? 'sealed_local' : row.state; // a registering row seen here is stale
    if (!row.envelope_id) {
      const e = await ensureEnvelope(g, token);
      if (e.stop) return STOP;
      if (e.result) return handleResult(row, prev, e.result, token, g);
      row = await bind(row, e.env);
      if (g !== gen) return STOP;
    } else if (serverEpoch !== null && !(row.envelope_epoch >= serverEpoch)) { // an admin bumped the epoch
      await save({ ...row, state: 'needs_attention', reason: 'epoch_mismatch', next_attempt_at: undefined, updated_at: now() });
      if (g === gen) emit();
      return NEXT;
    } else if (!(row.envelope_expires_at > now())) {
      await save({ ...row, state: 'needs_attention', reason: 'envelope_expired', next_attempt_at: undefined, updated_at: now() });
      if (g === gen) emit();
      return NEXT;
    }
    row = { ...row, state: 'registering', updated_at: now() };
    await save(row); // binding (envelope + key) and the state change are one write
    if (g !== gen) return STOP;
    emit();
    inflight = new AbortController();
    const res = await client.register({ receipt: row.receipt, idempotency_key: row.idempotency_key, envelope_id: row.envelope_id },
      { signal: inflight.signal, token });
    inflight = null;
    if (g !== gen) return STOP; // closed meanwhile: drop the late result
    return handleResult(row, prev, res, token, g);
  }

  // An admin may have bumped the epoch since envelopes were issued. Read it once per open, before dispatching, and
  // drop a cached envelope from an older epoch (or with none recorded) rather than bind or send it.
  async function checkEpoch(g) {
    const token = await authToken(g);
    if (!token || g !== gen) return;
    inflight = new AbortController();
    const ep = await client.getEpoch({ token, signal: inflight.signal });
    inflight = null;
    if (g !== gen) return;
    if (ep.status === 401) { badToken = token; setSignIn(true); return; }
    if (!ep.ok || !Number.isInteger(ep.data?.epoch)) return; // try again next drain
    serverEpoch = ep.data.epoch;
    const cached = await safe(store.getMeta('envelope'), null);
    if (g !== gen) return;
    if (cached && !(Number.isInteger(cached.epoch) && cached.epoch >= serverEpoch)) await safe(store.deleteMeta('envelope'));
  }

  async function drain() {
    const g = gen;
    const forced = force;
    force = false;
    clearTimer();
    wakeAt = Infinity;
    if (!forced && !online.isOnline()) return;
    if (serverEpoch === null) {
      await checkEpoch(g);
      if (g !== gen) return;
    }
    const rows = await allQueue();
    if (g !== gen) return;
    const t = now();
    const due = rows.filter((r) => r.state !== 'needs_attention' && (forced || !(r.next_attempt_at > t))).sort(byCreated);
    let stopped = false;
    for (const row of due) {
      if ((await dispatchRow(row, g)) === STOP) { stopped = true; break; }
      if (g !== gen) return;
    }
    if (g !== gen) return;
    if (!stopped && !prefetched && online.isOnline()) { // once per open, so a later offline enqueue can bind at once
      prefetched = true;
      const token = await authToken(g);
      if (token) {
        const e = await ensureEnvelope(g, token);
        if (g !== gen) return;
        if (e.result?.status === 401) { badToken = token; setSignIn(true); }
      }
      if (g !== gen) return;
    }
    const waiting = (await allQueue()).filter((r) => r.state === 'waiting_for_connection' && r.next_attempt_at);
    if (g !== gen) return;
    const at = Math.min(wakeAt, ...waiting.map((r) => r.next_attempt_at), needsSignIn ? now() + SIGNIN_RECHECK : Infinity);
    if (at < Infinity) schedule(at - now());
  }

  async function withLock(fn) {
    if (!locks?.request) return fn();
    const got = await locks.request(lockName, { ifAvailable: true }, async (lock) => { if (!lock) return false; await fn(); return true; });
    if (!got && !closed) schedule(LOCK_BUSY_RETRY); // another tab is dispatching; look again later
  }

  function kick(forced = false) {
    if (closed) return Promise.resolve();
    if (forced) force = true;
    if (running) { rerun = true; return running; }
    running = (async () => {
      try {
        do {
          rerun = false;
          try { await withLock(drain); } catch { exportOffered = true; emit(); }
        } while (rerun && !closed);
      } finally { running = null; }
    })();
    return running;
  }

  async function findRow(id) {
    if (spill) { const s = (await spill.getRow(id)) ?? (await spill.getAck(id)); if (s) return s; }
    return (await safe(store.getRow(id), undefined)) ?? (await safe(store.getAck(id), undefined));
  }

  async function enqueue(input) {
    if (closed) throw new Error('outbox: closed');
    if (!input || typeof input !== 'object' || Object.keys(input).join() !== 'receipt') throw new TypeError('outbox: enqueue takes only {receipt}');
    const { receipt } = input;
    if (!isReceipt(receipt)) throw new TypeError('outbox: not a receipt v1 line');
    const g = gen;
    const id = hex(await sha256(`${ownerId}|${receipt}`));
    const existing = await findRow(id);
    if (existing) return withLabel(existing);
    if ((await allQueue()).length >= MAX_QUEUE) throw new RangeError('outbox: queue full');
    const t = now();
    let row = { id, receipt, state: 'sealed_local', attempts: 0, created_at: t, updated_at: t };
    const env = await safe(store.getMeta('envelope'), null);
    if (usable(env)) row = await bind(row, env);
    if (g !== gen) throw new Error('outbox: closed');
    try {
      await store.putRow(row);
    } catch (err) {
      if (err instanceof TypeError) throw err;
      if (g !== gen) throw new Error('outbox: closed');
      spill ??= createMemoryStore();
      await spill.putRow(row);
      exportOffered = true;
    }
    if (g !== gen) throw new Error('outbox: closed');
    emit();
    kick();
    return withLabel(row);
  }

  async function list() {
    const byId = new Map();
    for (const r of await allQueue()) byId.set(r.id, r);
    for (const a of [...await safe(store.listAcks(), []), ...(spill ? await spill.listAcks() : [])]) byId.set(a.id, a);
    return [...byId.values()].sort(byCreated).map(withLabel);
  }

  async function retryNow(id) {
    if (closed) return;
    const g = gen;
    if (id !== undefined) {
      const row = await safe(storeOf(id).getRow(id), undefined);
      if (!row || g !== gen) return;
      if (row.state === 'needs_attention') {
        if (!RETRYABLE.has(row.reason)) return; // terminal
        const next = { ...row, state: 'sealed_local', reason: undefined, attempts: 0, next_attempt_at: undefined, updated_at: now() };
        if (ENVELOPE_REASONS.has(row.reason)) { // explicit: bind a new envelope and a new key
          const cached = await safe(store.getMeta('envelope'), null);
          if (g !== gen) return;
          if (cached?.envelope_id === row.envelope_id) await safe(store.deleteMeta('envelope'));
          if (g !== gen) return;
          for (const k of ['envelope_id', 'envelope_expires_at', 'envelope_epoch', 'idempotency_key']) delete next[k];
        }
        await save(next);
        if (g !== gen) return;
        emit();
      }
    }
    return kick(true);
  }

  async function exportPending() {
    const rows = (await list()).filter((r) => r.state !== 'registered');
    if (!rows.length) return { ok: false, reason: 'needs_previous_export' };
    return { ok: true, count: rows.length,
      text: JSON.stringify({ format: EXPORT_FORMAT, version: 1, receipts: rows.map((r) => r.receipt) }, null, 2) + '\n' };
  }

  // Re-queue receipt lines from an earlier exportPending() file. Registered receipts dedupe server-side.
  async function importProofs(text) {
    let doc;
    try { doc = JSON.parse(String(text)); } catch { doc = null; }
    if (doc?.format !== EXPORT_FORMAT || doc.version !== 1 || !Array.isArray(doc.receipts)) return { ok: false, reason: 'not_an_export' };
    let added = 0, existing = 0, rejected = 0;
    for (const line of doc.receipts) {
      if (!isReceipt(line)) { rejected += 1; continue; }
      const before = await findRow(hex(await sha256(`${ownerId}|${line}`)));
      if (before) { existing += 1; continue; }
      await enqueue({ receipt: line });
      added += 1;
    }
    return { ok: true, added, existing, rejected };
  }

  function close() {
    if (closed) return;
    closed = true;
    gen += 1;
    clearTimer();
    unsubscribe();
    inflight?.abort();
    inflight = null;
    listeners.clear();
    try { store.close(); } catch { /* already closed */ }
  }

  const unsubscribe = online.subscribe((isOn) => { emit(); if (isOn) kick(); });
  kick();

  return {
    enqueue, list, retryNow, exportPending, importProofs, close,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    status: () => ({ storage, exportOffered, needsSignIn }),
  };
}
