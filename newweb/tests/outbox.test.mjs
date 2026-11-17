import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRegistryClient } from '../src/registry-client.mjs';
import {
  openOutbox, createMemoryStore, ROW_FIELDS, STATES, backoffDelay, registrationLabel, stateLabel, attentionMessage, MAX_ATTEMPTS, MAX_ACKS, MAX_QUEUE,
} from '../src/outbox.mjs';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (org, sub, n = 0) => `${b64({ alg: 'HS256' })}.${b64({ sub, org_id: org, n })}.sig`;
const receipt = (n) => `fseal-receipt v1 count=${n} head=${'1'.repeat(64)} key=${'2'.repeat(64)} sig=${'3'.repeat(128)}`;
const sha = (s) => createHash('sha256').update(s).digest();
const OWNER = 'orgA/p1';
const tick = () => new Promise((r) => setImmediate(r));
// WebCrypto digests finish on the thread pool, so a fixed number of ticks is not enough on a slow machine:
// keep ticking while any outbox opened by a harness is mid-dispatch (capped, for tests that hold a request open).
const live = new Set();
const settle = async () => {
  const end = Date.now() + 1000;
  for (let i = 0; i < 20 || ([...live].some((o) => o.busy()) && Date.now() < end); i += 1) await tick();
};

// A stub registry: envelopes are minted in order; each registration takes the next scripted reply (default 201).
function harness({ token = jwt('orgA', 'p1'), online = true, store = createMemoryStore(), locks = null } = {}) {
  const h = { t: 1_800_000_000_000, calls: [], replies: [], envSeq: 0, epoch: 0, token, timers: [] };
  h.now = () => h.t;
  h.online = { on: online, isOnline() { return this.on; }, subscribe(cb) { this.cb = cb; return () => { this.cb = null; }; } };
  h.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const call = { path, method: init.method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : null };
    h.calls.push(call);
    if (path === '/v1/envelopes') {
      h.envSeq += 1;
      return Response.json({ envelope_id: h.envSeq.toString(16).padStart(32, '0'), expires_at: new Date(h.t + 7 * 864e5).toISOString(), epoch: h.epoch }, { status: 201 });
    }
    if (path === '/v1/epoch') return Response.json({ epoch: h.epoch });
    const reply = h.replies.shift() ?? [201, {}];
    const got = typeof reply === 'function' ? await reply(init, call) : reply;
    if (got instanceof Response) return got;
    const [status, body] = got;
    if (status === 'throw') throw new TypeError('network');
    const data = status < 300 ? { registration_id: 'r'.repeat(32), received_at: '2027-01-15T08:00:00Z', count: 1, head: 'h', key_fingerprint: 'f', disposition: 'active', ...body } : body;
    return Response.json(data, { status });
  };
  h.regs = () => h.calls.filter((c) => c.path === '/v1/registrations');
  h.open = async (extra = {}) => { const ob = await openOutbox({
    ownerId: OWNER, client: createRegistryClient({ baseUrl: 'http://reg', fetch: h.fetch }), getToken: async () => h.token,
    store, locks, now: h.now, random: () => 0.5, online: h.online,
    setTimeout: (fn, ms) => { h.timers.push({ fn, ms }); return h.timers.length; }, clearTimeout: () => {}, ...extra,
  }); live.add(ob); return ob; };
  h.store = store;
  return h;
}

test('constants and labels', () => {
  assert.deepEqual(STATES, ['sealed_local', 'registering', 'waiting_for_connection', 'registered', 'needs_attention']);
  assert.equal(ROW_FIELDS.length, 19);
  assert.equal(registrationLabel({ disposition: 'active' }), 'Registered');
  assert.equal(registrationLabel({ disposition: 'deleted' }), 'Registered, later deleted');
  assert.equal(stateLabel('waiting_for_connection'), 'Waiting for connection');
});

