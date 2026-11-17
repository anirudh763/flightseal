import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BYTES_DIFFER, composeNote, landingLine, manifestReport, parseLandingLine, parseNote, parseSealedLine, reportedInterval,
  timeFields, toIsoFromLocal, trustLine,
} from '../src/recipient-trust.mjs';
import { SOURCES } from '../src/trusted-keys.mjs';

const LANDING = '2026-11-17T09:58:00.000Z';

test('note tags round-trip; plain notes parse to { note } only', () => {
  const note = composeNote({ landing: LANDING, derivedFrom: 'item 2, sha256 ab12', note: 'Cropped for the client' });
  assert.equal(note, `[reported-landing=${LANDING}][derived-from=item 2, sha256 ab12] Cropped for the client`);
  assert.deepEqual(parseNote(note), { landing: LANDING, derivedFrom: 'item 2, sha256 ab12', note: 'Cropped for the client' });
  assert.deepEqual(parseNote(composeNote({ landing: LANDING })), { landing: LANDING, note: '' });
  assert.deepEqual(parseNote(composeNote({ derivedFrom: 'item 1' })), { derivedFrom: 'item 1', note: '' });
  assert.equal(composeNote({ note: 'Camera B' }), 'Camera B');
  for (const plain of ['Camera B, landed 14:02', '[draft] foo', '', '[reported-landing=yesterday] x']) assert.deepEqual(parseNote(plain), { note: plain });
});

test('derived-from with [ or ] is rejected with a friendly message; a note cannot fake a tag', () => {
  for (const derivedFrom of ['item [2]', 'a]b', '[x']) assert.throws(() => composeNote({ derivedFrom }), (error) => error.code === 'note-tag' && /can’t contain \[ or \]/.test(error.message));
  assert.throws(() => composeNote({ note: '[derived-from=item 1] fake' }), /can’t start with/);
  assert.throws(() => composeNote({ landing: '2026-11-17 09:58' }), /full date and time/);
});

