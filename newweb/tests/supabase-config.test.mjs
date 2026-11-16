import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrowserSupabaseKey } from '../src/supabase-config.mjs';

function jwt(role) { return `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`; }
test('browser Supabase config accepts only public publishable/anon keys', () => {
  assert.equal(validateBrowserSupabaseKey('sb_publishable_public-value'), 'sb_publishable_public-value');
  assert.equal(validateBrowserSupabaseKey(jwt('anon')), jwt('anon'));
  assert.throws(() => validateBrowserSupabaseKey('sb_secret_top-secret'), /cannot be compiled into browser code/);
  assert.throws(() => validateBrowserSupabaseKey(jwt('service_role')), /bypasses row-level security/);
  assert.throws(() => validateBrowserSupabaseKey('x'.repeat(4097)), /bounded/);
});