test('backoff: attempt n delay lies in [d/2, d], d = min(15 min, 2 s * 2^(n-1))', () => {
  for (let n = 1; n <= 12; n += 1) {
    const d = Math.min(900000, 2000 * 2 ** (n - 1));
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 1000; i += 1) { const v = backoffDelay(n); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    assert.ok(lo >= d / 2 && hi <= d, `n=${n}: ${lo}..${hi} outside [${d / 2}, ${d}]`);
  }
  assert.equal(backoffDelay(1, () => 0), 1000);
  assert.equal(backoffDelay(20, () => 1), 900000);
});

test('allowlist: unknown keys and ack fields on unacked rows throw; enqueue takes only a v1 receipt', async () => {
  const s = createMemoryStore();
  const row = { id: 'x', receipt: receipt(1), state: 'sealed_local', attempts: 0, created_at: 1, updated_at: 1 };
  await s.putRow(row);
  await assert.rejects(s.putRow({ ...row, name: 'flight.csv' }), /field not allowed: name/);
  await assert.rejects(s.putRow({ ...row, received_at: 'x' }), /ack field/);
  await assert.rejects(s.commitAck({ ...row, salt: 'x' }), /field not allowed/);
  const h = harness({ online: false });
  const ob = await h.open();
  await assert.rejects(ob.enqueue({ receipt: receipt(1), manifest: {} }), /only \{receipt\}/);
  await assert.rejects(ob.enqueue({ receipt: receipt(0) }), /not a receipt/);
  await assert.rejects(ob.enqueue({ receipt: receipt(1) + ' extra' }), /not a receipt/);
  await assert.rejects(ob.enqueue({ receipt: receipt(1).toUpperCase() }), /not a receipt/);
  ob.close();
});

test('enqueue offline with an unexpired cached envelope binds envelope and key; duplicates return the existing row', async () => {
  const h = harness();
  let ob = await h.open(); // online with an empty queue: prefetches one envelope
  await settle();
  ob.close();
  assert.equal(h.calls.filter((c) => c.path === '/v1/envelopes').length, 1);
  h.online.on = false;
  ob = await h.open();
  const row = await ob.enqueue({ receipt: receipt(1) });
  assert.equal(row.state, 'sealed_local');
  assert.equal(row.label, 'Sealed locally');
  assert.equal(row.id, sha(`${OWNER}|${receipt(1)}`).toString('hex'));
  assert.equal(row.envelope_id, '1'.padStart(32, '0'));
  assert.equal(row.idempotency_key, sha(`${OWNER}\n${receipt(1)}\n${row.envelope_id}`).toString('base64url'));
  assert.equal(row.idempotency_key.length, 43);
  const again = await ob.enqueue({ receipt: receipt(1) });
  assert.equal(again.id, row.id);
  assert.equal((await ob.list()).length, 1);
  assert.equal(h.regs().length, 0, 'nothing is sent offline');
  ob.close();
});

test('enqueue with no envelope: the first online dispatch binds one with its key, then registers', async () => {
  const h = harness({ online: false });
  const ob = await h.open();
  const row = await ob.enqueue({ receipt: receipt(1) });
  assert.equal(row.envelope_id, undefined);
  h.online.on = true;
  h.online.cb(true);
  await settle();
  const [reg] = h.regs();
  assert.equal(reg.auth, `Bearer ${h.token}`);
  assert.equal(reg.body.idempotency_key, sha(`${OWNER}\n${receipt(1)}\n${reg.body.envelope_id}`).toString('base64url'));
  const [listed] = await ob.list();
  assert.equal(listed.state, 'registered');
  assert.equal(listed.label, 'Registered');
  assert.equal(listed.received_at, '2027-01-15T08:00:00Z');
  assert.equal((await h.store.listQueue()).length, 0, 'the ack retired the queue row');
  ob.close();
});

test('200 disposition deleted is recorded as "Registered, later deleted"', async () => {
  const h = harness();
  h.replies.push([200, { disposition: 'deleted' }]);
  const ob = await h.open();
  await ob.enqueue({ receipt: receipt(1) });
  await ob.retryNow();
  const [r] = await ob.list();
  assert.equal(r.state, 'registered');
  assert.equal(r.disposition, 'deleted');
  assert.equal(r.label, 'Registered, later deleted');
  ob.close();
});

