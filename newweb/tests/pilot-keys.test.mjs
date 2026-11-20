// Option B, the sender's half on Trust: the pilot challenge (rule B1), the enroll body, the refusal lines, the
// key_exists recovery, the key request the company computer reads, and the authorization it builds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistryClient } from '../src/registry-client.mjs';
import { authorizationError, challengeBytes, errorLine, keyRequest, pastedAuthorization, pilotEnroll, pilotLabel, PILOT_PREFIX, readKeyRequest, signerFromPem } from '../src/company-keys.mjs';
import { authorize, check, notAfterFor, parse, weakKey } from '../src/pilot-authorization.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pem = (seed) => `-----BEGIN PRIVATE KEY-----\n${Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]).toString('base64')}\n-----END PRIVATE KEY-----\n`;
const pubOf = (p) => Buffer.from(createPublicKey(createPrivateKey(p)).export({ format: 'jwk' }).x, 'base64url').toString('hex');
const PILOT_PEM = pem([...Array(32).keys()].map((i) => i + 100));
const COMPANY_PEM = pem([...Array(32).keys()].map((i) => 200 - i));
const PILOT = pubOf(PILOT_PEM), COMPANY = pubOf(COMPANY_PEM);
const bytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
const fpOf = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const NONCE = '0123456789abcdef0123456789abcdef';
const msg = (org = 'orgP', nonce = NONCE) => `${PILOT_PREFIX}\n${org}\n${nonce}`;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NOW = 1_800_000_000;

function fake(routes) {
  const calls = [];
  const client = createRegistryClient({ baseUrl: 'http://reg', getToken: async () => 'WRONG', fetch: async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization });
    const fn = routes[key];
    return fn ? fn(calls.filter((c) => c.key === key).length - 1) : json(404, { error: 'not_found' });
  } });
  return { client, calls, count: (key) => calls.filter((c) => c.key === key).length };
}
function spy() { const fn = async (b) => { fn.calls.push(b); return 'ab'.repeat(64); }; fn.calls = []; return fn; }
async function line(days = 14, nowSec = NOW) {
  return authorize(bytes(PILOT), bytes(COMPANY), notAfterFor(days, nowSec), await signerFromPem(COMPANY_PEM), Math.floor(nowSec));
}
const enrollWith = async (reg, sign, l) => {
  const p = pastedAuthorization(l);
  return pilotEnroll({ client: reg.client, org: 'orgP', token: 'T', sign, publicKeyHex: PILOT, authorization: p.authorization, sig: p.sig, companyFingerprint: fpOf(COMPANY) });
};
const ok = () => ({ 'GET /v1/pilot-keys/challenge': () => json(200, { nonce: NONCE, message: msg() }) });

test('pilot challenge: built locally with the pilot prefix; every hostile or broken one signs nothing and POSTs nothing', async () => {
  assert.equal(new TextDecoder().decode(challengeBytes('orgP', { nonce: NONCE, message: msg() }, PILOT_PREFIX)), msg());
  assert.equal(challengeBytes('orgP', { nonce: NONCE, message: msg() }), null, 'the company prefix never accepts a pilot challenge');
  const l = await line();
  const hostile = [
    { nonce: NONCE, message: `hashwing-key-enroll v1\norgP\n${NONCE}` }, // a company challenge
    { nonce: NONCE, message: `fseal-receipt v1 count=1 head=${'1'.repeat(64)} key=${PILOT} sig=${'2'.repeat(128)}` },
    { nonce: NONCE, message: `hashwing-pilot-authorization v1\npilot_key=${PILOT}\ncompany_key=${COMPANY}\nnot_after=2030-01-01T00:00:00Z` },
    { nonce: NONCE, message: msg('orgA') },
    { nonce: NONCE, message: `${msg()}\n` },
    { nonce: NONCE.toUpperCase(), message: msg('orgP', NONCE.toUpperCase()) },
    { nonce: NONCE.slice(2), message: msg('orgP', NONCE.slice(2)) },
  ];
  for (const challenge of hostile) {
    const reg = fake({ 'GET /v1/pilot-keys/challenge': () => json(200, challenge) });
    const sign = spy();
    const out = await enrollWith(reg, sign, l);
    assert.equal(out.reason, 'unexpected_challenge', JSON.stringify(challenge));
    assert.equal(sign.calls.length, 0);
    assert.equal(reg.count('POST /v1/pilot-keys'), 0);
    assert.equal(errorLine(out), 'The registry sent an unexpected challenge. Nothing was signed.');
  }
});

