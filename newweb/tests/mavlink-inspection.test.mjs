import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { inspectCapture } from '../src/mavlink/inspect.mjs';

const asset = (name) => readFile(new URL('../src/mavlink/' + name, import.meta.url));

test('the bundled parser finds the sample checksum failure at its capture offset', async () => {
  const result = await inspectCapture(
    new File([await asset('scenario-crc.tlog')], 'sample.tlog'),
    await asset('mavframe.wasm'),
  );
  assert.equal(result.checksumFailures, 1);
  assert.deepEqual(result.findings, [{ kind: 'crc', offset: 8 }]);
});

test('an empty capture is rejected before parser startup', async () => {
  await assert.rejects(inspectCapture(new File([], 'empty.tlog'), null), /nonempty/);
});
