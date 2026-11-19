// The console's registry session store (registry-ui.jsx getRegistry) in Node: sign-in, sign-out and logout races,
// the cross-tab messages, the Verify time row and the panels' error boundary.
// Vite loads the JSX module with the registry flag on; the outbox falls back to its in-memory store (no IndexedDB)
// and every registry request fails as a network error, so nothing leaves the process.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = 'http://127.0.0.1:9';
const store = new Map();
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.addEventListener ??= () => {};
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.removeEventListener ??= () => {};
// The registry client keeps the fetch it was created with, so swap the handler behind it rather than globalThis.fetch.
const offlineFetch = async () => { throw new TypeError('offline in this test'); };
let fetchHandler = offlineFetch;
globalThis.fetch = (...args) => fetchHandler(...args);
globalThis.__REGISTRY_URL__ = URL_;
// One process is one "tab": a fake channel records what this tab posts and lets a test deliver another tab's message.
const channels = [];
globalThis.BroadcastChannel = class { constructor(name) { this.name = name; this.posted = []; this.listeners = []; channels.push(this); }
  postMessage(data) { this.posted.push(structuredClone(data)); } addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
  deliver(data) { for (const fn of this.listeners) fn({ data }); } };

const vite = await createServer({ root: ROOT, configFile: false, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false }, define: { __REGISTRY_URL__: JSON.stringify(URL_) } });
after(() => vite.close());
const { RegistryBoundary, getRegistry, jobStatus, jobsStatusMap, registryLine, registryTimeField } = await vite.ssrLoadModule('/src/registry-ui.jsx');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenFor = (sub) => `${b64({ alg: 'none' })}.${b64({ org_id: 'orgA', sub, role: 'pilot' })}.sig`;
const hex = (n, c) => c.repeat(n);
const receipt = (count) => `fseal-receipt v1 count=${count} head=${hex(64, 'a')} key=${hex(64, 'b')} sig=${hex(128, 'c')}`;

test('a proof sealed while signed out stays unassigned after sign-in, and is sent only when assigned', async () => {
  const r = getRegistry();
  await r.setScope('guest');
  await r.sealed(receipt(1), 'one.ulg'); // signed out: unassigned local work
  assert.deepEqual(r.snapshot().pending.map((p) => [p.receipt, p.owner]), [[receipt(1), null]]);
  assert.ok(await r.signIn(tokenFor('u1')));
  assert.deepEqual(r.snapshot().pending.map((p) => p.owner), [null], 'never sent by itself under whoever signs in');
  assert.ok(!(await r.snapshot().outbox.list()).some((row) => row.receipt === receipt(1)));
  assert.equal(await r.assign(receipt(1)), true);
  assert.deepEqual(r.snapshot().pending, []);
  assert.ok((await r.snapshot().outbox.list()).some((row) => row.receipt === receipt(1)));
  r.logout();
});

test('logout clears the sign-in and file names but keeps the profile\'s saved pending proofs', async () => {
  const r = getRegistry();
  await r.sealed(receipt(2), 'two.ulg');
  assert.ok(await r.signIn(tokenFor('u2')));
  r.logout();
  assert.equal(r.snapshot().owner, null);
  assert.equal(r.snapshot().token, '');
  assert.equal(r.names.size, 0);
  assert.deepEqual(r.snapshot().pending.map((p) => p.receipt), [receipt(2)], 'sign-out never deletes saved pending proofs');
  await r.setScope('profile:other'); // another local profile never sees them
  assert.deepEqual(r.snapshot().pending, []);
  await r.setScope('guest');
});

test('signing out and in as another owner forgets the previous owner\'s file names', async () => {
  const r = getRegistry();
  assert.ok(await r.signIn(tokenFor('u3')));
  await r.sealed(receipt(3), 'secret-flight.ulg');
  assert.equal(r.names.get(receipt(3)), 'secret-flight.ulg');
  r.signOut();
  assert.ok(await r.signIn(tokenFor('u4')));
  assert.ok(![...r.names.values()].includes('secret-flight.ulg'));
  r.logout();
});

