// Manifest-only sealing (docs/manifest.mjs, tools/manifest.py): published vectors, strict parsing, limits, the
// sealed-manifest verification rule against the real C++ CLI, the pairing rule, and JS == Python bytes.
//   node --test tests/web/manifest.test.mjs        (needs build/fseal: cmake -S . -B build && cmake --build build)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MANIFEST_LIMITS, compareFiles, encodeManifest, manifestHandoverText, manifestRecordsBlob, newSalt, parseManifest, verifySealedManifest } from '../../docs/manifest.mjs';
import { crc32 } from '../../docs/verifier.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'manifest');
const FSEAL = process.env.FSEAL_BIN || join(ROOT, 'build', 'fseal');
const PYTHON = process.env.PYTHON || 'python3';
const TOOL = join(ROOT, 'tools', 'manifest.py');
if (!existsSync(FSEAL)) throw new Error(`build the CLI first (cmake --build build); missing ${FSEAL}`);
const dir = mkdtempSync(join(tmpdir(), 'fseal-manifest-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const run = (cmd, args, input) => spawnSync(cmd, args, { input, maxBuffer: 1 << 26 });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ascii = (s) => new TextEncoder().encode(s);
const S = 'ab'.repeat(32), D = sha(Buffer.from('abc'));

function link(prev, seq, ts, payload) {
  const h = Buffer.alloc(20); h.writeBigUInt64LE(BigInt(seq), 0); h.writeBigUInt64LE(BigInt(ts), 8); h.writeUInt32LE(payload.length, 16);
  return createHash('sha256').update(Buffer.concat([prev, h, payload])).digest();
}

let n = 0;
function seal(lines) {
  const tag = `s${n++}`, key = join(dir, `${tag}.pem`), log = join(dir, `${tag}.fseal`), receipts = join(dir, `${tag}.receipts`);
  const pub = run(FSEAL, ['keygen', key]).stdout.toString().trim();
  const r = run(FSEAL, ['append', log, '--key', key, '--receipts', receipts, '--every', '1'], lines);
  assert.equal(r.status, 0, r.stderr?.toString());
  return { log: readFileSync(log), receipts: readFileSync(receipts, 'utf8'), pub };
}
const blob = (bytes) => new Blob([bytes]);

for (const name of ['basic', 'minimal']) {
  test(`fixture ${name}: encode, parse and head are exact`, () => {
    const spec = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
    const payload = readFileSync(join(FIXTURES, `${name}.payload`));
    assert.deepEqual(Buffer.from(encodeManifest(spec)), payload);
    const parsed = parseManifest(new Uint8Array(payload));
    assert.equal(parsed.salt, spec.salt);
    assert.deepEqual(parsed.items, spec.items.map((it, i) => ({ id: i + 1, ...it })));
    assert.equal(link(Buffer.alloc(32), 0, 0, payload).toString('hex'), readFileSync(join(FIXTURES, `${name}.head`), 'utf8').trim());
  });
}

test('strict parse rejects non-canonical forms', () => {
  const good = `hashwing-manifest v1 salt=${S} items=1 item=1,3,${D},a%C3%A9,`;
  assert.equal(parseManifest(ascii(good)).items[0].name, 'aé');
  for (const bad of [
    good.replace('%C3%A9', '%c3%a9'), // lowercase escape
    good.replace('a%C3', '%61%C3'), // escaped unreserved character
    good.replace(',3,', ',03,'), // leading zero
    good.replace(D, D.toUpperCase()),
    good + ' ', good + '\r', ' ' + good, good.replace(' items', '  items'),
    good.replace('items=1', 'items=2'), good.replace('item=1,', 'item=2,'), good.replace('items=1', 'items=01'),
    good.replace('a%C3%A9', 'a b'), good.replace('a%C3%A9', '%C3'), good.replace('a%C3%A9', '%FF'),
    good.replace('v1', 'v2'), good + ',x', `hashwing-manifest v1 salt=${S} items=0`,
    good.replace(`salt=${S}`, `salt=${S.slice(2)}`),
  ]) assert.throws(() => parseManifest(ascii(bad)), /./, bad);
  assert.throws(() => parseManifest(new Uint8Array([...ascii(good), 0xc3])), TypeError);
  assert.throws(() => parseManifest(good), TypeError);
});

test('limits throw RangeError or TypeError', () => {
  const item = { bytes: 3, sha256: D };
  assert.throws(() => encodeManifest({ salt: S, items: [] }), RangeError);
  assert.throws(() => encodeManifest({ salt: S, items: Array(101).fill(item) }), RangeError);
  assert.equal(parseManifest(encodeManifest({ salt: S, items: Array(100).fill(item) })).items.length, 100);
  assert.throws(() => encodeManifest({ salt: S, items: Array(100).fill({ ...item, note: '€'.repeat(333) }) }), RangeError); // payload > 65536
  assert.throws(() => encodeManifest({ salt: S, items: [{ ...item, name: 'é'.repeat(128) }] }), RangeError); // 256 bytes
  assert.ok(encodeManifest({ salt: S, items: [{ ...item, name: 'a'.repeat(255) }] }));
  assert.throws(() => encodeManifest({ salt: S, items: [{ ...item, note: 'a'.repeat(1001) }] }), RangeError);
  assert.ok(encodeManifest({ salt: S, items: [{ ...item, note: 'a'.repeat(1000) }] }));
  assert.throws(() => encodeManifest({ salt: S, items: [{ ...item, name: 'a\uD800b' }] }), TypeError);
  assert.throws(() => encodeManifest({ salt: S, items: [{ ...item, note: '\uDC00' }] }), TypeError);
  assert.throws(() => encodeManifest({ salt: S, items: [{ ...item, bytes: 1e15 }] }), RangeError);
  assert.throws(() => encodeManifest({ salt: S, items: [{ ...item, bytes: -1 }] }), RangeError);
  assert.throws(() => encodeManifest({ salt: S, items: [{ ...item, sha256: D.toUpperCase() }] }), TypeError);
  assert.throws(() => encodeManifest({ salt: 'AB'.repeat(32), items: [item] }), TypeError);
  assert.throws(() => parseManifest(new Uint8Array(MANIFEST_LIMITS.maxPayloadBytes + 1).fill(0x41)), RangeError);
  assert.match(newSalt(), /^[0-9a-f]{64}$/);
  assert.notEqual(newSalt(), newSalt());
});

const payload = encodeManifest({ salt: S, items: [{ bytes: 3, sha256: D, name: 'a.mp4' }, { bytes: 0, sha256: sha(Buffer.alloc(0)) }] });
const record = async (p) => Buffer.from(await manifestRecordsBlob(p).arrayBuffer());

test('verifySealedManifest accepts a CLI-sealed manifest only with the trusted key', async () => {
  const { log, receipts, pub } = seal(await record(payload));
  assert.equal(receipts.trim().split('\n').length, 1);
  const handover = manifestHandoverText({ items: 2, receipts, publicKey: pub, sealedAt: '2026-11-17T00:00:00Z' });
  assert.ok(!handover.includes(D) && !handover.includes('a.mp4'), 'no names or digests in the handover');
  const ok = await verifySealedManifest(blob(log), handover, pub);
  assert.equal(ok.verified, true, ok.reason);
  assert.equal(ok.manifest.items[0].name, 'a.mp4');
  assert.equal(ok.head, link(Buffer.alloc(32), 0, 0, Buffer.from(payload)).toString('hex'));
  assert.equal((await verifySealedManifest(blob(log), receipts, pub)).verified, true, 'a bare receipts file works too');
  // The CLI agrees the log is intact under that receipt and key.
  writeFileSync(join(dir, 'ok.fseal'), log); writeFileSync(join(dir, 'ok.receipts'), receipts);
  assert.equal(run(FSEAL, ['verify', join(dir, 'ok.fseal'), '--receipts', join(dir, 'ok.receipts'), '--pubkey', pub]).status, 0);

  const other = seal(Buffer.from('0\tx\n')).pub;
  for (const key of ['', '  ', 'zz', other]) {
    const r = await verifySealedManifest(blob(log), handover, key);
    assert.equal(r.verified, false, `key ${key}`);
    assert.equal(r.manifest, undefined, 'no manifest data without verification');
  }
});

test('every rejection row', async () => {
  const { log, receipts, pub } = seal(await record(payload));
  const reject = async (bytes, text = receipts, why = /./) => {
    const r = await verifySealedManifest(blob(bytes), text, pub);
    assert.equal(r.verified, false);
    assert.equal(r.manifest, undefined);
    assert.match(r.reason, why);
  };
  // Payload byte changed: CRC left stale, CRC fixed, CRC and link fixed (then the head differs from the receipt).
  const at = 8 + 20 + 30;
  const flipped = Buffer.from(log); flipped[at] ^= 1;
  await reject(flipped, receipts, /damaged \(bad-crc\)/);
  const crcFixed = Buffer.from(flipped); crcFixed.writeUInt32LE(crc32(crcFixed, 8, crcFixed.length - 4), crcFixed.length - 4);
  await reject(crcFixed, receipts, /damaged \(bad-link\)/);
  const relinked = Buffer.from(crcFixed);
  link(Buffer.alloc(32), 0, 0, relinked.subarray(28, relinked.length - 36)).copy(relinked, relinked.length - 36);
  relinked.writeUInt32LE(crc32(relinked, 8, relinked.length - 4), relinked.length - 4);
  await reject(relinked, receipts, /does not match this sealed manifest/);
  // Trailing garbage / torn tail.
  await reject(Buffer.concat([log, Buffer.from('garbage!')]));
  await reject(log.subarray(0, log.length - 1), receipts, /damaged/);
  await reject(Buffer.alloc(0));
  await reject(Buffer.alloc(8 + 20 + 65536 + 37), receipts, /too large/);

  // Two signed records: honest count=1 and count=2 receipts under one key.
  const two = seal(Buffer.concat([await record(payload), Buffer.from('1\tsecond\n')]));
  const [r1, r2] = two.receipts.trim().split('\n');
  assert.match(r1, /count=1 /); assert.match(r2, /count=2 /);
  const verifyTwo = (bytes, text) => verifySealedManifest(blob(bytes), text, two.pub);
  const extra = await verifyTwo(two.log, r1 + '\n');
  assert.equal(extra.verified, false); assert.match(extra.reason, /exactly one record/);
  const first = two.log.subarray(0, 8 + 20 + payload.length + 36);
  assert.equal((await verifyTwo(first, r1 + '\n')).verified, true, 'record 0 alone with its count=1 receipt is fine');
  const count2 = await verifyTwo(first, r2 + '\n');
  assert.equal(count2.verified, false); assert.match(count2.reason, /exactly one record/);
  const both = await verifyTwo(first, two.receipts);
  assert.equal(both.verified, false); assert.match(both.reason, /exactly one receipt/);
  // A receipt from someone else's key, even with a "Public key:" line naming it, is not trusted.
  const forged = seal(await record(payload));
  const text = manifestHandoverText({ items: 2, receipts: forged.receipts, publicKey: forged.pub, sealedAt: 'now' });
  const r = await verifySealedManifest(blob(forged.log), text, pub);
  assert.equal(r.verified, false); assert.match(r.reason, /not signed by the trusted public key/);
  await reject(log, '', /No receipt/);
  // A sealed record that is not a manifest.
  const junk = seal(Buffer.from('0\thello\n'));
  const j = await verifySealedManifest(blob(junk.log), junk.receipts, junk.pub);
  assert.equal(j.verified, false); assert.match(j.reason, /not a valid manifest/);
});

test('compareFiles pairing rule', () => {
  const m = parseManifest(encodeManifest({ salt: S, items: [
    { bytes: 3, sha256: D, name: 'a.mp4' }, // 1
    { bytes: 3, sha256: D, name: 'dup.mp4' }, // 2 same digest as 1
    { bytes: 5, sha256: 'e'.repeat(64), name: 'b.mp4' }, // 3 edited locally
    { bytes: 7, sha256: 'f'.repeat(64) }, // 4 no name: cannot be "bytes differ"
    { bytes: 9, sha256: '1'.repeat(64), name: 'gone.mp4' }, // 5 missing
  ] }));
  const out = compareFiles(m, [
    { name: 'renamed.mp4', bytes: 3, sha256: D }, // matches lowest id 1 regardless of name
    { name: 'b.mp4', bytes: 5, sha256: '0'.repeat(64) },
    { name: 'x.bin', bytes: 7, sha256: '2'.repeat(64) },
    { name: 'copy.mp4', bytes: 3, sha256: D }, // matches 2
    { name: 'b.mp4', bytes: 5, sha256: '3'.repeat(64) }, // item 3 already paired
  ]);
  assert.deepEqual(out.items.map((i) => [i.id, i.status, i.local]), [[1, 'match', 0], [2, 'match', 3], [3, 'bytes-differ', 1], [4, 'missing', null], [5, 'missing', null]]);
  assert.deepEqual(out.extras.map((e) => [e.local, e.status]), [[2, 'not-in-manifest'], [4, 'not-in-manifest']]);
  assert.equal(out.allMatch, false);
  assert.equal(compareFiles(m, []).items.every((i) => i.status === 'missing'), true);
  const one = parseManifest(encodeManifest({ salt: S, items: [{ bytes: 3, sha256: D }] }));
  assert.equal(compareFiles(one, [{ name: 'q', bytes: 3, sha256: D }]).allMatch, true);
});

test('JS bytes equal python3 tools/manifest.py create bytes', async () => {
  const files = [['empty.bin', Buffer.alloc(0)], ['vidéo 1 (cam B).mp4', Buffer.from('abc')], ['log.ulg', Buffer.from([0, 1, 2, 255])]];
  const paths = files.map(([name, body]) => { const p = join(dir, name); writeFileSync(p, body); return p; });
  const note = 'Landed 14:02; ✓ "ok" & 100%';
  for (const names of [false, true]) {
    const py = run(PYTHON, [TOOL, 'create', '--salt', S, ...(names ? ['--include-names'] : []), '--note', `2=${note}`, ...paths]);
    assert.equal(py.status, 0, py.stderr.toString());
    const js = await record(encodeManifest({ salt: S, items: files.map(([name, body], i) => ({ bytes: body.length, sha256: sha(body), name: names ? name : '', note: i === 1 ? note : '' })) }));
    assert.deepEqual(py.stdout, js);
  }
  const digest = run(PYTHON, [TOOL, 'digest', paths[1]]);
  assert.equal(digest.stdout.toString().trim(), D);
});
