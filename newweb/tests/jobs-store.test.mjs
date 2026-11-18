// jobs-store: field allow-list, scope isolation, memory fallback and the cap. The IndexedDB path itself runs in
// Chromium in newweb/tests/jobs.mjs (Node has no IndexedDB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_JOBS, checkJob, jobsDbName, openJobsStore } from '../src/jobs-store.mjs';

const RECEIPT = 'HashWing receipt\nfseal-receipt v1\ncount=1 head=00 sig=00\n';
const job = (over = {}) => ({ id: 'j1', jobRef: 'J-1042', name: 'flight-12.ulg.fseal', mode: 'small', items: 1, bytes: 1234, receipt: RECEIPT, sealedAt: 1_763_000_000_000, ...over });

test('a row keeps only the allowed fields; bytes, keys, tokens and names lists are refused', () => {
  assert.deepEqual(Object.keys(checkJob(job())), ['id', 'jobRef', 'name', 'mode', 'items', 'bytes', 'receipt', 'sealedAt']);
  for (const extra of [{ log: new Uint8Array(4) }, { privateKeyPem: 'x' }, { token: 'x' }, { names: ['a.mp4'] }, { publicKey: 'x' }]) assert.throws(() => checkJob(job(extra)), /bad row/, Object.keys(extra)[0]);
  for (const bad of [{ mode: 'medium' }, { items: -1 }, { bytes: 1.5 }, { name: '' }, { receipt: 'not a receipt' }, { receipt: `fseal-receipt v1${'x'.repeat(70_000)}` }, { sealedAt: NaN }, { jobRef: undefined }]) assert.throws(() => checkJob(job(bad)), /bad row/, JSON.stringify(bad).slice(0, 40));
});

test('no IndexedDB, or one that refuses to open: the store runs in memory and says so', async () => {
  const none = await openJobsStore('guest-a', { indexedDB: null });
  assert.equal(none.storage, 'memory');
  await none.put(job());
  assert.deepEqual((await none.list()).map((r) => r.id), ['j1']);
  const names = [];
  const refused = await openJobsStore('guest-b', { indexedDB: { open(name) { names.push(name); throw new Error('denied'); } } });
  assert.equal(refused.storage, 'memory');
  assert.match(names[0], /^hashwing-jobs-v1-[0-9a-f]{64}$/);
});

test('scopes are isolated: one database name per scope, never the pending store\'s, and memory rows stay per scope', async () => {
  const a = await jobsDbName('profile:a'), b = await jobsDbName('profile:b');
  assert.notEqual(a, b);
  assert.ok(!a.includes('hashwing-pending') && !a.includes('outbox'));
  const sa = await openJobsStore('profile:a', { indexedDB: null });
  const sb = await openJobsStore('profile:b', { indexedDB: null });
  await sa.put(job({ id: 'only-a' }));
  assert.deepEqual(await sb.list(), []);
  const again = await openJobsStore('profile:a', { indexedDB: null }); // back to A in the same tab: still there
  assert.deepEqual((await again.list()).map((r) => r.id), ['only-a']);
  await again.remove('only-a');
  assert.deepEqual(await sa.list(), []);
});

test(`the cap: ${MAX_JOBS} jobs per scope; a full store refuses a new job but still updates an existing one`, async () => {
  const s = await openJobsStore('cap', { indexedDB: null });
  for (let i = 0; i < MAX_JOBS; i++) await s.put(job({ id: `j${i}`, sealedAt: i }));
  await assert.rejects(s.put(job({ id: 'one-more' })), RangeError);
  await s.put(job({ id: 'j0', jobRef: 'renamed', sealedAt: 0 }));
  const rows = await s.list();
  assert.equal(rows.length, MAX_JOBS);
  assert.equal(rows[0].id, `j${MAX_JOBS - 1}`, 'newest first');
  assert.equal(rows.at(-1).jobRef, 'renamed');
});