test('sign-out tells the other tabs which owner left and when, never the token; an app logout stays in this tab', async () => {
  const r = getRegistry();
  const [channel] = channels;
  assert.equal(channel?.name, 'hashwing-registry');
  const tok = tokenFor('u5');
  assert.ok(await r.signIn(tok));
  channel.posted.length = 0;
  r.signOut();
  r.logout();
  assert.deepEqual(channel.posted.map(({ type, owner }) => ({ type, owner })), [{ type: 'signout', owner: 'orgA/u5' }], 'the profile logout message (local-auth) reaches only that profile\'s tabs');
  assert.ok(Number.isFinite(channel.posted[0].at));
  assert.ok(!JSON.stringify(channel.posted).includes(tok.split('.')[1]));
});

test('another tab\'s messages: this owner\'s sign-out signs out; another owner\'s, a delayed one from before this sign-in, and an old every-tab logout are ignored', async () => {
  const r = getRegistry();
  const [channel] = channels;
  const before = Date.now() - 1;
  assert.ok(await r.signIn(tokenFor('u6')));
  channel.deliver({ type: 'signout', owner: 'orgA/someone-else', at: Date.now() });
  assert.equal(r.snapshot().owner, 'orgA/u6');
  channel.deliver({ type: 'signout', owner: 'orgA/u6', at: before }); // delayed: sent before this sign-in began
  assert.equal(r.snapshot().owner, 'orgA/u6');
  channel.deliver({ type: 'signout', owner: 'orgA/u6', at: Date.now() + 1 });
  assert.equal(r.snapshot().owner, null);
  assert.equal(r.snapshot().token, '');
  assert.equal(sessionStorage.getItem('hashwing-registry-token'), null);
  assert.ok(await r.signIn(tokenFor('u7')));
  channel.posted.length = 0;
  channel.deliver({ type: 'logout' }); // sent by older tabs on any sign-in, switch or demo start: never wipes this tab
  assert.equal(r.snapshot().owner, 'orgA/u7');
  assert.deepEqual(channel.posted, [], 'a received message is not sent on again');
  r.logout();
});

test('an unsent proof keeps the registry owner it was sealed under and is never sent under another owner', async () => {
  const r = getRegistry();
  await r.setScope('profile:full');
  assert.ok(await r.signIn(tokenFor('u8')));
  for (let i = 0; i < 200; i++) await r.sealed(receipt(1000 + i)); // fill this owner's queue
  const held = receipt(2000);
  await r.sealed(held, 'held-flight.ulg'); // queue full: kept, tagged orgA/u8
  assert.deepEqual(r.snapshot().pending.map((p) => [p.receipt, p.owner]), [[held, 'orgA/u8']]);
  r.signOut();
  assert.ok(await r.signIn(tokenFor('u9')));
  assert.deepEqual(r.snapshot().pending.map((p) => p.owner), ['orgA/u8'], 'held, not queued under orgA/u9');
  assert.equal(await r.assign(held), false, 'only unassigned proofs can be assigned');
  assert.ok(!(await r.snapshot().outbox.list()).some((row) => row.receipt === held));
  assert.equal(r.names.has(held), false, 'another owner never sees its file name');
  const out = await r.exportPending();
  assert.ok(out.ok && JSON.parse(out.text).receipts.includes(held), 'it can still be exported');
  r.logout();
  await r.setScope('guest');
});

test('without IndexedDB the pending list is memory only and counts as unsaved until exported', async () => {
  const r = getRegistry();
  await r.sealed(receipt(3000), 'memory.ulg');
  assert.equal(r.snapshot().pendingStorage, 'memory');
  assert.ok(r.unsavedCount() >= 1);
  const out = r.unsentExport();
  assert.ok(out && JSON.parse(out.text).receipts.includes(receipt(3000)));
  out.markSaved();
  assert.equal(r.unsavedCount(), 0);
});

test('Assign binds the proof to this owner before sending, so it can never be assigned to another company', async () => {
  const r = getRegistry();
  await r.sealed(receipt(4000), 'bind.ulg'); // signed out: unassigned
  assert.ok(await r.signIn(tokenFor('b1')));
  const sending = r.assign(receipt(4000));
  assert.deepEqual(r.snapshot().pending.filter((p) => p.receipt === receipt(4000)).map((p) => p.owner), ['orgA/b1'], 'bound at once, before the outbox answers');
  assert.equal(await sending, true);
  r.signOut();
  assert.ok(await r.signIn(tokenFor('b2')));
  assert.equal(await r.assign(receipt(4000)), false, 'a second company never gets it');
  r.logout();
});

