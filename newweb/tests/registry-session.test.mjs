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
globalThis.fetch = async () => { throw new TypeError('offline in this test'); };
globalThis.__REGISTRY_URL__ = URL_;
// One process is one "tab": a fake channel records what this tab posts and lets a test deliver another tab's message.
const channels = [];
globalThis.BroadcastChannel = class { constructor(name) { this.name = name; this.posted = []; this.listeners = []; channels.push(this); }
  postMessage(data) { this.posted.push(structuredClone(data)); } addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
  deliver(data) { for (const fn of this.listeners) fn({ data }); } };

const vite = await createServer({ root: ROOT, configFile: false, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false }, define: { __REGISTRY_URL__: JSON.stringify(URL_) } });
after(() => vite.close());
const { RegistryBoundary, getRegistry, registryTimeField } = await vite.ssrLoadModule('/src/registry-ui.jsx');

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
  assert.deepEqual(registryTimeField({ ...base, outbox: null, listed: false }, lines), notYet);
  assert.deepEqual(registryTimeField({ ...base, listed: false }, lines), notYet);
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
