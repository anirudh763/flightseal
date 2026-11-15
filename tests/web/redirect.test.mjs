import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalConsoleURL } from '../../docs/redirect.mjs';

for (const [suffix, hash] of [
  ['', '#/sandbox'], ['#/findings?sample=tampered', '#/sandbox?sample=tampered'],
  ['?sample=truncated&record=12', '#/records?sample=truncated&record=12'],
  ['#/records/742?sample=intact', '#/records?sample=intact&record=742'],
  ['#/receipts/2?sample=rewritten', '#/receipts?sample=rewritten&receipt=2'],
  ['#/verify', '#/verify'], ['#/telemetry', '#/telemetry'],
  ['?sample=private-filename&token=secret#/records/../../../evil', '#/records'],
]) test(`canonical redirect preserves only known navigation: ${suffix || 'root'}`, () => {
  const result = canonicalConsoleURL(new URL(`https://example.com/flightseal/${suffix}`));
  assert.equal(result.pathname, '/flightseal/console/');
  assert.equal(result.search, '');
  assert.equal(result.hash, hash);
  assert.equal(result.origin, 'https://example.com');
});