test('a seal started signed out (or as another owner) and finished after a sign-in is not sent under the new owner', async () => {
  const r = getRegistry();
  const start = r.sealStart(); // signed out when sealing began
  assert.ok(await r.signIn(tokenFor('s1')));
  await r.sealed(receipt(4100), 'long.ulg', start);
  assert.deepEqual(r.snapshot().pending.filter((p) => p.receipt === receipt(4100)).map((p) => p.owner), [null], 'unassigned, waiting for Assign');
  assert.ok(!(await r.snapshot().outbox.list()).some((row) => row.receipt === receipt(4100)));
  const asS1 = r.sealStart();
  r.signOut();
  assert.ok(await r.signIn(tokenFor('s2')));
  await r.sealed(receipt(4101), 'other.ulg', asS1);
  assert.deepEqual(r.snapshot().pending.filter((p) => p.receipt === receipt(4101)).map((p) => p.owner), ['orgA/s1'], 'held for the owner it began under');
  assert.equal(r.names.has(receipt(4101)), false, 'and its name is hidden from the new owner');
  r.logout();
});

test('the pending store refuses a full store and an owner it cannot name, and a failed save is kept in memory and offered for export', async () => {
  const { openPendingStore, MAX_PENDING } = await vite.ssrLoadModule('/src/pending-store.mjs');
  const mem = await openPendingStore('x', { indexedDB: null });
  assert.equal(mem.storage, 'memory');
  await mem.put({ receipt: receipt(1), owner: 'org/with/slash/sub', at: 1 }); // org ids may contain "/"
  await assert.rejects(mem.put({ receipt: receipt(2), owner: 'no-slash', at: 1 }), TypeError);
  for (let i = 3; mem && (await mem.list()).length < MAX_PENDING; i++) await mem.put({ receipt: receipt(i), owner: null, at: 1 });
  await assert.rejects(mem.put({ receipt: receipt(9999), owner: null, at: 1 }), RangeError);
  // A browser store whose writes fail (storage full or denied): the proof stays listed, memory only, and counts as unsaved.
  const quota = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
  const later = (fn) => setTimeout(fn, 0);
  const fakeIdb = { open() {
    const req = {};
    later(() => {
      const db = { close() {}, createObjectStore() {}, transaction(_names, mode) {
        const tx = {};
        const reqOf = (result) => { const q = { result }; later(() => q.onsuccess?.()); return q; };
        const s = { transaction: tx, getAll: () => reqOf([]), count: () => reqOf(0), getKey: () => reqOf(undefined), put() { tx.failed = true; }, delete() {} };
        tx.objectStore = () => s; tx.abort = () => {};
        later(() => later(() => later(() => (mode === 'readwrite' && tx.failed ? (tx.error = quota, tx.onerror?.()) : tx.oncomplete?.()))));
        return tx;
      } };
      req.result = db; req.onsuccess?.();
    });
    return req;
  } };
  const r = getRegistry();
  globalThis.indexedDB = fakeIdb;
  try {
    await r.setScope('profile:quota');
    assert.equal(r.snapshot().pendingStorage, 'indexeddb');
    const before = r.unsavedCount();
    await r.sealed(receipt(6000), 'quota.ulg');
    const row = r.snapshot().pending.find((p) => p.receipt === receipt(6000));
    assert.equal(row?.memoryOnly, true);
    assert.equal(r.unsavedCount(), before + 1, 'counts as unsaved, so reload warns and logout waits for a download');
    assert.match(r.snapshot().enqueueError, /Export pending proofs/);
    assert.ok(JSON.parse(r.unsentExport().text).receipts.includes(receipt(6000)));
  } finally { delete globalThis.indexedDB; await r.setScope('guest'); }
});