test('datetime-local converts to an offset-free UTC ISO string in this computer’s zone', () => {
  const local = '2026-11-17T09:58';
  assert.equal(toIsoFromLocal(local), new Date(2026, 10, 17, 9, 58).toISOString());
  assert.match(toIsoFromLocal(local), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(toIsoFromLocal(''), '');
  assert.equal(toIsoFromLocal('2026-13-45T99:99'), '');
  assert.equal(toIsoFromLocal('not a date'), '');
});

test('interval: positive, negative kept negative and explained, unknown when missing', () => {
  const later = reportedInterval(LANDING, '2026-11-17T11:00:05.000Z');
  assert.equal(later.ms, 3_725_000);
  assert.equal(later.text, '1 h 2 min 5 s from the reported landing to the seal');
  assert.match(later.text, /reported/);
  const negative = reportedInterval('2026-11-17T12:00:00.000Z', '2026-11-17T11:55:00.000Z');
  assert.equal(negative.ms, -300_000);
  assert.match(negative.text, /^-5 min 0 s /);
  assert.match(negative.text, /reported landing is after the seal time/);
  assert.doesNotMatch(negative.text + later.text, /verified/i);
  for (const [a, b] of [['', LANDING], [LANDING, ''], ['nope', LANDING], [LANDING, '2026-11-17']]) assert.deepEqual(reportedInterval(a, b), { ms: null, text: 'Unknown' });
});

test('time fields carry labels and their basis', () => {
  const fields = timeFields({ landing: LANDING, landingSigned: true, sealedAt: '2026-11-17T10:00:00.000Z' });
  assert.deepEqual(fields.map((f) => f.label), ['Reported landing time', 'Sealed on this computer at', 'Registry acceptance', 'Trusted timestamp', 'Reported landing-to-seal interval']);
  assert.equal(fields[0].basis, 'operator-entered, signed, not verified');
  assert.equal(fields[1].basis, "this computer's clock, not verified; from the receipt message, not signed");
  assert.equal(fields[2].value, 'Not registered');
  assert.equal(fields[3].value, 'None');
  assert.equal(fields[4].value, '2 min 0 s from the reported landing to the seal');
  assert.equal(timeFields({ landing: LANDING, sealedAt: '' })[0].basis, 'operator-entered, not signed, not verified');
  assert.equal(timeFields({})[4].value, 'Unknown');
});

test('Sealed and landing lines parse from a quoted, wrapped email reply', () => {
  const message = ['HashWing receipt for x.ulg', "Sealed: 2026-11-17T10:00:00.000Z (from the sealing computer's clock, not", 'independently verified)', landingLine(LANDING), 'fseal-receipt v1 count=1'].map((l) => `> ${l}`).join('\n');
  assert.equal(parseSealedLine(message), '2026-11-17T10:00:00.000Z');
  assert.equal(parseLandingLine(message), LANDING);
  assert.equal(parseLandingLine('Sealed: 2026-11-17T10:00:00.000Z'), '');
  assert.equal(parseSealedLine('Sealed: tomorrow'), '');
});

test('trust wording is exact for every status', () => {
  const entry = { name: 'Acme', source: 'contract', replacedAt: '2026-02-02T00:00:00.000Z' };
  assert.equal(trustLine({ status: 'trusted', entry }, SOURCES), 'Signed by a key you trust: Acme (added from contract or invoice)');
  assert.equal(trustLine({ status: 'untrusted' }, SOURCES), "Valid signature, but this key isn't in your trusted list — confirm its fingerprint through a channel you already know.");
  assert.equal(trustLine({ status: 'compromised', entry }, SOURCES), "Signed by a key you marked as compromised: Acme. Don't rely on this proof without checking with the company.");
  assert.equal(trustLine({ status: 'replaced', entry }, SOURCES), 'Signed by a key that was replaced for Acme on 2026-02-02. Ask the company whether proofs from that key are still valid.');
  assert.match(trustLine({ status: 'wrong-key' }), /Not signed by the key you chose/);
  assert.match(trustLine({ status: 'invalid-signature' }), /signature doesn't match/);
});

test('bytes-differ text is neutral and never claims sameness', () => {
  assert.equal(BYTES_DIFFER.title, 'Bytes differ');
  for (const word of ['editing', 're-saving', 'metadata changes', 'recompression', 'truncation', 'corruption', 'not proof of tampering', "doesn't pick a cause", 'original bytes']) assert.ok(BYTES_DIFFER.text.toLowerCase().includes(word), word);
  assert.doesNotMatch(BYTES_DIFFER.text, /identical|same file/i);
});

test('manifest report carries trust, source, every time field and bytes-differ in text, Markdown, JSON and PDF lines', () => {
  const report = manifestReport({
    sealedName: 'x.manifest.fseal', sources: SOURCES, keyFingerprint: 'ab'.repeat(32), head: 'cd'.repeat(32), sealedAt: '2026-11-17T09:00:00.000Z',
    trust: { status: 'trusted', entry: { name: 'Acme', source: 'contract', addedAt: '2026-11-01T00:00:00.000Z' } },
    items: [
      { id: 1, bytes: 3, sha256: '11'.repeat(32), name: 'a.txt', note: composeNote({ landing: LANDING, note: 'Camera B' }), status: 'bytes-differ', local: 0 },
      { id: 2, bytes: 4, sha256: '22'.repeat(32), name: 'b.txt', note: composeNote({ landing: LANDING, derivedFrom: 'item 1' }), status: 'match', local: 1 },
    ],
    extras: [], locals: [{ name: 'a.txt', bytes: 5, sha256: '33'.repeat(32) }, { name: 'b.txt', bytes: 4, sha256: '22'.repeat(32) }],
  });
  for (const out of [report.text, report.markdown, report.pdfLines.join('\n')]) {
    assert.match(out, /Signed by a key you trust: Acme \(added from contract or invoice\)/);
    assert.match(out, /Key source: contract or invoice/);
    for (const label of ['Reported landing time', 'Sealed on this computer at', 'Registry acceptance', 'Trusted timestamp', 'Reported landing-to-seal interval']) assert.ok(out.includes(label), label);
    assert.match(out, /-58 min 0 s/);
    assert.ok(out.includes(BYTES_DIFFER.text));
    assert.match(out, /Edited copy of: item 1 \(operator-entered, signed\)/);
    assert.doesNotMatch(out, /identical/i);
  }
  const json = JSON.parse(report.json);
  assert.equal(json.keyTrust.status, 'trusted');
  assert.equal(json.keyTrust.sourceLabel, 'contract or invoice');
  assert.equal(json.timeProvenance.fields.length, 5);
  assert.equal(json.timeProvenance.intervalMs, -3_480_000);
  assert.equal(json.fileComparison.items[0].statusLabel, 'Bytes differ');
  assert.equal(json.fileComparison.items[1].derivedFrom, 'item 1');
  assert.equal(json.fileComparison.items[0].note, 'Camera B');
  assert.deepEqual(json.fileComparison.bytesDiffer, BYTES_DIFFER);
});
