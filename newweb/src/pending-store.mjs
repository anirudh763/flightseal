// Unsent proofs that are not in an owner's outbox yet: sealed while signed out of the registry (owner null, "unassigned"),
// or kept because the owner's outbox could not take them (owner "<org>/<sub>"). One IndexedDB database per local scope
// (a local profile, or the shared guest scope), so a sign-out or logout never deletes them and another profile never
// sees them. A row holds only the receipt line, its owner and when it was sealed: never a file name, media, key or token.
// Without IndexedDB the store runs in memory and says so (storage: 'memory'), so the caller can offer an export.
import { isReceipt } from './outbox.mjs';

export const MAX_PENDING = 200;
const FIELDS = ['receipt', 'owner', 'at'];

async function sha256hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('aborted')); });

function check(row) {
  if (!row || Object.keys(row).some((k) => !FIELDS.includes(k)) || !isReceipt(row.receipt)
    || !(row.owner === null || (typeof row.owner === 'string' && /^[^/]+\/[^/]+$/.test(row.owner))) || !Number.isFinite(row.at)) throw new TypeError('pending-store: bad row');
}

function memoryStore() {
  const rows = new Map();
  return {
    storage: 'memory',
    async list() { return [...rows.values()].map((r) => ({ ...r })); },
    async put(row) { check(row); if (!rows.has(row.receipt) && rows.size >= MAX_PENDING) throw new RangeError('pending-store: full'); rows.set(row.receipt, { ...row }); },
    async remove(receipt) { rows.delete(receipt); },
    close() {},
  };
}

/** Open the pending store for one local scope (for example `profile:<id>` or `guest`). Never throws: falls back to memory. */
export async function openPendingStore(scope, { indexedDB = globalThis.indexedDB } = {}) {
  if (typeof scope !== 'string' || !scope) throw new TypeError('pending-store: scope required');
  try {
    if (!indexedDB) throw new Error('no indexedDB');
    const name = `hashwing-pending-v1-${await sha256hex(scope)}`;
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('proofs', { keyPath: 'receipt' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('blocked'));
    });
    const run = async (mode, fn) => { const tx = db.transaction(['proofs'], mode); const req = fn(tx.objectStore('proofs')); await done(tx); return req?.result; };
    return {
      storage: 'indexeddb',
      list: () => run('readonly', (s) => s.getAll()),
      async put(row) {
        check(row);
        let full = false;
        await run('readwrite', (s) => {
          const count = s.count();
          count.onsuccess = () => {
            const has = s.getKey(row.receipt);
            has.onsuccess = () => { if (has.result === undefined && count.result >= MAX_PENDING) { full = true; s.transaction.abort(); } else s.put({ receipt: row.receipt, owner: row.owner, at: row.at }); };
          };
        }).catch((err) => { throw full ? new RangeError('pending-store: full') : err; });
      },
      async remove(receipt) { await run('readwrite', (s) => { s.delete(receipt); }); },
      close() { db.close(); },
    };
  } catch {
    return memoryStore();
  }
}
