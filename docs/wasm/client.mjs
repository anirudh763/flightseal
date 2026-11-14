// Each operation owns its worker, so cancellation also discards native state and keys.
export const VERIFY_MAX_BYTES = 500 * 1024 * 1024;
export const SEAL_MAX_BYTES = 16 * 1024 * 1024;

function run(operation, file, fields, { signal } = {}) {
  if (!(file instanceof Blob)) return Promise.reject(new TypeError('Choose a file first.'));
  const limit = operation === 'verify' ? VERIFY_MAX_BYTES : SEAL_MAX_BYTES;
  if (file.size > limit) return Promise.reject(new RangeError(`File exceeds the ${limit / 1024 / 1024} MiB ${operation} limit.`));
  if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
    let finished = false;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      worker.terminate();
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(reject, new Error('The C++ WebAssembly worker could not run. Reload and retry.'));
    worker.onmessage = ({ data }) => data.error ? finish(reject, new Error(data.error)) : finish(resolve, data.result);
    worker.postMessage({ operation, file, ...fields });
  });
}

export function verifyFile(file, receipts = '', publicKey = '', options = {}) {
  if (typeof receipts !== 'string' || typeof publicKey !== 'string') return Promise.reject(new TypeError('Receipts and trusted key must be text.'));
  if (receipts.includes('\0') || publicKey.includes('\0')) return Promise.reject(new TypeError('Receipts and key cannot contain NUL bytes.'));
  if (new TextEncoder().encode(receipts).byteLength > 4 * 1024 * 1024) return Promise.reject(new RangeError('Receipt file exceeds 4 MiB.'));
  return run('verify', file, { receipts, publicKey: publicKey.trim() }, options);
}

export function sealFile(file, { every = 1000, signal } = {}) {
  if (!Number.isInteger(every) || every < 1 || every > 1000000) return Promise.reject(new RangeError('Receipt interval must be between 1 and 1,000,000.'));
  return run('seal', file, { every }, { signal });
}
