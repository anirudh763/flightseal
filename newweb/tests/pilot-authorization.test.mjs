// The browser checker for pilot key authorizations (newweb/src/pilot-authorization.mjs) against the shared vectors the
// Python reference (registry/registry/pilot_authorization.py) is tested on, plus the cross-format rule (design §10).
//   PILOT_VECTORS=<path> overrides the vector file (to check another revision of it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINE_PREFIX, MAX_DAYS, PREFIX, check, parse, parseLine } from '../src/pilot-authorization.mjs';
import { checkReceipts, hex } from '../../docs/verifier.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VECTORS = JSON.parse(readFileSync(process.env.PILOT_VECTORS || resolve(ROOT, 'tests/fixtures/pilot-authorization.json'), 'utf8'));
const fromHex = (h) => Uint8Array.from(h.match(/../g), (b) => Number.parseInt(b, 16));

/** { found, reason } the way the Python test evaluates a case: no line → no_line; a bad line → malformed. */
async function evaluate(message, pilotKey, companyKey, now) {
  const line = parseLine(message);
  if (!line.found) return { found: false, reason: 'no_line' };
  if (line.malformed) return { found: true, reason: 'malformed' };
  return { found: true, reason: (await check(line.authorization, line.sig, pilotKey, companyKey, now)).reason };
}

test('constants match the vector file', () => {
  assert.equal(VECTORS.prefix, PREFIX);
  assert.equal(VECTORS.line_prefix, LINE_PREFIX);
  assert.equal(VECTORS.max_days, MAX_DAYS);
  assert.ok(VECTORS.cases.length >= 27); // 27 since #66 (found + the leading-space no_line case)
});

for (const c of VECTORS.cases) {
  test(`vector: ${c.name}`, async () => {
    const got = await evaluate(c.line, fromHex(c.pilot_key), fromHex(c.company_key), c.now);
    assert.equal(got.reason, c.reason ?? null);
    assert.equal(got.found, c.found ?? true);
  });
}

test('every reason the Python can give has a vector', () => {
  const reasons = new Set(VECTORS.cases.map((c) => c.reason));
  for (const r of VECTORS.reasons.map((x) => x.reason)) assert.ok(reasons.has(r), r);
});

test('a line with a leading space is not an authorization line (no_line), so nothing is authorized', async () => {
  const valid = VECTORS.cases.find((c) => c.name === 'valid');
  const got = await evaluate(` ${valid.line}`, fromHex(valid.pilot_key), fromHex(valid.company_key), valid.now);
  assert.deepEqual(got, { found: false, reason: 'no_line' });
});

test('parseLine: missing trailing space, two dots, no dot and CRLF are malformed; \\r is not a line break', () => {
  for (const bad of [`Authorized by company key:abc.${'0'.repeat(128)}`, 'Authorized by company key: a.b.c', 'Authorized by company key: abc'])
    assert.deepEqual(parseLine(bad), { found: true, malformed: true }, bad);
  assert.deepEqual(parseLine('no authorization here\n'), { found: false });
  assert.deepEqual(parseLine(`note\r${LINE_PREFIX}a.b`), { found: false }); // split on \n only, like parse_line
});

test('parse refuses a year under 100, which Date.UTC would move to 19xx', () => {
  const valid = VECTORS.cases.find((c) => c.name === 'valid');
  const text = atob(valid.authorization.replace(/-/g, '+').replace(/_/g, '/')).replace(/not_after=\d{4}/, 'not_after=0050');
  assert.equal(parse(btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), null);
});

// ---- cross-format: one company key signs a receipt, a challenge and an authorization; none passes as another ----
const sub = globalThis.crypto.subtle;
const newKey = async () => {
  const pair = await sub.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return { pair, raw: new Uint8Array(await sub.exportKey('raw', pair.publicKey)) };
};
const sign = async (key, bytes) => new Uint8Array(await sub.sign({ name: 'Ed25519' }, key.pair.privateKey, bytes));
const receiptBytes = (count, head) => { // docs/verifier.js signedMessage: "fseal-receipt v1" || u64le count || head
  const label = new TextEncoder().encode('fseal-receipt v1');
  const m = new Uint8Array(label.length + 40);
  m.set(label); new DataView(m.buffer).setBigUint64(label.length, count, true); m.set(head, label.length + 8);
  return m;
};
const b64url = (text) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const statement = (pilot, company) => [PREFIX, `pilot_key=${hex(pilot)}`, `company_key=${hex(company)}`, 'not_after=2027-01-29T08:00:00Z'].join('\n');

test('cross-format: an authorization or an enroll challenge signed by the company key fails as a receipt', async () => {
  const company = await newKey(), pilot = await newKey();
  const head = new Uint8Array(32).fill(7);
  const scan = { status: 'ok', records: 1, links: new Map([['1', head]]) };
  const good = await checkReceipts([{ count: 1n, head, key: company.raw, sig: await sign(company, receiptBytes(1n, head)) }], company.raw, scan);
  assert.equal(good.results[0].result, 'ok'); // the harness itself accepts a real receipt
  for (const text of [statement(pilot.raw, company.raw), `hashwing-key-enroll v1\norgA\n${'a'.repeat(32)}`]) {
    const sig = await sign(company, new TextEncoder().encode(text));
    const out = await checkReceipts([{ count: 1n, head, key: company.raw, sig }], company.raw, scan);
    assert.equal(out.results[0].result, 'bad-signature', text.split('\n')[0]);
  }
});

test('cross-format: a receipt signature fails as an authorization; the real one passes', async () => {
  const company = await newKey(), pilot = await newKey();
  const text = statement(pilot.raw, company.raw);
  const now = Date.parse('2027-01-20T00:00:00Z') / 1000;
  assert.equal((await check(b64url(text), hex(await sign(company, new TextEncoder().encode(text))), pilot.raw, company.raw, now)).reason, null);
  const receiptSig = hex(await sign(company, receiptBytes(1n, new Uint8Array(32))));
  assert.equal((await check(b64url(text), receiptSig, pilot.raw, company.raw, now)).reason, 'bad_signature');
});
