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

test('a registry line replaces only the "Registry acceptance" row, in timeFields and in every manifest export', () => {
  const registry = { value: 'Registered at 2026-11-17T10:00:05Z', basis: "the registry's clock; the registry's statement, not proof of the files" };
  const fields = timeFields({ sealedAt: '2026-11-17T10:00:00.000Z', registry });
  assert.deepEqual(fields[2], { label: 'Registry acceptance', ...registry });
  assert.deepEqual(timeFields({ sealedAt: '2026-11-17T10:00:00.000Z', registry: null }), timeFields({ sealedAt: '2026-11-17T10:00:00.000Z' }));
  const report = manifestReport({ sealedName: 'x.manifest.fseal', sources: SOURCES, keyFingerprint: 'ab'.repeat(32), head: 'cd'.repeat(32), sealedAt: '2026-11-17T10:00:00.000Z', trust: { status: 'untrusted' }, items: [], extras: [], locals: [], registry });
  const line = `Registry acceptance: ${registry.value} (${registry.basis})`;
  for (const out of [report.text, report.markdown, report.pdfLines.join('\n'), JSON.parse(report.json).report]) {
    assert.ok(out.includes(line), out);
    assert.ok(!out.includes('Not registered') && !out.includes('no registry was used'));
  }
  assert.deepEqual(JSON.parse(report.json).timeProvenance.fields[2], { label: 'Registry acceptance', ...registry });
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
  assert.equal(trustLine({ status: 'weak' }, SOURCES), "This public key is weak and can't prove anything");
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

test('an edited copy needs a "derived from" value; it is never silently dropped', () => {
  assert.throws(() => composeNote({ edited: true, derivedFrom: '  ', note: 'x' }), (error) => error.code === 'note-tag' && /Derived from/.test(error.message));
  assert.equal(composeNote({ edited: true, derivedFrom: 'item 2' }), '[derived-from=item 2]');
});

// "Verify verdicts" (EXPERIENCE.md, release layout): one case per table row, first row that applies wins.
import { countsLine, NOT_IN_LIST, NOT_VERIFIED_NEXT, pairFiles, verdict, VERIFIED_NEEDS_TRUSTED_KEY } from '../src/recipient-trust.mjs';
const m = (s) => ({ status: s });
const TRUSTED = { status: 'trusted', entry: { name: 'Skyline', source: 'contract-or-invoice' } };
test('verdict: every row of the table, in order, with its exact words and one next step', () => {
  const v = (args) => { const r = verdict(args); return [r.headline, r.kind, r.next.text]; };
  assert.deepEqual(v({ signed: true, trust: { status: 'compromised' }, items: [m('bytes-differ')] }), ['Signed by a key marked compromised', 'bad', 'Ask the company for a new seal']);
  assert.equal(verdict({ signed: true, trust: { status: 'compromised' } }).sentence, "This key was reported as compromised. Don't rely on these files until the company confirms them.");
  assert.deepEqual(v({ signed: false, reason: 'No receipt found in the receipt message.' }), ['Not verified', 'bad', NOT_VERIFIED_NEXT]);
  assert.equal(verdict({ signed: false, reason: 'No receipt found in the receipt message.' }).sentence, 'No receipt found in the receipt message.');
  assert.equal(verdict({ signed: true, trust: { status: 'wrong-key' } }).sentence, trustLine({ status: 'wrong-key' }));
  assert.deepEqual(v({ signed: true, trust: TRUSTED, items: [m('match'), m('bytes-differ'), m('missing')] }), ['Files differ', 'warn', 'Ask for the original files']);
  assert.equal(verdict({ signed: true, trust: TRUSTED, items: [m('bytes-differ')] }).sentence, BYTES_DIFFER.text);
  const incomplete = verdict({ signed: true, trust: TRUSTED, items: [m('match'), m('match'), m('missing')], extras: [m('not-in-manifest')] });
  assert.deepEqual([incomplete.headline, incomplete.kind, incomplete.sentence, incomplete.next.text], ['Incomplete', 'warn', "2 of 3 files were checked. A file that is missing can't be checked.", 'Add the missing originals']);
  assert.equal(verdict({ signed: true, trust: TRUSTED, items: [m('match')], coverage: { covered: 5, total: 8 } }).sentence, 'Receipts cover 5 of 8 items.');
  const extra = verdict({ signed: true, trust: TRUSTED, items: [m('match')], extras: [m('not-in-manifest'), m('not-in-manifest')] });
  assert.deepEqual([extra.headline, extra.kind, extra.sentence, extra.next.text], [NOT_IN_LIST, 'warn', "Every listed file matches. 2 other files you chose aren't in the list and were not checked.", "Remove files that aren't in the list"]);
  assert.equal(VERIFIED_NEEDS_TRUSTED_KEY, true, 'owner decision 1 is provisional: strict');
  for (const status of ['untrusted', 'replaced', undefined]) {
    const r = verdict({ signed: true, trust: status && { status }, items: [m('match')], coverage: { covered: 1, total: 1 } });
    assert.deepEqual([r.headline, r.kind, r.sentence, r.next.text], ['Files match · signer not confirmed', 'warn', "The files match what was sealed, but you haven't confirmed who sealed them.", "Confirm the company's fingerprint on Trust"]);
  }
  const ok = verdict({ signed: true, trust: TRUSTED, items: [m('match'), m('match')] });
  assert.deepEqual([ok.headline, ok.kind, ok.sentence, ok.next.text], ['Verified', 'ok', 'Every file matches what was sealed, signed by a company you trust.', 'Download report']);
  assert.equal(countsLine([m('match'), m('match'), m('bytes-differ'), m('missing')], []), '2 match · 1 differs · 1 missing · 0 not in the list');
});

test('pairFiles: by name, so a renamed byte-identical file reads Missing plus Not in the list; unnamed items by digest; ambiguity stops', () => {
  const H = (c) => c.repeat(64);
  const list = { items: [{ id: 1, name: 'a.bin', bytes: 3, sha256: H('a'), note: '' }, { id: 2, name: '', bytes: 4, sha256: H('b'), note: '' }, { id: 3, name: 'c.bin', bytes: 5, sha256: H('c'), note: '' }] };
  const out = pairFiles(list, [{ name: 'renamed.bin', bytes: 3, sha256: H('a') }, { name: 'x', bytes: 4, sha256: H('b') }, { name: 'c.bin', bytes: 5, sha256: H('d') }]);
  assert.deepEqual(out.items.map((i) => [i.id, i.status, i.local]), [[1, 'missing', null], [2, 'match', 1], [3, 'bytes-differ', 2]]);
  assert.deepEqual(out.extras.map((e) => [e.name, e.status]), [['renamed.bin', 'not-in-manifest']]);
  assert.throws(() => pairFiles(list, [{ name: 'a.bin', bytes: 1, sha256: H('a') }, { name: 'a.bin', bytes: 1, sha256: H('a') }]), { message: 'Two chosen files have the same path: a.bin. Choose one.' });
  const folders = { items: [{ id: 1, name: 'north/v.mp4', bytes: 1, sha256: H('a'), note: '' }, { id: 2, name: 'east/v.mp4', bytes: 1, sha256: H('b'), note: '' }] };
  assert.throws(() => pairFiles(folders, [{ name: 'v.mp4', bytes: 1, sha256: H('a') }]), { message: 'The list has two files named v.mp4 in different folders. Choose the folder instead of single files so each can be matched.' });
});

test('manifest report: extras read "Not in the list" and the report carries the verdict line', () => {
  const r = manifestReport({ sealedName: 'x.manifest.fseal', trust: { status: 'untrusted' }, items: [{ id: 1, name: 'a', bytes: 1, sha256: 'a'.repeat(64), note: '', status: 'match', local: 0 }], extras: [{ name: 'b', bytes: 2, sha256: 'b'.repeat(64) }], locals: [{ name: 'a', sha256: 'a'.repeat(64) }] });
  assert.match(r.text, /Result: Not in the list\. Every listed file matches\. 1 other file you chose isn't in the list and was not checked\./);
  assert.match(r.text, /Not in the list: b \(2 bytes/);
  assert.ok(!r.text.includes('Not in manifest'));
  assert.equal(JSON.parse(r.json).verdict.headline, 'Not in the list');
});

test('verdict: a compromised signer outranks a chosen company that did not sign; otherwise the mismatch is Not verified', () => {
  const ok = [{ status: 'match' }];
  const other = { name: 'Other Co', matches: false };
  assert.equal(verdict({ signed: true, trust: { status: 'compromised' }, items: ok, company: other }).key, 'compromised');
  const v = verdict({ signed: true, trust: { status: 'trusted' }, items: ok, company: other });
  assert.deepEqual([v.key, v.headline, v.sentence], ['not-verified', 'Not verified', "Not signed by Other Co's key. Don't rely on this proof."]);
  assert.equal(verdict({ signed: true, trust: { status: 'trusted' }, items: ok, company: { name: 'Pilot Co', matches: true } }).key, 'verified');
});