test('enroll: one challenge, a signature over the pilot challenge bytes, and a body of exactly the five fields', async () => {
  const reg = fake({ ...ok(), 'POST /v1/pilot-keys': () => json(201, { key_fingerprint: fpOf(PILOT), kind: 'pilot', state: 'active' }) });
  const l = await line();
  const out = await enrollWith(reg, await signerFromPem(PILOT_PEM), l);
  assert.equal(out.ok, true);
  const post = reg.calls.find((c) => c.key === 'POST /v1/pilot-keys');
  assert.deepEqual(Object.keys(post.body).sort(), ['authorization', 'authorization_sig', 'nonce', 'public_key', 'signature']);
  assert.equal(post.body.public_key, PILOT);
  assert.equal(`Authorized by company key: ${post.body.authorization}.${post.body.authorization_sig}`, l);
  assert.ok(!JSON.stringify(post.body).includes('PRIVATE'), 'no private key material');
  assert.ok(reg.calls.every((c) => c.auth === 'Bearer T'));
  const pub = createPublicKey(createPrivateKey(PILOT_PEM));
  assert.ok(verify(null, Buffer.from(msg()), pub, Buffer.from(post.body.signature, 'hex')));
});

test('refusals: each registry code has its own plain line (raw code kept), never the admin-only line', async () => {
  const codes = [[403, 'pilot_keys_off'], [422, 'bad_authorization'], [422, 'authorization_expired'], [422, 'company_key_not_active'], [409, 'pilot_key_limit'], [400, 'bad_challenge']];
  const lines = new Set();
  for (const [status, error] of codes) {
    const reg = fake({ ...ok(), 'POST /v1/pilot-keys': () => json(status, { error }) });
    const out = await enrollWith(reg, spy(), await line());
    assert.equal(out.code, error);
    assert.equal(reg.count('POST /v1/pilot-keys'), 1, 'never retried');
    const text = errorLine(out);
    assert.notEqual(text, 'Only a company admin can change company keys.', error);
    lines.add(text);
  }
  assert.equal(lines.size, codes.length, 'one line per code');
});

test('409 key_exists: success only when the list has that key active, kind pilot, under the same company key', async () => {
  const row = (extra) => ({ key_fingerprint: fpOf(PILOT), kind: 'pilot', state: 'active', company_fingerprint: fpOf(COMPANY), ...extra });
  const run = async (r) => enrollWith(fake({ ...ok(), 'POST /v1/pilot-keys': () => json(409, { error: 'key_exists' }), 'GET /v1/keys': () => json(200, { keys: [r], active_key: fpOf(COMPANY), pilot_keys: true }) }), spy(), await line());
  const won = await run(row());
  assert.equal(won.ok, true); assert.equal(won.recovered, true);
  for (const bad of [row({ state: 'retired' }), row({ kind: 'company' }), row({ company_fingerprint: 'c'.repeat(64) }), row({ key_fingerprint: 'd'.repeat(64) })]) {
    const out = await run(bad);
    assert.equal(out.reason, 'enrolled_before', JSON.stringify(bad));
    assert.equal(errorLine(out), "This key was enrolled before and can't be enrolled again.");
  }
});

