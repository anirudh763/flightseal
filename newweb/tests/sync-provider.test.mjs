import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncProvider } from '../src/sync-provider.mjs';

test('provider stays clearly unconfigured and sends no request without endpoint credentials', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const provider = createSyncProvider({});
  assert.equal(provider.status, 'unconfigured');
  globalThis.fetch = async () => { calls++; throw new Error('unexpected'); };
  try {
    await assert.rejects(provider.request('/rest/v1/workspaces', { accessToken: 'test' }), /not configured/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('configured Supabase REST adapter requires an authenticated token and bounded table route', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return new Response('[{"revision":2}]', { status: 200 }); };
  try {
    const provider = createSyncProvider({ supabaseUrl: 'https://project.supabase.co/', supabaseAnonKey: 'public-anon-key' });
    assert.equal(provider.status, 'configured');
    await assert.rejects(provider.request('/rest/v1/workspaces'), /authenticated user access token/);
    await assert.rejects(provider.request('/rest/v1/workspaces?select=*', { accessToken: 'user-jwt' }), /not an allowed table or workspace procedure route/);
    const result = await provider.request('/rest/v1/workspaces', { accessToken: 'user-jwt', method: 'GET' });
    assert.deepEqual(result, [{ revision: 2 }]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer user-jwt');
    assert.equal(requests[0].options.headers.apikey, 'public-anon-key');
  } finally { globalThis.fetch = originalFetch; }
});

test('workspace sync is consent-gated, revision-aware, bounded, deletable and stops stale writes', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ status: calls.length === 1 ? 'conflict' : calls.length === 2 ? 'synced' : 'deleted', revision: 4 }), { status: 200 });
  };
  try {
    const provider = createSyncProvider({ supabaseUrl: 'https://project.supabase.co', supabaseAnonKey: 'anon' });
    const args = { workspaceId: 'd2719c6f-bf53-47d5-8bd0-a8cb18806d1d', payload: { screen: 'records', sample: 'intact', record: 4 }, accessToken: 'user-jwt' };
    await assert.rejects(provider.syncWorkspace(args), /Explicit cloud-sync consent/);
    await assert.rejects(provider.syncWorkspace({ ...args, explicitConsent: true, isCurrent: () => false }), /session changed/);
    assert.equal(calls.length, 0);
    const conflict = await provider.syncWorkspace({ ...args, explicitConsent: true, expectedRevision: 2 });
    assert.equal(conflict.status, 'conflict');
    const saved = await provider.syncWorkspace({ ...args, explicitConsent: true, expectedRevision: 3 });
    assert.equal(saved.status, 'synced');
    const body = JSON.parse(calls[1].options.body);
    assert.deepEqual(Object.keys(body).sort(), ['p_expected_revision', 'p_payload', 'p_workspace_id']);
    assert.equal(JSON.stringify(body).includes('private'), false);
    const deleted = await provider.deleteWorkspace({ workspaceId: args.workspaceId, expectedRevision: 4, accessToken: 'user-jwt', explicitConsent: true });
    assert.equal(deleted.status, 'deleted');
    assert.match(calls[2].url, /rpc\/flightseal_delete_workspace$/);
  } finally { globalThis.fetch = originalFetch; }
});
