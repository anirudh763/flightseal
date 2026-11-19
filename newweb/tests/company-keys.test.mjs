import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { createRegistryClient } from '../src/registry-client.mjs';
import { challengeBytes, enroll, enrolledLine, errorLine, listAllKeys, publicKeyHexFromPem, signerFromPem, stateLabel } from '../src/company-keys.mjs';

const SEED_A_DER = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from([...Array(32).keys()])]);
const SEED_A_PEM = `-----BEGIN PRIVATE KEY-----\n${SEED_A_DER.toString('base64')}\n-----END PRIVATE KEY-----\n`;
// Independent derivation (node:crypto, not WebCrypto) of SEED_A's raw public key.
const SEED_A_PUB = Buffer.from(createPublicKey(createPrivateKey({ key: SEED_A_DER, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x, 'base64url').toString('hex');
const fpOf = (pubHex) => createHash('sha256').update(Buffer.from(pubHex, 'hex')).digest('hex');
const NONCE = '0123456789abcdef0123456789abcdef';
const msg = (org, nonce = NONCE) => `hashwing-key-enroll v1\n${org}\n${nonce}`;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A fake registry: `routes` maps "METHOD /path" to a function (call index, body) -> Response. Every call is recorded.
function fake(routes) {
  const calls = [];
  const client = createRegistryClient({ baseUrl: 'http://reg', getToken: async () => 'WRONG', fetch: async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    const n = calls.filter((c) => c.key === key).length;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, url: u, body, auth: init.headers.authorization });
    const fn = routes[key];
    return fn ? fn(n, body, u) : json(404, { error: 'not_found' });
  } });
  return { client, calls, count: (key) => calls.filter((c) => c.key === key).length };
}
function spy() {
  const calls = [];
  const fn = async (bytes) => { calls.push(bytes); return 'ab'.repeat(64); };
  fn.calls = calls;
  return fn;
}
const run = (client, sign, extra = {}) => enroll({ client, org: 'orgK', token: 'T', sign, publicKeyHex: SEED_A_PUB, ...extra });

test('challengeBytes builds the bytes itself and accepts only an exact, well-formed challenge', () => {
  const ok = challengeBytes('orgK', { nonce: NONCE, message: msg('orgK') });
  assert.equal(new TextDecoder().decode(ok), msg('orgK'));
  for (const message of [`${msg('orgK')}\n`, msg('orgA'), `fseal-receipt v1 count=1 head=${'1'.repeat(64)}`, `hashwing-pilot-authorization v1\npilot_key=${'a'.repeat(64)}`, msg('orgK').toUpperCase()]) {
    assert.equal(challengeBytes('orgK', { nonce: NONCE, message }), null, JSON.stringify(message));
  }
  for (const nonce of [NONCE.toUpperCase(), NONCE.slice(1), `${NONCE}0`, `${NONCE.slice(0, 31)}g`, ` ${NONCE.slice(1)}`]) {
    assert.equal(challengeBytes('orgK', { nonce, message: msg('orgK', nonce) }), null, `nonce ${nonce} (message matches it)`);
  }
  assert.equal(challengeBytes('', { nonce: NONCE, message: msg('') }), null, 'no org, no bytes');
  assert.equal(challengeBytes('orgK', null), null);
});

test('a hostile or broken challenge gets no signature and no POST', async () => {
  const hostile = [msg('orgA'), `${msg('orgK')}\n`, `fseal-receipt v1 count=0 head=${'0'.repeat(64)} key=${SEED_A_PUB}`, `hashwing-pilot-authorization v1\npilot_key=${'a'.repeat(64)}\ncompany_key=${SEED_A_PUB}\nnot_after=2030-01-01T00:00:00Z`];
  const cases = [...hostile.map((message) => ({ nonce: NONCE, message })), { nonce: 'ABCDEF0123456789ABCDEF0123456789', message: msg('orgK', 'ABCDEF0123456789ABCDEF0123456789') }, { nonce: 'abc', message: msg('orgK', 'abc') }];
  for (const challenge of cases) {
    const reg = fake({ 'GET /v1/keys/challenge': () => json(200, { ...challenge, expires_at: 'x' }) });
    const sign = spy();
    const out = await run(reg.client, sign);
    assert.equal(out.reason, 'unexpected_challenge', JSON.stringify(challenge));
    assert.equal(sign.calls.length, 0, 'never signed');
    assert.equal(reg.count('POST /v1/keys'), 0, 'nothing posted');
    assert.equal(errorLine(out), 'The registry sent an unexpected challenge. Nothing was signed.');
  }
});

