import { removeTemporaryOutput, ownTemporaryOutput } from './opfs.mjs';
export { recoverTemporaryOutputs } from './opfs.mjs';

// Each operation owns its worker, so cancellation also discards native state and keys.
// One MiB of envelope headroom lets a one-GiB raw source verify after sealing.
export const VERIFY_MAX_BYTES = 1025 * 1024 * 1024;
export const SEAL_MAX_BYTES = 64 * 1024 * 1024; // the bridge also caps sealed output at 64 MiB
const MEMORY_IMPORT_MAX_BYTES = 16 * 1024 * 1024;
export const IMPORT_MAX_BYTES = 1024 * 1024 * 1024;

function run(operation, file, fields, { signal } = {}) {
  if (!(file instanceof Blob)) return Promise.reject(new TypeError('Choose a file first.'));
  const limit = operation === 'verify' ? VERIFY_MAX_BYTES : operation === 'import' ? IMPORT_MAX_BYTES : SEAL_MAX_BYTES;
  if (file.size > limit) return Promise.reject(new RangeError(`File exceeds the ${limit / 1024 / 1024} MiB ${operation} limit.`));
  if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
    const outputName = operation === 'import' ? `flightseal-import-${crypto.randomUUID()}.tmp` : null;
    const memoryOnly = operation === 'import' && (!navigator.storage?.getDirectory || !navigator.locks?.request);
    let releaseOwnership;
    let finished = false;
    const finish = async (callback, value) => {
      if (finished) return;
      finished = true;
      worker.terminate();
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      if (releaseOwnership && callback === reject) {
        try { await removeTemporaryOutput(outputName); }
        catch { value = new Error(`${value?.message || 'Import failed'}. Temporary output could not be cleared; clear FlightSeal site storage before retrying.`); }
      }
      if (releaseOwnership && callback === resolve && value?.temporaryOutputName === outputName) {
        const unlock = releaseOwnership;
        value.dispose = async () => { try { await removeTemporaryOutput(outputName); } finally { await unlock(); } };
      } else if (releaseOwnership) await releaseOwnership();
      callback(value);
    };
    const abort = () => finish(reject, new DOMException('Cancelled', 'AbortError'));
    const deadline = setTimeout(() => finish(reject, new Error('This operation reached its five-minute limit. Cancelled safely; try a smaller capture or use the CLI.')), 300000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(reject, new Error('The C++ WebAssembly worker could not run. Reload and retry.'));
    worker.onmessage = ({ data }) => data.error ? finish(reject, new Error(data.error)) : finish(resolve, data.result);
    (async () => {
      if (outputName && !memoryOnly) releaseOwnership = await ownTemporaryOutput(outputName);
      if (finished) { if (releaseOwnership) await releaseOwnership(); return; }
      if (memoryOnly && file.size > MEMORY_IMPORT_MAX_BYTES) throw new Error('Large imports need browser private storage and Web Locks. Use a supported browser or the CLI.');
      worker.postMessage({ operation, file, ...fields, outputName, memoryOnly });
    })().catch((error) => finish(reject, error));
  });
}

export function verifyFile(file, receipts = '', publicKey = '', options = {}) {
  if (typeof receipts !== 'string' || typeof publicKey !== 'string') return Promise.reject(new TypeError('Receipts and trusted key must be text.'));
  if (receipts.includes('\0') || publicKey.includes('\0')) return Promise.reject(new TypeError('Receipts and key cannot contain NUL bytes.'));
  if (new TextEncoder().encode(receipts).byteLength > 4 * 1024 * 1024) return Promise.reject(new RangeError('Receipt file exceeds 4 MiB.'));
  return run('verify', file, { receipts, publicKey: publicKey.trim() }, options);
}

export function sealFile(file, { every = 1000, signal, privateKeyPem = '' } = {}) {
  if (!Number.isInteger(every) || every < 1 || every > 1000000) return Promise.reject(new RangeError('Receipt interval must be between 1 and 1,000,000.'));
  if (typeof privateKeyPem !== 'string' || privateKeyPem.includes('\0') || privateKeyPem.length > 16384) return Promise.reject(new TypeError('Private Ed25519 PEM must be text no longer than 16 KiB.'));
  return run('seal', file, { every, privateKeyPem }, { signal });
}

export function importFile(file, { every = 1000, signal } = {}) {
  if (!Number.isInteger(every) || every < 1 || every > 1000000) return Promise.reject(new RangeError('Receipt interval must be between 1 and 1,000,000.'));
  return run('import', file, { every }, { signal });
}
