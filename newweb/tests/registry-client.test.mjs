import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const noTok = await none.createShare({ registration_id: 'r', expires_days: 3 });
  assert.deepEqual({ ...noTok, share: undefined }, { ok: false, kind: 'http', status: 401, code: 'unauthorized', share: undefined });
  assert.match(noTok.share.token, /^[A-Za-z0-9_-]{43}$/, 'a failed call still hands back what a retry needs');
  const arr = createRegistryClient({ getToken: async () => 't', fetch: async () => json(200, []) });
  assert.deepEqual(await arr.listRegistrations(), { ok: false, kind: 'http', status: 200, code: 'bad_response' });
  const html = createRegistryClient({ getToken: async () => 't', fetch: async () => new Response('<html>', { status: 502 }) });
  assert.deepEqual(await html.withdrawShare('tok'), { ok: false, kind: 'http', status: 502, code: 'http_502' });
});

test('createShare makes the token locally, sends only its SHA-256 and an idempotency key; a retry reuses both', async () => {
  const calls = [];
  const client = createRegistryClient({ baseUrl: 'http://x', getToken: async () => 't', fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return calls.length === 1 ? Promise.reject(new TypeError('lost')) : json(200, { registration_id: 'a'.repeat(32), expires_at: '2027-01-01T00:00:00Z', disposition: 'active' }); } });
  const first = await client.createShare({ registration_id: 'a'.repeat(32), expires_days: 7 });
  assert.equal(first.kind, 'network');
  const { token, idempotency_key: key, path } = first.share;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(key, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(path, `/v1/shares/${token}`);
  assert.deepEqual(calls[0], { registration_id: 'a'.repeat(32), token_hash: createHash('sha256').update(token).digest('hex'), idempotency_key: key, expires_days: 7 });
  assert.ok(!JSON.stringify(calls[0]).includes(token), 'the token itself never leaves the client');
  const retry = await client.createShare({ registration_id: 'a'.repeat(32), expires_days: 7, ...first.share });
  assert.equal(retry.ok, true);
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(retry.share, first.share);
  const other = await client.createShare({ registration_id: 'a'.repeat(32) });
  assert.notEqual(other.share.token, token);
});

test('getEpoch reads GET /v1/epoch', async () => {
  const seen = [];
  const client = createRegistryClient({ getToken: async () => 't', fetch: async (url, init) => { seen.push([init.method, url]); return json(200, { epoch: 3 }); } });
  assert.deepEqual(await client.getEpoch(), { ok: true, status: 200, data: { epoch: 3 } });
  assert.deepEqual(seen, [['GET', '/v1/epoch']]);
});

test('createShare refuses a malformed token and a context without Web Crypto, without sending and without throwing', async () => {
  const client = createRegistryClient({ getToken: async () => 't', fetch: async () => assert.fail('must not send') });
  const bad = await client.createShare({ registration_id: 'a'.repeat(32), token: 'short' });
  assert.deepEqual({ ...bad, share: undefined }, { ok: false, kind: 'client', status: 0, code: 'bad_token', share: undefined });
  const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: (a) => a } }); // no subtle
  try {
    const r = await client.createShare({ registration_id: 'a'.repeat(32) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'insecure_context');
  } finally { Object.defineProperty(globalThis, 'crypto', real); }
});

test('getShare is public: GET /v1/shares/<token> with no authorization header, even with a token available', async () => {
  const calls = [];
  const client = createRegistryClient({ baseUrl: 'http://x', getToken: async () => assert.fail('getShare must not read the token'), fetch: async (url, init) => { calls.push({ url, init }); return json(200, { head: 'h', count: 1, key_fingerprint: 'f', received_at: '2027-01-01T00:00:00Z' }); } });
  const tok = 'A'.repeat(43);
  const r = await client.getShare(tok);
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, `http://x/v1/shares/${tok}`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(calls[0].init.body, undefined);
  const missing = createRegistryClient({ fetch: async () => json(404, { error: 'not_found' }) });
  assert.deepEqual(await missing.getShare(tok), { ok: false, kind: 'http', status: 404, code: 'not_found' });
});

test('deleteRegistration sends DELETE /v1/registrations/<id> with the bearer token', async () => {
  const calls = [];
  const client = createRegistryClient({ baseUrl: 'http://x/', getToken: async () => 'T', fetch: async (url, init) => { calls.push({ url, init }); return json(200, { registration_id: 'a'.repeat(32), disposition: 'deleted' }); } });
  const r = await client.deleteRegistration('a'.repeat(32));
  assert.equal(r.ok, true);
  assert.equal(r.data.disposition, 'deleted');
  assert.equal(calls[0].url, `http://x/v1/registrations/${'a'.repeat(32)}`);
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].init.headers.authorization, 'Bearer T');
});