test('enroll signs the locally built bytes and POSTs exactly public_key, nonce, signature with the press token', async () => {
  const reg = fake({ 'GET /v1/keys/challenge': () => json(200, { nonce: NONCE, message: msg('orgK') }), 'POST /v1/keys': () => json(201, { key_fingerprint: fpOf(SEED_A_PUB), state: 'active', replaced: null }) });
  const sign = await signerFromPem(SEED_A_PEM);
  const out = await run(reg.client, sign);
  assert.equal(out.ok, true);
  const post = reg.calls.find((c) => c.key === 'POST /v1/keys');
  assert.deepEqual(Object.keys(post.body).sort(), ['nonce', 'public_key', 'signature']);
  assert.equal(post.body.public_key, SEED_A_PUB);
  assert.ok(reg.calls.every((c) => c.auth === 'Bearer T'), 'every call uses the token taken for this press');
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(SEED_A_PUB, 'hex').toString('base64url') }, format: 'jwk' });
  assert.ok(verify(null, Buffer.from(msg('orgK')), pub, Buffer.from(post.body.signature, 'hex')), 'the signature is over the challenge bytes');
  // replace adds confirm_replace:true and nothing else
  const reg2 = fake({ 'GET /v1/keys/challenge': () => json(200, { nonce: NONCE, message: msg('orgK') }), 'POST /v1/keys': () => json(201, {}) });
  await run(reg2.client, spy(), { confirmReplace: true });
  assert.deepEqual(reg2.calls.find((c) => c.key === 'POST /v1/keys').body, { public_key: SEED_A_PUB, nonce: NONCE, signature: 'ab'.repeat(64), confirm_replace: true });
});

test('409 confirm_required is its own reason (the screen opens the replace dialog)', async () => {
  const reg = fake({ 'GET /v1/keys/challenge': () => json(200, { nonce: NONCE, message: msg('orgK') }), 'POST /v1/keys': () => json(409, { error: 'confirm_required' }) });
  assert.equal((await run(reg.client, spy())).reason, 'confirm_required');
});

test('400 bad_challenge: exactly one challenge and one POST, no automatic retry', async () => {
  const reg = fake({ 'GET /v1/keys/challenge': () => json(200, { nonce: NONCE, message: msg('orgK') }), 'POST /v1/keys': () => json(400, { error: 'bad_challenge' }) });
  const out = await run(reg.client, spy());
  assert.equal(out.reason, 'bad_challenge');
  assert.equal(reg.count('GET /v1/keys/challenge'), 1);
  assert.equal(reg.count('POST /v1/keys'), 1);
  assert.equal(errorLine(out), 'That request expired. Press the button again.');
});

test('409 key_exists after a lost answer: success only when the loaded key is the active key, found across pages', async () => {
  const fp = fpOf(SEED_A_PUB), other = 'c'.repeat(64);
  const pages = (active) => (n, _b, u) => (u.searchParams.get('cursor')
    ? json(200, { keys: [{ key_fingerprint: fp, state: active === fp ? 'active' : 'rotated', enrolled_by_me: true }], active_key: active, next_cursor: null })
    : json(200, { keys: [{ key_fingerprint: other, state: active === fp ? 'rotated' : 'active' }], active_key: active, next_cursor: other }));
  const base = { 'GET /v1/keys/challenge': () => json(200, { nonce: NONCE, message: msg('orgK') }), 'POST /v1/keys': () => json(409, { error: 'key_exists' }) };
  const won = fake({ ...base, 'GET /v1/keys': pages(fp) });
  const ok = await run(won.client, spy());
  assert.equal(ok.ok, true);
  assert.equal(ok.recovered, true);
  assert.equal(won.count('GET /v1/keys'), 2, 'followed next_cursor');
  const lost = fake({ ...base, 'GET /v1/keys': pages(other) });
  const no = await run(lost.client, spy());
  assert.equal(no.reason, 'enrolled_before');
  assert.equal(errorLine(no), "This key was enrolled before and can't be enrolled again.");
});