test('the Verify time row for each state of this device\'s outbox row', () => {
  const R = receipt(9), lines = `${R}\n`;
  const base = { owner: 'orgA/u', outbox: {}, listed: true, rows: [], pending: [], online: true };
  const row = (extra) => ({ ...base, rows: [{ id: 'x', receipt: R, label: 'Registered', ...extra }] });
  const basis = "the registry's clock; the registry's statement, not proof of the files";
  const notYet = { value: 'Not available yet', basis: "this device's registry list isn't open yet" };
  assert.equal(registryTimeField(base, ''), null);
  assert.deepEqual(registryTimeField(row({ state: 'registered', disposition: 'active', received_at: '2026-11-17T10:00:05Z' }), lines), { value: 'Registered at 2026-11-17T10:00:05Z', basis });
  assert.deepEqual(registryTimeField(row({ state: 'registered', disposition: 'deleted', received_at: '2026-11-17T10:00:05Z' }), lines), { value: 'Registered, later deleted', basis: "the registry's statement, not proof of the files; its hosted record was deleted" });
  assert.deepEqual(registryTimeField(row({ state: 'needs_attention', reason: 'quota_exceeded', label: 'Needs attention' }), lines), { value: 'Needs attention', basis: "Your company's monthly registration limit is reached; this proof is saved and can be exported" });
  assert.equal(registryTimeField(row({ state: 'needs_attention', reason: 'key_not_enrolled', label: 'Needs attention' }), lines).basis, "This signing key isn't enrolled for your company yet. Ask your company's registry admin to enroll this key's fingerprint, then try again.");
  assert.equal(registryTimeField(row({ state: 'needs_attention', reason: 'made_up', label: 'Needs attention' }), lines).basis, "The registry couldn't accept this receipt. Export it and contact your admin.");
  assert.deepEqual(registryTimeField(row({ state: 'registering', label: 'Registering' }), lines), { value: 'Not yet registered', basis: "this device's list: Registering" });
  assert.deepEqual(registryTimeField({ ...row({ state: 'sealed_local', label: 'Sealed locally' }), online: false }, lines), { value: 'Not yet registered', basis: "this device's list: Waiting for connection" });
  assert.deepEqual(registryTimeField({ ...base, owner: null, outbox: null, pending: [{ receipt: R }] }, lines), { value: 'Not yet registered', basis: "this device's list: Sealed locally" });
  assert.deepEqual(registryTimeField(base, lines), { value: 'No registry record on this device', basis: 'this device has no registry record for this receipt' });
  assert.deepEqual(registryTimeField({ ...base, owner: null, outbox: null }, lines), { value: 'Not signed in', basis: "sign in to the company registry to see this device's record" });
  // A client who opened a share link has no account and needs none: said calmly, never as "Not signed in".
  assert.deepEqual(registryTimeField({ ...base, owner: null, outbox: null }, lines, { fromLink: true }), { value: 'No account needed', basis: "not needed to check files from a share link" });
  assert.deepEqual(registryTimeField(row({ state: 'registering', label: 'Registering' }), lines, { fromLink: true }), { value: 'Not yet registered', basis: "this device's list: Registering" }, 'a signed-in sender keeps their own record');
  assert.deepEqual(registryTimeField({ ...base, outbox: null, listed: false }, lines), notYet);
  assert.deepEqual(registryTimeField({ ...base, listed: false }, lines), notYet);
});

