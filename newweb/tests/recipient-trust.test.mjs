import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BYTES_DIFFER, applyRegistryRecord, composeNote, landingLine, manifestReport, parseLandingLine, parseNote, parseSealedLine, reportedInterval,
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
  const incomplete = verdict({ signed: true, trust: TRUSTED, items: [m('match'), m('match'), { ...m('missing'), name: 'c.bin' }], extras: [m('not-in-manifest')] }); // a named list: an unnamed one reads "Files differ or are missing"
  assert.deepEqual([incomplete.headline, incomplete.kind, incomplete.sentence, incomplete.next.text], ['Incomplete', 'warn', "2 of 3 files were checked. A file that is missing can't be checked.", 'Add the missing originals']);
  assert.equal(verdict({ signed: true, trust: TRUSTED, items: [m('match')], coverage: { covered: 5, total: 8 } }).sentence, 'Receipts cover 5 of 8 items.');
  const extra = verdict({ signed: true, trust: TRUSTED, items: [m('match')], extras: [m('not-in-manifest'), m('not-in-manifest')] });
  assert.deepEqual([extra.headline, extra.kind, extra.sentence, extra.next.text], [NOT_IN_LIST, 'warn', "Every listed file matches. 2 other files you chose aren't in the list and were not checked.", "Remove files that aren't in the list"]);
  assert.equal(VERIFIED_NEEDS_TRUSTED_KEY, true, 'owner decision 1 (2026-11-18): strict');
  for (const status of ['untrusted', 'unconfirmed', 'replaced', undefined]) {
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

import * as trustModule from '../src/recipient-trust.mjs';

test('verdict: an unnamed list with one flipped byte reads "Files differ or are missing", never a guessed pairing', () => {
  const sealed = { items: [{ id: 1, name: '', bytes: 3, sha256: 'a'.repeat(64) }, { id: 2, name: '', bytes: 4, sha256: 'b'.repeat(64) }] };
  const chosen = [{ name: 'one.bin', bytes: 3, sha256: 'a'.repeat(64) }, { name: 'two.bin', bytes: 4, sha256: 'c'.repeat(64) }]; // two.bin: one byte flipped
  const { items, extras } = pairFiles(sealed, chosen);
  assert.deepEqual(items.map((item) => item.status), ['match', 'missing'], 'not paired by size');
  const v = verdict({ signed: true, trust: { status: 'trusted' }, items, extras });
  assert.deepEqual([v.key, v.headline, v.kind, v.next.text], ['differ-or-missing', 'Files differ or are missing', 'warn', 'Ask for the original files']);
  assert.equal(v.sentence, "1 file you chose doesn't match any item in the list. They may be changed copies or files that weren't sealed.");
  assert.match(verdict({ signed: true, trust: { status: 'trusted' }, items, extras: [...extras, extras[0]] }).sentence, /^2 files you chose don't match/);
  // A named list keeps Incomplete / Not in the list, and a compromised or untrusted signer still wins first.
  assert.equal(verdict({ signed: true, trust: { status: 'trusted' }, items: [{ name: 'a', status: 'missing' }], extras }).key, 'incomplete');
  assert.equal(verdict({ signed: true, trust: { status: 'compromised' }, items, extras }).key, 'compromised');
});

test('offersOriginal: the original file is offered only when the signer is acceptable', () => {
  const offers = (args) => trustModule.offersOriginal?.(verdict({ signed: true, items: [{ status: 'match' }], ...args }));
  assert.equal(offers({ trust: { status: 'trusted' } }), true);
  assert.equal(offers({ trust: { status: 'untrusted' } }), true, 'signer not confirmed, files match');
  assert.equal(offers({ trust: { status: 'compromised' } }), false);
  assert.equal(offers({ trust: { status: 'trusted' }, company: { name: 'Other Co', matches: false } }), false);
  assert.equal(trustModule.offersOriginal?.(verdict({ signed: false, reason: 'bad' })), false);
});

test('manifestReport: every format starts with the Result line', () => {
  const r = manifestReport({ sealedName: 'x.manifest.fseal', trust: { status: 'compromised', entry: { name: 'Old Co', source: 'contract' } }, items: [{ id: 1, name: 'a', bytes: 1, sha256: 'a'.repeat(64), note: '', status: 'match', local: 0 }], extras: [], locals: [{ name: 'a', sha256: 'a'.repeat(64) }] });
  const first = 'Result: Signed by a key marked compromised. ';
  assert.ok(r.text.startsWith(first), r.text.split('\n')[0]);
  assert.ok(r.markdown.startsWith(first), r.markdown.split('\n')[0]);
  assert.ok(JSON.parse(r.json).result.startsWith(first));
  assert.ok(r.pdfLines[0].startsWith(first));
});

// R34: a saved company whose confirmation isn't recorded is neither trusted nor "not in your list".
test('unconfirmed: names the company, says the confirmation isn\'t recorded, warns, and never reads Verified', () => {
  const trust = { status: 'unconfirmed', entry: { name: 'Acme', source: 'not-recorded', addedAt: '' } };
  assert.equal(trustLine(trust, SOURCES), "Signed by a key saved for Acme, but how you confirmed it isn't recorded. Confirm its fingerprint on Trust.");
  assert.equal(trustModule.TRUST_KIND.unconfirmed, 'warn');
  const r = verdict({ signed: true, trust, items: [m('match')] });
  assert.deepEqual([r.key, r.headline], ['signer-not-confirmed', 'Files match · signer not confirmed']);
  assert.equal(verdict({ signed: true, trust: { ...trust, status: 'trusted', entry: { ...trust.entry, confirmedAt: '2026-11-19T00:00:00.000Z' } }, items: [m('match')] }).headline, 'Verified');
  const report = manifestReport({ sealedName: 'x', sources: SOURCES, trust, items: [{ id: 1, name: 'a', bytes: 1, sha256: 'a'.repeat(64), note: '', status: 'match', local: 0 }], locals: [{ name: 'a', sha256: 'a'.repeat(64) }] });
  assert.ok(report.text.startsWith('Result: Files match · signer not confirmed. '));
  const json = JSON.parse(report.json);
  assert.deepEqual([json.keyTrust.status, json.keyTrust.confirmedAt], ['unconfirmed', null]);
});

// R75: no screen or report infers that a signature "predates" a compromise from the (unsigned) seal time.
test('R75: a compromised key with an earlier seal time reads compromised, and no report puts before/after next to compromise', () => {
  const near = /\b(before|after|predat\w*|prior to)\b\W+(?:\w+\W+){0,3}compromis|compromis\w*\W+(?:\w+\W+){0,3}(before|after|predat\w*|prior to)\b/i;
  const trust = { status: 'compromised', entry: { name: 'Old Co', source: 'phone', addedAt: '2025-12-01T00:00:00.000Z', confirmedAt: '2025-12-01T00:00:00.000Z', status: 'compromised', compromisedAt: '2026-06-01T00:00:00.000Z' } };
  const r = manifestReport({ sealedName: 'x.manifest.fseal', sources: SOURCES, keyFingerprint: 'ab'.repeat(32), head: 'cd'.repeat(32), sealedAt: '2026-01-01T00:00:00.000Z', trust, items: [{ id: 1, name: 'a', bytes: 1, sha256: 'a'.repeat(64), note: '', status: 'match', local: 0 }], locals: [{ name: 'a', sha256: 'a'.repeat(64) }] });
  assert.ok(r.text.startsWith('Result: Signed by a key marked compromised. '));
  assert.equal(JSON.parse(r.json).verdict.headline, 'Signed by a key marked compromised');
  for (const [label, out] of [['text', r.text], ['markdown', r.markdown], ['json', r.json], ['pdf', r.pdfLines.join('\n')]]) {
    assert.match(out, /compromised/, label);
    assert.doesNotMatch(out, near, label);
  }
  assert.match('signed before the compromise', near, 'the guard regex catches the wording it forbids');
  assert.match('compromised after it was sealed', near);
});

// AC-37 (design §7.1): the share link's registry record, applied after verdict(). It can only lower a result.
const REC = { head: 'a'.repeat(64), count: 3, key_fingerprint: 'b'.repeat(64), received_at: '2026-11-17T10:00:00Z' };
const RCPT = { head: 'a'.repeat(64), count: '3', fingerprint: 'b'.repeat(64) };
const ITEM = (status) => ({ id: 1, name: 'a', bytes: 1, sha256: 'a'.repeat(64), note: '', status, local: status === 'missing' ? null : 0 });
const RESULTS = {
  verified: verdict({ signed: true, trust: { status: 'trusted', entry: { name: 'Acme', source: 'phone' } }, items: [ITEM('match')] }),
  compromised: verdict({ signed: true, trust: { status: 'compromised', entry: { name: 'Acme' } }, items: [ITEM('match')] }),
  'not-verified': verdict({ signed: false, reason: 'bad' }),
  company: verdict({ signed: true, trust: { status: 'trusted', entry: { name: 'X' } }, company: { name: 'Acme', matches: false } }),
  differ: verdict({ signed: true, trust: { status: 'trusted', entry: { name: 'Acme' } }, items: [ITEM('bytes-differ')] }),
  'differ-or-missing': verdict({ signed: true, trust: { status: 'trusted', entry: { name: 'Acme' } }, items: [{ ...ITEM('missing'), name: '' }], extras: [{ name: 'b' }] }),
  incomplete: verdict({ signed: true, trust: { status: 'trusted', entry: { name: 'Acme' } }, items: [ITEM('missing')] }),
  'not-in-list': verdict({ signed: true, trust: { status: 'trusted', entry: { name: 'Acme' } }, items: [ITEM('match')], extras: [{ name: 'b' }] }),
  'signer-not-confirmed': verdict({ signed: true, trust: { status: 'untrusted' }, items: [ITEM('match')] }),
};
const MISMATCHES = { head: { ...REC, head: 'c'.repeat(64) }, count: { ...REC, count: 4 }, key: { ...REC, key_fingerprint: 'd'.repeat(64) } };

test('applyRegistryRecord: never raises any verdict, for every record outcome', () => {
  for (const [key, result] of Object.entries(RESULTS)) assert.equal(result.key, key === 'company' ? 'not-verified' : key, `fixture ${key}`);
  const rank = { ok: 2, warn: 1, bad: 0 };
  const outcomes = { match: [REC, RCPT], unavailable: [null, RCPT], 'no receipt': [REC, null], ...Object.fromEntries(Object.entries(MISMATCHES).map(([f, r]) => [`${f} differs`, [r, RCPT]])) };
  for (const [key, result] of Object.entries(RESULTS)) {
    for (const [name, [record, receipt]] of Object.entries(outcomes)) {
      const out = applyRegistryRecord(result, record, receipt);
      assert.ok(rank[out.result.kind] <= rank[result.kind], `${key} × ${name}: ${result.kind} → ${out.result.kind}`);
      if (key !== 'verified' || name === 'match' || name === 'unavailable') assert.equal(out.result, result, `${key} × ${name}: unchanged`);
      assert.equal(out.line.label, 'Registry record');
    }
  }
});

test('applyRegistryRecord: a match keeps the headline; each field mismatch lowers Verified; unavailable is information only', () => {
  const match = applyRegistryRecord(RESULTS.verified, REC, RCPT);
  assert.equal(match.result.headline, 'Verified');
  assert.deepEqual(match.line, { label: 'Registry record', value: "Matches the registry's record", kind: 'ok' });
  assert.equal(applyRegistryRecord(RESULTS.verified, REC, { ...RCPT, count: '03' }).result.headline, 'Verified', 'count compared as a number');
  assert.equal(applyRegistryRecord(RESULTS.verified, { ...REC, count: 2 ** 53 - 1 }, { ...RCPT, count: '18446744073709551615' }).result.key, 'link-mismatch', 'large counts never round to equal');
  for (const [field, record] of Object.entries(MISMATCHES)) {
    const out = applyRegistryRecord(RESULTS.verified, record, RCPT);
    assert.equal(out.result.key, 'link-mismatch', field);
    assert.equal(out.result.headline, "Files match · doesn't match the link", field);
    assert.equal(out.result.kind, 'warn', field);
    assert.deepEqual(out.line, { label: 'Registry record', value: "Doesn't match the registry's record for this link", kind: 'warn' }, field);
  }
  assert.equal(applyRegistryRecord(RESULTS.verified, REC, null).result.key, 'link-mismatch', 'no receipt line is a mismatch, never a match');
  const gone = applyRegistryRecord(RESULTS.verified, null, RCPT);
  assert.equal(gone.result, RESULTS.verified);
  assert.deepEqual(gone.line, { label: 'Registry record', value: "This link was withdrawn or couldn't be checked", kind: 'info' });
  const kept = applyRegistryRecord(RESULTS.compromised, MISMATCHES.head, RCPT);
  assert.equal(kept.result.headline, 'Signed by a key marked compromised');
  assert.equal(kept.line.kind, 'warn');
});

test('manifestReport with the record step: the Result line equals the lowered headline in every format, with the record line', () => {
  const args = { sealedName: 'x.manifest.fseal', sources: SOURCES, keyFingerprint: 'b'.repeat(64), head: 'a'.repeat(64), trust: { status: 'trusted', entry: { name: 'Acme', source: 'phone' } }, items: [ITEM('match')], extras: [], locals: [{ name: 'a', sha256: 'a'.repeat(64) }] };
  const cases = [
    [REC, 'Verified', "Matches the registry's record"],
    [MISMATCHES.head, "Files match · doesn't match the link", "Doesn't match the registry's record for this link"],
    [null, 'Verified', "This link was withdrawn or couldn't be checked"],
  ];
  for (const [record, headline, value] of cases) {
    const screen = applyRegistryRecord(verdict({ signed: true, trust: args.trust, items: args.items, extras: [] }), record, RCPT).result;
    assert.equal(screen.headline, headline);
    const r = manifestReport({ ...args, applyRecord: (result) => applyRegistryRecord(result, record, RCPT) });
    const result = `Result: ${headline}. ${screen.sentence}`;
    const line = `Registry record: ${value}`;
    assert.deepEqual(r.text.split('\n').slice(0, 2), [result, line]);
    assert.ok(r.markdown.startsWith(`${result}\n\n${line}\n\n`));
    assert.deepEqual(r.pdfLines.slice(0, 2), [result, line]);
    const json = JSON.parse(r.json);
    assert.equal(json.result, result);
    assert.equal(json.verdict.headline, headline);
    assert.equal(json.record.value, value);
  }
  const plain = manifestReport(args);
  assert.ok(!plain.text.includes('Registry record') && !('record' in JSON.parse(plain.json)), 'no link, no record line');
});