test('key request: only the exact three-line format; the fingerprint is computed from the key and must agree', async () => {
  const good = keyRequest(PILOT, fpOf(PILOT));
  assert.equal(good, `HashWing pilot key request\npublic_key=${PILOT}\nfingerprint=${fpOf(PILOT).match(/.{4}/g).join(' ')}\n`);
  const read = await readKeyRequest(good, COMPANY);
  assert.equal(read.hex, PILOT); assert.equal(read.fingerprint, fpOf(PILOT));
  assert.equal((await readKeyRequest(good.trimEnd(), COMPANY)).hex, PILOT, 'no trailing newline is fine');
  const refused = {
    'two trailing newlines': `${good}\n`, 'extra line': `${good}note=hi\n`, 'no title': good.split('\n').slice(1).join('\n'),
    'uppercase key': good.replace(PILOT, PILOT.toUpperCase()), 'leading space': ` ${good}`, CRLF: good.replace(/\n/g, '\r\n'),
    'fingerprint of another key': keyRequest(PILOT, fpOf(COMPANY)), 'fingerprint without groups': good.replace(/fingerprint=.*/, `fingerprint=${fpOf(PILOT)}`),
    'the company key': keyRequest(COMPANY, fpOf(COMPANY)), 'weak key': keyRequest(`01${'00'.repeat(31)}`, fpOf(`01${'00'.repeat(31)}`)),
  };
  for (const [name, text] of Object.entries(refused)) assert.ok((await readKeyRequest(text, COMPANY)).error, name);
  assert.match((await readKeyRequest(keyRequest(COMPANY, fpOf(COMPANY)), COMPANY)).error, /your company key/);
  assert.match((await readKeyRequest(keyRequest(PILOT, fpOf(COMPANY)), COMPANY)).error, /doesn't match its key/);
});

test('authorize: refuses weak, off-curve and same-as-company keys; the line it builds passes check() under the company key', async () => {
  const sign = await signerFromPem(COMPANY_PEM);
  let offCurve = null;
  for (let i = 2; !offCurve; i++) { const k = new Uint8Array(32); k[0] = i; if (weakKey(k)) offCurve = k; }
  for (const [key, why] of [[bytes(`01${'00'.repeat(31)}`), 'weak_pilot_key'], [offCurve, 'weak_pilot_key'], [bytes(COMPANY), 'same_key']]) {
    await assert.rejects(authorize(key, bytes(COMPANY), notAfterFor(14, NOW), sign, NOW), new RegExp(why));
  }
  for (const days of [14, 30]) {
    const l = await line(days);
    const p = pastedAuthorization(l);
    const { reason, auth } = await check(p.authorization, p.sig, bytes(PILOT), bytes(COMPANY), NOW);
    assert.equal(reason, null);
    assert.ok(auth.notAfter < NOW + days * 86400, `${days}: under ${days} days`);
    assert.equal(auth.notAfter, NOW + days * 86400 - 600);
  }
  // A signer that signs other bytes never yields a line.
  await assert.rejects(authorize(bytes(PILOT), bytes(COMPANY), notAfterFor(14, NOW), spy(), NOW), /bad_signature/);
});

test('lifetime margin: with this clock up to 5 minutes ahead of the registry, the 30-day choice passes the registry rule (Python check)', async () => {
  for (const ahead of [0, 60, 300]) {
    const l = await line(30, NOW + ahead); // built on a clock `ahead` seconds fast
    const p = pastedAuthorization(l);
    assert.equal((await check(p.authorization, p.sig, bytes(PILOT), bytes(COMPANY), NOW)).reason, null, `browser rule, ${ahead}s`);
    const py = spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from registry import pilot_authorization as p; r, _ = p.check(sys.argv[2], sys.argv[3], bytes.fromhex(sys.argv[4]), None, int(sys.argv[5])); print(r)', resolve(ROOT, 'registry'), p.authorization, p.sig, PILOT, String(NOW)], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
    assert.equal(py.stdout.trim(), 'None', `registry rule, ${ahead}s ahead`);
  }
});

test('pasted authorization: local check reasons map to plain lines; anything but one line is malformed', async () => {
  assert.equal(pastedAuthorization('hello'), null);
  assert.equal(pastedAuthorization(`${await line()}\n${await line(30)}`), null);
  for (const r of ['not_pilot_key', 'ended', 'bad_signature', 'malformed', 'too_long']) assert.ok(authorizationError(r).length > 10, r);
  assert.equal(authorizationError(null), '');
});

test('not_after years below 1000 are malformed in the browser parser', () => {
  const b64 = (year) => Buffer.from(`hashwing-pilot-authorization v1\npilot_key=${PILOT}\ncompany_key=${COMPANY}\nnot_after=${year}-01-01T00:00:00Z`).toString('base64url');
  assert.equal(parse(b64('0999')), null);
  assert.equal(parse(b64('0001')), null);
  assert.ok(parse(b64('1000')), 'year 1000 still parses (and then reads ended)');
});

test('pilot row label: kind, short company fingerprint and end date; company rows have none', () => {
  const fp = 'ab12'.repeat(16);
  assert.equal(pilotLabel({ kind: 'pilot', company_fingerprint: fp, not_after: '2026-12-03T10:00:00Z' }), 'Pilot key · company key ab12 ab12 ab12 ab12 · ends on 2026-12-03');
  assert.equal(pilotLabel({ kind: 'company' }), '');
  assert.equal(pilotLabel({ kind: 'pilot', company_fingerprint: null, not_after: null }), 'Pilot key');
});