for (const [status, code, reason, retryable] of [
  [410, 'registration_deleted', 'registration_deleted', false],
  [409, 'idempotency_conflict', 'conflict', false],
  [422, 'bad_signature', 'bad_signature', false],
  [400, 'bad_receipt', 'bad_receipt', false],
  [413, 'body_too_large', 'body_too_large', false],
  [403, 'key_not_enrolled', 'key_not_enrolled', true],
  [403, 'key_not_active', 'key_not_active', true],
]) {
  test(`${status} ${code} -> needs_attention (${reason}); retryNow ${retryable ? 'retries' : 'ignores it'}`, async () => {
    const h = harness();
    h.replies.push([status, { error: code }]);
    const ob = await h.open();
    const row = await ob.enqueue({ receipt: receipt(1) });
    await ob.retryNow();
    let [r] = await ob.list();
    assert.equal(r.state, 'needs_attention');
    assert.equal(r.reason, reason);
    assert.equal(r.label, 'Needs attention');
    await ob.retryNow(row.id);
    assert.equal(h.regs().length, retryable ? 2 : 1);
    [r] = await ob.list();
    assert.equal(r.state, retryable ? 'registered' : 'needs_attention');
    if (retryable) assert.equal(h.regs()[1].body.idempotency_key, h.regs()[0].body.idempotency_key, 'same binding');
    ob.close();
  });
}

test('422 envelope_expired: retryNow(id) binds a new envelope and a new key', async () => {
  const h = harness({ online: false });
  h.replies.push([422, { error: 'envelope_expired' }]);
  const ob = await h.open();
  await settle(); // the open-time drain (offline: nothing sent)
  const row = await ob.enqueue({ receipt: receipt(1) });
  h.online.on = true;
  await ob.retryNow(); // binds envelope 1, gets 422; no prefetch may follow
  await settle();
  assert.equal((await ob.list())[0].reason, 'envelope_expired');
  assert.equal(h.envSeq, 1, 'no envelope minted after the 422');
  await ob.retryNow(); // without an id: not re-sent, and no replacement envelope minted
  await settle();
  assert.equal(h.regs().length, 1);
  assert.equal(h.envSeq, 1);
  const envelopesBefore = h.envSeq;
  await ob.retryNow(row.id);
  const [a, b] = h.regs();
  assert.notEqual(b.body.envelope_id, a.body.envelope_id);
  assert.notEqual(b.body.idempotency_key, a.body.idempotency_key);
  assert.equal(h.envSeq, envelopesBefore + 1);
  assert.equal((await ob.list())[0].state, 'registered');
  ob.close();
});

test('a locally expired envelope is not sent; it needs attention', async () => {
  const h = harness();
  const ob = await h.open();
  await settle(); // prefetch
  h.online.on = false;
  await ob.enqueue({ receipt: receipt(1) });
  h.t += 8 * 864e5;
  h.online.on = true;
  await ob.retryNow();
  assert.equal(h.regs().length, 0);
  const [r] = await ob.list();
  assert.equal(r.state, 'needs_attention');
  assert.equal(r.reason, 'envelope_expired');
  ob.close();
});

test('401: rows stay queued, needsSignIn, dispatch stops; a new matching token resumes', async () => {
  const h = harness({ online: false });
  h.replies.push([401, { error: 'unauthorized' }]);
  const ob = await h.open();
  await ob.enqueue({ receipt: receipt(1) });
  await ob.enqueue({ receipt: receipt(2) });
  await ob.retryNow();
  assert.equal(h.regs().length, 1, 'the second row is not tried after a 401');
  assert.equal(ob.status().needsSignIn, true);
  assert.deepEqual((await ob.list()).map((r) => r.state), ['sealed_local', 'sealed_local']);
  await ob.retryNow();
  assert.equal(h.regs().length, 1, 'the same rejected token is not reused');
  h.token = jwt('orgA', 'p1', 1);
  await ob.retryNow();
  assert.equal(ob.status().needsSignIn, false);
  assert.deepEqual((await ob.list()).map((r) => r.state), ['registered', 'registered']);
  ob.close();
});

