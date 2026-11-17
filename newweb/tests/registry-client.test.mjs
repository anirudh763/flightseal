import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistryClient, tokenOwner } from '../src/registry-client.mjs';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('tokenOwner reads org_id or custom:org_id plus sub, without verification', () => {
  assert.equal(tokenOwner(jwt({ sub: 'p1', org_id: 'orgA' })), 'orgA/p1');
  assert.equal(tokenOwner(jwt({ sub: 'p1', 'custom:org_id': 'orgB' })), 'orgB/p1');
  assert.equal(tokenOwner(jwt({ sub: 'p1' })), null);
  assert.equal(tokenOwner(jwt({ org_id: 'orgA' })), null);
  assert.equal(tokenOwner('not.a.jwt!'), null);
  assert.equal(tokenOwner('a.b'), null);
  assert.equal(tokenOwner(null), null);
});

test('register sends the bearer token and only the three fields; 2xx is ok with data', async () => {
  const calls = [];
  const client = createRegistryClient({ baseUrl: 'http://x/', getToken: async () => 'T1', fetch: async (url, init) => { calls.push({ url, init }); return json(201, { registration_id: 'r' }); } });
  const r = await client.register({ receipt: 'R', idempotency_key: 'K', envelope_id: 'E', extra: 1 });
  assert.deepEqual(r, { ok: true, status: 201, data: { registration_id: 'r' } });
  assert.equal(calls[0].url, 'http://x/v1/registrations');
  assert.equal(calls[0].init.headers.authorization, 'Bearer T1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { receipt: 'R', idempotency_key: 'K', envelope_id: 'E' });
  const r2 = await client.envelope({ token: 'T2' });
  assert.equal(r2.ok, true);
  assert.equal(calls[1].init.headers.authorization, 'Bearer T2', 'an explicit token wins over getToken');
});

test('errors are typed: http with server code, network, timeout, aborted, missing token', async () => {
  const http = createRegistryClient({ getToken: async () => 't', fetch: async () => json(410, { error: 'registration_deleted' }) });
  assert.deepEqual(await http.register({}), { ok: false, kind: 'http', status: 410, code: 'registration_deleted' });
  const net = createRegistryClient({ getToken: async () => 't', fetch: async () => { throw new TypeError('failed'); } });
  assert.deepEqual(await net.listRegistrations(), { ok: false, kind: 'network', status: 0, code: 'network' });
  const hang = (_u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))));
  const slow = createRegistryClient({ getToken: async () => 't', fetch: hang, timeoutMs: 20 });
  assert.equal((await slow.envelope()).kind, 'timeout');
  const ctl = new AbortController();
  const p = createRegistryClient({ getToken: async () => 't', fetch: hang }).register({}, { signal: ctl.signal });
  ctl.abort();
  assert.equal((await p).kind, 'aborted');
  const none = createRegistryClient({ getToken: async () => null, fetch: async () => assert.fail('must not send') });
  assert.deepEqual(await none.createShare('r', 3), { ok: false, kind: 'http', status: 401, code: 'unauthorized' });
  const arr = createRegistryClient({ getToken: async () => 't', fetch: async () => json(200, []) });
  assert.deepEqual(await arr.listRegistrations(), { ok: false, kind: 'http', status: 200, code: 'bad_response' });
  const html = createRegistryClient({ getToken: async () => 't', fetch: async () => new Response('<html>', { status: 502 }) });
  assert.deepEqual(await html.withdrawShare('tok'), { ok: false, kind: 'http', status: 502, code: 'http_502' });
});