test('listAllKeys follows next_cursor until null and stops at 20 pages', async () => {
  const fp = (i) => i.toString(16).padStart(64, '0');
  const full = fake({ 'GET /v1/keys': (n) => json(200, { keys: Array.from({ length: 50 }, (_, i) => ({ key_fingerprint: fp(n * 50 + i), state: 'rotated' })), active_key: null, next_cursor: n < 2 ? fp(n * 50 + 49) : null }) });
  const out = await listAllKeys(full.client, { token: 'T' });
  assert.equal(out.keys.length, 150);
  assert.equal(out.truncated, false);
  assert.equal(full.calls[1].url.searchParams.get('cursor'), fp(49));
  const endless = fake({ 'GET /v1/keys': (n) => json(200, { keys: [{ key_fingerprint: fp(n), state: 'rotated' }], active_key: null, next_cursor: fp(n) }) });
  const capped = await listAllKeys(endless.client, {});
  assert.equal(endless.count('GET /v1/keys'), 20);
  assert.equal(capped.truncated, true);
  const down = fake({ 'GET /v1/keys': () => json(503, { error: 'unavailable' }) });
  assert.equal((await listAllKeys(down.client, {})).ok, false);
});

test('labels: plain words, dates from the registry only, never "rotated"', () => {
  assert.equal(stateLabel({ state: 'active' }), 'Active');
  assert.equal(stateLabel({ state: 'rotated', changed_at: '2026-11-19T10:00:00Z' }), 'Replaced on 2026-11-19');
  assert.equal(stateLabel({ state: 'compromised', changed_at: '2026-11-20T23:59:59Z' }), 'Marked compromised on 2026-11-20');
  assert.equal(stateLabel({ state: 'retired', changed_at: '2026-11-21T00:00:00Z' }), 'Removed on 2026-11-21');
  assert.equal(stateLabel({ state: 'rotated' }), 'Replaced', 'a missing date is left out');
  assert.equal(stateLabel({ state: 'weird' }), 'Not in use');
  assert.equal(enrolledLine({ enrolled_at: '2026-11-19T10:00:00Z', enrolled_by_me: true }), 'Enrolled 2026-11-19 by you');
  assert.equal(enrolledLine({ enrolled_at: '2026-11-19T10:00:00Z', enrolled_by_me: false }), 'Enrolled 2026-11-19');
  assert.equal(enrolledLine({ enrolled_by_me: false }), '');
  for (const state of ['active', 'rotated', 'compromised', 'retired', 'x', undefined]) assert.ok(!/rotated/i.test(stateLabel({ state, changed_at: '2026-01-01T00:00:00Z' })));
});

test('errors read as plain lines', () => {
  assert.match(errorLine({ reason: 'http', status: 401 }), /sign in again/i);
  assert.match(errorLine({ reason: 'http', status: 403 }), /Only a company admin/);
  assert.match(errorLine({ reason: 'http', status: 409, code: 'conflict' }), /reloaded/);
  assert.match(errorLine({ reason: 'http', status: 422, code: 'bad_signature' }), /couldn't check this key's signature/);
  assert.match(errorLine({ reason: 'http', status: 503 }), /busy/);
  assert.equal(errorLine({ reason: 'http', kind: 'network', status: 0 }), "Couldn't reach the company registry. Try again in a few minutes.");
});

test('the public key of an imported PEM comes from a throwaway JWK export and matches SEED_A; the signer is non-extractable', async () => {
  assert.equal(await publicKeyHexFromPem(SEED_A_PEM), SEED_A_PUB);
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----\n`;
  assert.equal(await publicKeyHexFromPem(pem), Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex'));
  let imported;
  const spyCrypto = { subtle: { importKey: async (...a) => { imported = a; return crypto.subtle.importKey(...a); }, sign: (...a) => crypto.subtle.sign(...a) } };
  await signerFromPem(SEED_A_PEM, spyCrypto);
  assert.equal(imported[0], 'pkcs8');
  assert.equal(imported[3], false, 'the signing import is non-extractable');
  assert.deepEqual(imported[4], ['sign']);
  await assert.rejects(publicKeyHexFromPem('not a pem'));
});