test('owner mismatch: a token for another owner sends nothing and rows stay queued', async () => {
  const h = harness({ token: jwt('orgB', 'p1') });
  const ob = await h.open();
  await ob.enqueue({ receipt: receipt(1) });
  await ob.retryNow();
  h.token = jwt('orgA', 'p2');
  await ob.retryNow();
  assert.equal(h.calls.length, 0);
  assert.equal((await ob.list())[0].state, 'sealed_local');
  assert.equal(ob.status().needsSignIn, true);
  ob.close();
});

test('transient failures back off and give up after MAX_ATTEMPTS', async () => {
  const h = harness();
  const kinds = [[503, { error: 'unavailable' }], [429, { message: 'Too Many Requests' }], ['throw'],
    (init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('t', 'AbortError'))))];
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) h.replies.push(kinds[i % kinds.length]);
  const ob = await h.open({ client: createRegistryClient({ baseUrl: 'http://reg', fetch: h.fetch, timeoutMs: 10 }) });
  await ob.enqueue({ receipt: receipt(1) });
  await settle();
  for (let n = 1; n < MAX_ATTEMPTS; n += 1) {
    const [r] = await ob.list();
    assert.equal(r.state, 'waiting_for_connection', `attempt ${n}`);
    assert.equal(r.attempts, n);
    const d = Math.min(900000, 2000 * 2 ** (n - 1));
    assert.equal(r.next_attempt_at - h.t, d * 0.75);
    assert.equal(h.timers.at(-1).ms, d * 0.75, 'a timer is armed for the next attempt');
    h.t = r.next_attempt_at;
    await ob.retryNow();
  }
  const [r] = await ob.list();
  assert.equal(r.state, 'needs_attention');
  assert.equal(r.reason, 'attempts_exhausted');
  const keys = new Set(h.regs().map((c) => c.body.idempotency_key));
  assert.equal(keys.size, 1, 'every retry uses the same key');
  await ob.retryNow(r.id);
  assert.equal((await ob.list())[0].state, 'registered');
  ob.close();
});

test('IndexedDB open throws: memory store, exportOffered, exportPending has the line', async () => {
  const names = [];
  const h = harness({ online: false, store: undefined });
  const ob = await h.open({ store: undefined, indexedDB: { open(name) { names.push(name); throw new Error('denied'); } } });
  assert.deepEqual(names, [`hashwing-outbox-v1-${sha(OWNER).toString('hex')}`]);
  assert.deepEqual(ob.status(), { storage: 'memory', exportOffered: true, needsSignIn: false });
  await ob.enqueue({ receipt: receipt(7) });
  const out = await ob.exportPending();
  assert.equal(out.ok, true);
  assert.ok(JSON.parse(out.text).receipts.includes(receipt(7)));
  ob.close();
});

test('owner isolation: each owner has its own database name', async () => {
  const names = [];
  const idb = { open(name) { names.push(name); throw new Error('x'); } };
  for (const ownerId of ['orgA/p1', 'orgB/p1', 'orgA/p2']) {
    (await openOutbox({ ownerId, client: {}, getToken: async () => null, indexedDB: idb, online: { isOnline: () => false, subscribe: () => () => {} } })).close();
  }
  assert.equal(new Set(names).size, 3);
});

test('a failed enqueue put keeps the row in memory and offers export; empty export is refused', async () => {
  let failPut = true;
  const h = harness({ online: false, store: createMemoryStore({ fail: (op) => failPut && op === 'putRow' }) });
  const ob = await h.open();
  assert.deepEqual(await ob.exportPending(), { ok: false, reason: 'needs_previous_export' });
  await ob.enqueue({ receipt: receipt(3) });
  assert.equal(ob.status().exportOffered, true);
  assert.equal((await ob.list()).length, 1);
  const out = await ob.exportPending();
  assert.deepEqual(JSON.parse(out.text), { format: 'hashwing-outbox-export', version: 1, receipts: [receipt(3)] });
  failPut = false;
  h.online.on = true;
  await ob.retryNow();
  assert.equal((await ob.list())[0].state, 'registered');
  // the export file re-queues into a fresh outbox
  const h2 = harness({ online: false });
  const ob2 = await h2.open();
  const doc = JSON.parse(out.text);
  doc.receipts.push('garbage');
  assert.deepEqual(await ob2.importProofs(JSON.stringify(doc)), { ok: true, added: 1, existing: 0, rejected: 1 });
  assert.deepEqual(await ob2.importProofs('not json'), { ok: false, reason: 'not_an_export' });
  assert.equal((await ob2.list())[0].receipt, receipt(3));
  ob.close(); ob2.close();
});

