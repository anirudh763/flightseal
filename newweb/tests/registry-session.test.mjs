// The console's registry session store (registry-ui.jsx getRegistry) in Node: sign-in, sign-out and logout races.
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
globalThis.removeEventListener ??= () => {};
globalThis.fetch = async () => { throw new TypeError('offline in this test'); };
globalThis.__REGISTRY_URL__ = URL_;
delete globalThis.BroadcastChannel; // one process, one "tab"; the cross-tab path has its own browser check

const vite = await createServer({ root: ROOT, configFile: false, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false }, define: { __REGISTRY_URL__: JSON.stringify(URL_) } });
after(() => vite.close());
const { getRegistry } = await vite.ssrLoadModule('/src/registry-ui.jsx');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenFor = (sub) => `${b64({ alg: 'none' })}.${b64({ org_id: 'orgA', sub, role: 'pilot' })}.sig`;
const hex = (n, c) => c.repeat(n);
const receipt = (count) => `fseal-receipt v1 count=${count} head=${hex(64, 'a')} key=${hex(64, 'b')} sig=${hex(128, 'c')}`;

test('logout during the sign-in flush does not put the previous user\'s proofs back', async () => {
  const r = getRegistry();
  await r.sealed(receipt(1), 'one.ulg'); // signed out: kept in the in-memory list
  assert.equal(r.snapshot().pending.length, 1);
  let done = false;
  const off = r.subscribe(() => { if (!done && r.snapshot().outbox) { done = true; r.logout(); } }); // the outbox just opened
  await r.signIn(tokenFor('u1'));
  off();
  assert.ok(done);
  assert.deepEqual(r.snapshot().pending, []);
  assert.equal(r.snapshot().outbox, null);
});

test('logout while a seal is being saved drops it instead of keeping it for the next user', async () => {
  const r = getRegistry();
  assert.ok(await r.signIn(tokenFor('u2')));
  const saving = r.sealed(receipt(2), 'two.ulg');
  r.logout();
  await saving;
  assert.deepEqual(r.snapshot().pending, []);
  assert.equal(r.names.size, 0);
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
