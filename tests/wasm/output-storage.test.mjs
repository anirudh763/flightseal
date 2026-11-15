import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import createFlightSeal from '../../docs/wasm/flightseal.mjs';
import { mountSyncOutput } from '../../docs/wasm/opfs.mjs';

test('native filesystem adapter writes, seeks, truncates, syncs and bounds its one output', async () => {
  const module = await createFlightSeal({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
  let data = new Uint8Array(0), flushes = 0;
  const handle = {
    getSize: () => data.length,
    truncate(size) { const resized = new Uint8Array(size); resized.set(data.subarray(0, size)); data = resized; },
    write(buffer, { at }) { if (at + buffer.length > data.length) this.truncate(at + buffer.length); data.set(buffer, at); return buffer.length; },
    read(buffer, { at }) { const chunk = data.subarray(at, at + buffer.length); buffer.set(chunk); return chunk.length; },
    flush() { flushes++; },
  };
  const unmount = mountSyncOutput(module, handle, 32);
  module.FS.writeFile('/output/imported.fseal', Uint8Array.of(1, 2, 3));
  assert.deepEqual(data, Uint8Array.of(1, 2, 3));
  const stream = module.FS.open('/output/imported.fseal', 'r+');
  module.FS.llseek(stream, 1, 0);
  module.FS.write(stream, Uint8Array.of(9), 0, 1);
  stream.stream_ops.fsync(stream);
  module.FS.close(stream);
  assert.equal(flushes, 1);
  assert.deepEqual(module.FS.readFile('/output/imported.fseal'), Uint8Array.of(1, 9, 3));
  assert.throws(() => module.FS.writeFile('/output/imported.fseal', new Uint8Array(33)));
  assert.throws(() => module.FS.writeFile('/output/another-name', new Uint8Array(1)));
  module.FS.unlink('/output/imported.fseal');
  assert.equal(data.length, 0);
  assert.throws(() => module.FS.stat('/output/imported.fseal'));
  unmount();
});
