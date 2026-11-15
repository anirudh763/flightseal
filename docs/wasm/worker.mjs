import createFlightSeal from './flightseal.mjs';
import { createTemporaryOutput } from './opfs.mjs';

self.onmessage = async ({ data }) => {
  let temporaryOutput;
  try {
    const module = await createFlightSeal();
    module.FS.mkdir('/input');
    module.FS.mount(module.WORKERFS, { blobs: [{ name: 'source', data: data.file }] }, '/input');
    let result;
    try {
      if (data.operation === 'verify') {
        result = JSON.parse(module.ccall('fseal_verify', 'string', ['string', 'string', 'string'], ['/input/source', data.receipts, data.publicKey]));
      } else if (data.operation === 'seal') {
        result = JSON.parse(module.ccall('fseal_seal', 'string', ['string', 'number'], ['/input/source', data.every]));
        if (!result.error) {
          result.log = new Blob([module.FS.readFile('/sealed.fseal')], { type: 'application/octet-stream' });
          result.engine = 'C++ / OpenSSL / WebAssembly';
        }
      } else if (data.operation === 'import') {
        const outputBytes = data.file.size + Math.ceil(data.file.size / (1048576 - 18)) * 74 + 114;
        try { if (!data.memoryOnly) temporaryOutput = await createTemporaryOutput(module, data.outputName, outputBytes); }
        catch (error) { if (data.file.size > 16 * 1024 * 1024) throw new Error(`Large import needs browser temporary storage: ${error.message}`); }
        result = JSON.parse(module.ccall('fseal_import', 'string', ['string', 'string', 'number'], ['/input/source', temporaryOutput?.path || '/sealed-import.fseal', data.every]));
        if (!result.error) {
          if (temporaryOutput) {
            result.log = await temporaryOutput.snapshot();
            result.temporaryOutputName = data.outputName;
            result.temporaryStorage = 'browser-private';
          } else {
            result.log = new Blob([module.FS.readFile('/sealed-import.fseal')], { type: 'application/octet-stream' });
            result.temporaryStorage = 'memory';
          }
          result.engine = 'C++ / OpenSSL / WebAssembly';
        }
      } else throw new Error('Unknown bridge operation');
    } finally {
      module.FS.unmount('/input');
      for (const path of ['/sealed.fseal', '/sealed-import.fseal', '/ephemeral.pem', '/ephemeral-import.pem']) {
        try { module.FS.unlink(path); } catch {}
      }
    }
    if (result.error) throw new Error(result.error);
    result.nativeHeapBytes = module.ccall('fseal_heap_bytes', 'number', [], []);
    self.postMessage({ result });
  } catch (error) {
    let message = error?.message || String(error);
    if (error?.name === 'QuotaExceededError' || /No space available/.test(message))
      message = 'Browser temporary storage is full. Clear old imported outputs, use a regular browser window, or use the CLI; the source file was not changed.';
    if (temporaryOutput) {
      try { await temporaryOutput.discard(); }
      catch { message += '. Temporary output could not be cleared.'; }
    }
    self.postMessage({ error: message });
  }
};
