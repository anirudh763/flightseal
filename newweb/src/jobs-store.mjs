// Jobs: a local record of each sealing, for the Jobs page and "Sealed on this device". One IndexedDB database per local
// scope (`profile:<id>` or `guest`, the same value the registry's pending store gets), so another profile never sees
// them and a logout never deletes them. A row holds only the fields below: never file bytes, a key or a token.
// Without IndexedDB the store runs in memory for this tab and says so (storage: 'memory').
// Deliberately imports nothing from the registry code: this module ships in the flag-off (Pages) bundle.

/** At most this many jobs per scope. A full store refuses a new job (RangeError) rather than drop an old one, because
 * the page promises a job is "kept until you remove it". */
export const MAX_JOBS = 1000;
export const MAX_RECEIPT_CHARS = 64 * 1024; // a receipt message is a few KiB; anything longer is not one of ours
const FIELDS = ['id', 'jobRef', 'name', 'mode', 'items', 'bytes', 'receipt', 'sealedAt'];
const text = (v, max) => typeof v === 'string' && v.length <= max;
const count = (v) => Number.isSafeInteger(v) && v >= 0;

export function checkJob(row) {
  if (!row || typeof row !== 'object' || Object.keys(row).some((k) => !FIELDS.includes(k))
    || !text(row.id, 100) || !row.id || !text(row.jobRef, 200) || !text(row.name, 500) || !row.name
    || !['small', 'large'].includes(row.mode) || !count(row.items) || !count(row.bytes)
    || !text(row.receipt, MAX_RECEIPT_CHARS) || !row.receipt.includes('fseal-receipt v1') || !Number.isFinite(row.sealedAt)) throw new TypeError('jobs-store: bad row');
  return Object.fromEntries(FIELDS.map((k) => [k, row[k]])); // a fresh object in a fixed field order
}

async function sha256hex(value) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const jobsDbName = async (scope) => `hashwing-jobs-v1-${await sha256hex(scope)}`;
const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('aborted')); });
// Reading back: only rows that pass the same check as a write, projected to the allowed fields. Anything else in the
// database (another page on this origin, an old version, a hand edit) is skipped rather than allowed to break the page.
const valid = (rows) => rows.flatMap((r) => { try { return [checkJob(r)]; } catch { return []; } });
const newest = (rows) => valid(rows).sort((a, b) => b.sealedAt - a.sealedAt);

const memory = new Map(); // scope -> rows: this tab only, so switching profiles and back keeps them until the tab closes
function memoryStore(scope) {
  if (!memory.has(scope)) memory.set(scope, new Map());
  const rows = memory.get(scope);
  return {
    storage: 'memory',
    async list() { return newest([...rows.values()]); },
    async put(row) { const clean = checkJob(row); if (!rows.has(clean.id) && rows.size >= MAX_JOBS) throw new RangeError('jobs-store: full'); rows.set(clean.id, clean); },
    async remove(id) { rows.delete(id); },
    close() {},
  };
}

/** Open the jobs of one local scope. Never throws for a missing or blocked IndexedDB: falls back to memory. */
export async function openJobsStore(scope, { indexedDB = globalThis.indexedDB } = {}) {
  if (typeof scope !== 'string' || !scope) throw new TypeError('jobs-store: scope required');
  try {
    if (!indexedDB) throw new Error('no indexedDB');
    const name = await jobsDbName(scope);
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('jobs', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('blocked'));
    });
    const run = async (mode, fn) => { const tx = db.transaction(['jobs'], mode); const req = fn(tx.objectStore('jobs')); await done(tx); return req?.result; };
    return {
      storage: 'indexeddb',
      list: async () => newest(await run('readonly', (s) => s.getAll())),
      async put(row) {
        const clean = checkJob(row);
        let full = false;
        await run('readwrite', (s) => {
          const n = s.count();
          n.onsuccess = () => {
            const has = s.getKey(clean.id);
            has.onsuccess = () => { if (has.result === undefined && n.result >= MAX_JOBS) { full = true; s.transaction.abort(); } else { try { s.put(clean); } catch { s.transaction.abort(); } } }; // a refused put aborts, so the caller hears about it
          };
        }).catch((err) => { throw full ? new RangeError('jobs-store: full') : err; });
      },
      async remove(id) { await run('readwrite', (s) => { s.delete(id); }); },
      close() { db.close(); },
    };
  } catch {
    return memoryStore(scope);
  }
}

/** Delete the jobs of one local scope (a removed profile). Always resolves: an error or a blocked delete (another tab
 * still has it open; the browser finishes the delete once that tab closes it) never fails the caller. */
export async function deleteJobsDb(scope, { indexedDB = globalThis.indexedDB } = {}) {
  memory.delete(scope);
  try {
    if (!indexedDB) return;
    const name = await jobsDbName(scope);
    await new Promise((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  } catch { /* the profile is already removed; leftover jobs are not worth failing that */ }
}