test('Jobs status for each outbox state, pending proofs and no record, matched on the receipt line sent to the registry', () => {
  const R = receipt(19), msg = `HashWing receipt for x\nPublic key: ${hex(64, 'b')}\n${R}\n\nKeep this message.`;
  const base = { owner: 'orgA/u', outbox: {}, listed: true, rows: [], pending: [], online: true };
  const of = (s) => jobStatus(jobsStatusMap(s), msg);
  const row = (extra) => ({ ...base, rows: [{ id: 'x', receipt: R, updated_at: 5, ...extra }] });
  assert.deepEqual(of(row({ state: 'registered', disposition: 'active', label: 'Registered', received_at: '2026-11-17T10:00:05Z' })),
    { label: 'Registered', kind: 'ok', group: 'registered', line: "Registered at 2026-11-17 10:00:05 UTC. This is the registry's statement, not proof of the files.", at: null });
  const deleted = of(row({ state: 'registered', disposition: 'deleted', label: 'Registered, later deleted' }));
  assert.deepEqual([deleted.label, deleted.kind, deleted.group], ['Registered, later deleted', 'neutral', 'registered']);
  const attention = of(row({ state: 'needs_attention', reason: 'key_not_enrolled', label: 'Needs attention' }));
  assert.deepEqual([attention.kind, attention.group], ['warn', 'problems']);
  assert.match(attention.line, /^This signing key isn't enrolled/);
  assert.deepEqual([of(row({ state: 'registering', label: 'Registering' })).kind, of(row({ state: 'registering', label: 'Registering' })).group], ['neutral', 'waiting']);
  const off = of({ ...row({ state: 'sealed_local', label: 'Sealed locally' }), online: false });
  assert.deepEqual([off.label, off.group], ['Waiting for connection', 'waiting'], 'offline, a new row waits for the connection');
  const pending = (p, owner = 'orgA/u') => of({ ...base, owner, pending: [{ receipt: R, at: 7, ...p }] });
  assert.deepEqual([pending({ owner: null }).label, pending({ owner: null }).group, pending({ owner: null }).at], ['Sealed locally', 'waiting', 7]);
  assert.match(pending({ owner: null }).line, /isn't assigned to a company yet/);
  assert.match(pending({ owner: 'orgA/other' }).line, /another registry sign-in/, 'held under another owner');
  assert.equal(of({ ...row({ state: 'registered', label: 'Registered' }), pending: [{ receipt: R, owner: null }] }).label, 'Registered', 'an outbox row wins over a pending one');
  const none = of(base);
  assert.deepEqual([none.label, none.group, none.at], ['Sealed locally', null, null]);
  assert.match(none.line, /no registry record for this job under the current sign-in/);
  assert.match(of({ ...base, owner: null, outbox: null }).line, /^Sign in to the company registry/, 'signed out: never a stale Registered');
  assert.match(of({ ...base, listed: false }).line, /isn't open yet/);
});

test('a multi-line receipt message matches only the line the registry got (registryLine, shared with registrySealed)', () => {
  const first = receipt(100), last = receipt(200);
  const msg = `HashWing receipt for x\nPublic key: ${hex(64, 'b')}\n${first}\n${last}\n\nKeep this message.\nTo check the file, open x and paste this whole message.\n`;
  assert.equal(registryLine(msg), last, 'the last receipt line, never the trailing prose');
  assert.equal(registryLine(`${first}\n${last}\n`), last, 'a bare receipts file picks the same line');
  const base = { owner: 'orgA/u', outbox: {}, listed: true, rows: [], pending: [], online: true };
  const of = (r) => jobStatus(jobsStatusMap({ ...base, rows: [{ id: 'x', receipt: r, state: 'registered', disposition: 'active', label: 'Registered', received_at: '2026-11-17T10:00:05Z' }] }), msg);
  assert.equal(of(last).label, 'Registered');
  assert.deepEqual([of(first).label, of(first).group], ['Sealed locally', null], 'a record for an earlier line is not this job');
});

test('a registry panel that throws while rendering shows one notice instead of blanking the app', () => {
  assert.deepEqual(RegistryBoundary.getDerivedStateFromError(new Error('bad record')), { failed: true });
  const boundary = new RegistryBoundary({ children: 'panel' });
  assert.equal(boundary.render(), 'panel');
  boundary.state = { failed: true };
  const notice = boundary.render();
  assert.equal(notice.props.role, 'alert');
  assert.match(notice.props.children, /couldn't be shown\. Sealing and checking still work/);
});

test('a proof held because the queue was full is sent when the queue gains room', async () => {
  const r = getRegistry();
  await r.setScope('profile:room');
  assert.ok(await r.signIn(tokenFor('room1')));
  for (let i = 0; i < 200; i++) await r.sealed(receipt(5000 + i)); // fill this owner's queue (offline: nothing sent)
  const held = receipt(6000);
  await r.sealed(held, 'room-flight.ulg'); // queue full: held
  assert.deepEqual(r.snapshot().pending.map((p) => p.receipt), [held]);
  let n = 0;
  fetchHandler = async (url) => { // a registry that acks everything
    const path = new globalThis.URL(url).pathname;
    if (path === '/v1/epoch') return Response.json({ epoch: 0 });
    if (path === '/v1/envelopes') return Response.json({ envelope_id: 'e'.repeat(32), expires_at: new Date(Date.now() + 864e5).toISOString(), epoch: 0 }, { status: 201 });
    n += 1;
    return Response.json({ registration_id: n.toString(16).padStart(32, '0'), received_at: new Date().toISOString(), count: 1, head: 'h', key_fingerprint: 'f', disposition: 'active' }, { status: 201 });
  };
  try {
    await r.snapshot().outbox.retryNow();
    const end = Date.now() + 15000;
    while (Date.now() < end && (r.snapshot().pending.length || !(await r.snapshot().outbox.list()).some((row) => row.receipt === held))) await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(r.snapshot().pending, [], 'nothing is held any more');
    assert.ok((await r.snapshot().outbox.list()).some((row) => row.receipt === held), 'the held proof is in the outbox');
  } finally {
    fetchHandler = offlineFetch;
    r.logout();
    await r.setScope('guest');
  }
});