test('a failed ack commit leaves the queue row; the next dispatch replays the same key', async () => {
  let failCommit = true;
  const h = harness({ store: createMemoryStore({ fail: (op) => failCommit && op === 'commitAck' }) });
  const ob = await h.open();
  await ob.enqueue({ receipt: receipt(1) });
  await ob.retryNow();
  const q = await h.store.listQueue();
  assert.equal(q.length, 1);
  assert.equal(q[0].state, 'registering');
  assert.equal(ob.status().exportOffered, true);
  failCommit = false;
  await ob.retryNow();
  const [a, b] = h.regs();
  assert.equal(b.body.idempotency_key, a.body.idempotency_key);
  assert.equal((await ob.list())[0].state, 'registered');
  ob.close();
});

test('a stale registering row is redispatched with the same key by the next lock holder', async () => {
  const store = createMemoryStore();
  await store.putRow({ id: 'a'.repeat(64), receipt: receipt(1), envelope_id: 'e'.repeat(32), envelope_expires_at: 1_800_000_000_000 + 864e5,
    envelope_epoch: 0, idempotency_key: 'K'.repeat(43), state: 'registering', attempts: 0, created_at: 1, updated_at: 1 });
  const held = new Set();
  const locks = { async request(name, opts, cb) { if (held.has(name)) return cb(null); held.add(name); try { return await cb({ name }); } finally { held.delete(name); } } };
  const h = harness({ store, locks });
  const ob = await h.open();
  await settle();
  assert.equal(h.regs()[0].body.idempotency_key, 'K'.repeat(43));
  assert.equal((await ob.list())[0].state, 'registered');
  ob.close();
});

test('a busy lock means this tab sends nothing', async () => {
  const locks = { request: async (_n, opts, cb) => { assert.equal(opts.ifAvailable, true); return cb(null); } };
  const h = harness({ locks });
  const ob = await h.open();
  await ob.enqueue({ receipt: receipt(1) });
  await ob.retryNow();
  assert.equal(h.calls.length, 0);
  ob.close();
});

test('close() aborts the in-flight request and drops its late result', async () => {
  const h = harness();
  let release;
  let aborted = false;
  h.replies.push((init) => { init.signal.addEventListener('abort', () => { aborted = true; }); return new Promise((r) => { release = r; }); });
  const ob = await h.open();
  await ob.enqueue({ receipt: receipt(1) });
  await settle();
  assert.equal(h.regs().length, 1);
  ob.close();
  assert.equal(aborted, true);
  release([201, {}]);
  await settle();
  const q = await h.store.listQueue();
  assert.equal(q.length, 1, 'no ack was recorded after close');
  assert.equal((await h.store.listAcks()).length, 0);
  assert.equal(h.calls.filter((c) => c.path !== '/v1/epoch').length, 2, 'no further requests (envelope + one registration)');
  await assert.rejects(ob.enqueue({ receipt: receipt(2) }), /closed/);
});

test('MAX_ACKS: committing past the cap prunes the oldest ack', async () => {
  const s = createMemoryStore();
  const ack = (i) => ({ id: `id${i}`, receipt: receipt(1), state: 'registered', created_at: i, updated_at: i, acked_at: i, registration_id: 'r', received_at: 'x', disposition: 'active' });
  for (let i = 0; i <= MAX_ACKS; i += 1) await s.commitAck(ack(i));
  const acks = await s.listAcks();
  assert.equal(acks.length, MAX_ACKS);
  assert.equal(acks.some((a) => a.id === 'id0'), false);
});

