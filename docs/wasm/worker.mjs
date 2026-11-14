import createFlightSeal from './flightseal.mjs';

self.onmessage = async ({ data }) => {
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
      } else throw new Error('Unknown bridge operation');
    } finally { module.FS.unmount('/input'); }
    if (result.error) throw new Error(result.error);
    result.nativeHeapBytes = module.ccall('fseal_heap_bytes', 'number', [], []);
    self.postMessage({ result });
  } catch (error) { self.postMessage({ error: error?.message || String(error) }); }
};
