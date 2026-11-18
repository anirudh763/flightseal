// Streaming whole-file SHA-256 through OpenSSL in WebAssembly: one digest context, the file's bytes in order,
// one 4 MiB File.slice() read in flight and one reused heap buffer. Each read is detached right after the copy, so
// Chrome frees it at once instead of letting hundreds of MiB of old reads wait for GC. Nothing is sent anywhere.
import createFlightSeal from './flightseal.mjs';

self.onmessage = async ({ data: { file, chunk } }) => {
  let module, buffer = 0;
  try {
    module = await createFlightSeal();
    buffer = module._malloc(chunk);
    if (!buffer || module._fseal_sha256_begin() !== 1) throw new Error('Could not start SHA-256 in the WebAssembly engine.');
    let done = 0;
    while (done < file.size) {
      const want = Math.min(chunk, file.size - done);
      const bytes = new Uint8Array(await file.slice(done, done + want).arrayBuffer());
      if (bytes.length !== want) throw new Error(`Read ${bytes.length} of ${want} bytes at offset ${done}; the file changed or became unreadable.`);
      module.HEAPU8.set(bytes, buffer); // re-read HEAPU8 every time: memory growth replaces the view
      bytes.buffer.transfer?.(0); // free the 4 MiB read now instead of at the next GC
      if (module._fseal_sha256_update(buffer, want) !== 1) throw new Error('SHA-256 update failed in the WebAssembly engine.');
      done += want;
      self.postMessage({ progress: done });
    }
    const sha256 = module.ccall('fseal_sha256_final', 'string', [], []);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('SHA-256 finalization failed in the WebAssembly engine.');
    self.postMessage({ sha256, bytes: done, wasmHeapBytes: module.HEAPU8.length });
  } catch (error) {
    self.postMessage({ error: error?.message || String(error), name: error?.name || 'Error' });
  } finally {
    if (module && buffer) module._free(buffer);
  }
};