test('a 2xx whose body cannot be read, or is not JSON, is retried with the same key, not stranded', async () => {
  const h = harness();
  const broken = new ReadableStream({ pull(c) { c.error(new TypeError('connection reset')); } });
  h.replies.push(() => new Response(broken, { status: 201 }));
  h.replies.push(() => new Response('<html>portal</html>', { status: 200 }));
  const ob = await h.open();
  await ob.enqueue({ receipt: receipt(1) });
  await settle();
  let [r] = await ob.list();
  assert.equal(r.state, 'waiting_for_connection');
  assert.equal(r.reason, 'network');
  await ob.retryNow();
  [r] = await ob.list();
  assert.equal(r.state, 'waiting_for_connection');
  assert.equal(r.reason, 'bad_response');
  await ob.retryNow();
  assert.equal((await ob.list())[0].state, 'registered');
  assert.equal(new Set(h.regs().map((c) => c.body.idempotency_key)).size, 1);
  ob.close();
});

test('MAX_QUEUE: the 201st queued receipt is refused', async () => {
  const h = harness({ online: false });
  const ob = await h.open();
  for (let i = 1; i <= MAX_QUEUE; i += 1) await ob.enqueue({ receipt: receipt(i) });
  await assert.rejects(ob.enqueue({ receipt: receipt(MAX_QUEUE + 1) }), RangeError);
  assert.equal((await ob.list()).length, MAX_QUEUE);
  ob.close();
});

test('a failed ack commit schedules its own retry; firing the timer replays the same key', async () => {
  let failCommit = true;
  const h = harness({ store: createMemoryStore({ fail: (op) => failCommit && op === 'commitAck' }) });
  const ob = await h.open();
  await settle();
  await ob.enqueue({ receipt: receipt(1) });
  await settle();
  assert.equal((await h.store.listQueue())[0].state, 'registering');
  const timer = h.timers.at(-1);
  assert.ok(timer && timer.ms >= 1000 && timer.ms <= 2000, 'a retry is armed');
  failCommit = false;
  timer.fn();
  await settle();
  const [a, b] = h.regs();
  assert.equal(b.body.idempotency_key, a.body.idempotency_key);
  assert.equal((await ob.list())[0].state, 'registered');
  ob.close();
});

test('after a 401 a recheck timer picks up a new matching token without retryNow', async () => {
  const h = harness({ online: false });
  h.replies.push([401, { error: 'unauthorized' }]);
  const ob = await h.open();
  await ob.enqueue({ receipt: receipt(1) });
  h.online.on = true;
  await ob.retryNow();
  await settle();
  assert.equal(ob.status().needsSignIn, true);
  assert.equal(h.timers.at(-1).ms, 30000);
  h.token = jwt('orgA', 'p1', 2);
  h.timers.at(-1).fn();
  await settle();
  assert.equal(ob.status().needsSignIn, false);
  assert.equal((await ob.list())[0].state, 'registered');
  ob.close();
});

test('a 401 on the open-time envelope prefetch sets needsSignIn', async () => {
  const h = harness();
  h.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 });
  const ob = await h.open();
  await settle();
  assert.equal(ob.status().needsSignIn, true);
  ob.close();
});

for (const code of ['epoch_mismatch', 'sub_mismatch']) {
  test(`422 ${code}: needs attention, no silent new envelope; retryNow(id) binds a new envelope and key`, async () => {
    const h = harness({ online: false });
    h.replies.push([422, { error: code }]);
    const ob = await h.open();
    await settle();
    const row = await ob.enqueue({ receipt: receipt(1) });
    h.online.on = true;
    await ob.retryNow();
    await settle();
    const [r] = await ob.list();
    assert.equal(r.state, 'needs_attention');
    assert.equal(r.reason, code);
    assert.equal(h.envSeq, 1, 'no envelope minted after the 422');
    await ob.retryNow(row.id);
    const [a, b] = h.regs();
    assert.notEqual(b.body.envelope_id, a.body.envelope_id);
    assert.notEqual(b.body.idempotency_key, a.body.idempotency_key);
    assert.equal((await ob.list())[0].state, 'registered');
    ob.close();
  });
}

test('the open-time prefetch drops a cached envelope from an older epoch and binds a current one', async () => {
  const h = harness({ online: false });
  await h.store.putMeta('envelope', { envelope_id: 'e'.repeat(32), expires_at: h.t + 864e5, epoch: 0 });
  h.epoch = 2;
  h.online.on = true;
  const ob = await h.open();
  await settle();
  assert.ok(h.calls.some((c) => c.path === '/v1/epoch'));
  assert.equal(h.envSeq, 1, 'a fresh envelope replaced the stale one');
  h.online.on = false;
  const row = await ob.enqueue({ receipt: receipt(1) });
  assert.equal(row.envelope_epoch, 2);
  assert.notEqual(row.envelope_id, 'e'.repeat(32));
  ob.close();
});

test('the epoch is read before any dispatch: a row bound to an older epoch is not sent and needs attention', async () => {
  const h = harness({ online: false });
  await h.store.putMeta('envelope', { envelope_id: 'e'.repeat(32), expires_at: h.t + 864e5, epoch: 0 });
  const ob = await h.open();
  await settle();
  const stale = await ob.enqueue({ receipt: receipt(1) }); // bound offline to the cached epoch-0 envelope
  assert.equal(stale.envelope_epoch, 0);
  h.epoch = 3;
  h.online.on = true;
  await ob.retryNow();
  await settle();
  assert.equal(h.calls[0].path, '/v1/epoch', 'the epoch is read first');
  assert.equal(h.regs().length, 0, 'nothing is sent with a stale envelope');
  const [r] = await ob.list();
  assert.equal(r.state, 'needs_attention');
  assert.equal(r.reason, 'epoch_mismatch');
  await ob.retryNow(stale.id);
  assert.equal(h.regs().length, 1);
  assert.equal((await ob.list())[0].state, 'registered');
  ob.close();
});

test('a cached envelope with no epoch is treated as stale', async () => {
  const h = harness({ online: false });
  await h.store.putMeta('envelope', { envelope_id: 'e'.repeat(32), expires_at: h.t + 864e5 });
  h.online.on = true;
  const ob = await h.open();
  await settle();
  assert.equal(h.envSeq, 1);
  assert.notEqual((await h.store.getMeta('envelope')).envelope_id, 'e'.repeat(32));
  ob.close();
});

test('close() also aborts an in-flight epoch read', async () => {
  const h = harness();
  let aborted = false;
  const base = h.fetch;
  h.fetch = (url, init) => (new URL(url).pathname === '/v1/epoch'
    ? new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('a', 'AbortError')); }))
    : base(url, init));
  const ob = await h.open();
  await settle();
  ob.close();
  assert.equal(aborted, true);
});

test('429 quota_exceeded is terminal for the month: needs attention with a plain message, no automatic retry', async () => {
  const h = harness();
  h.replies.push([429, { error: 'quota_exceeded' }]);
  const ob = await h.open();
  const row = await ob.enqueue({ receipt: receipt(1) });
  await settle();
  let [r] = await ob.list();
  assert.equal(r.state, 'needs_attention');
  assert.equal(r.reason, 'quota_exceeded');
  assert.equal(r.next_attempt_at, undefined, 'no backoff timer for it');
  assert.equal(r.message, "Your company's monthly registration limit is reached; this proof is saved and can be exported");
  assert.equal(attentionMessage(r), r.message);
  assert.equal((await ob.exportPending()).ok, true, 'the proof can be exported');
  await ob.retryNow(); // a plain retry does not resend it
  await settle();
  assert.equal(h.regs().length, 1);
  await ob.retryNow(row.id); // an explicit retry (for example next month) may
  assert.equal(h.regs().length, 2);
  [r] = await ob.list();
  assert.equal(r.state, 'registered');
  ob.close();
});

test('a gateway throttle 429 (no registry error code) is retried later with the same key', async () => {
  const h = harness();
  h.replies.push([429, { message: 'Too Many Requests' }]);
  const ob = await h.open();
  await ob.enqueue({ receipt: receipt(1) });
  await settle();
  const [r] = await ob.list();
  assert.equal(r.state, 'waiting_for_connection');
  assert.ok(r.next_attempt_at > h.t);
  ob.close();
});
