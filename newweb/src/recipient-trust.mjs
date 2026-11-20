// Pure helpers for what a recipient sees: signed note tags, where each time comes from, key-trust wording and the
// neutral "Bytes differ" text. No storage, no network, no imports, so it is safe to unit-test and to bundle.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const validIso = (value) => typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value));
const TAGS = /^(?:\[reported-landing=([^\][]*)\])?(?:\[derived-from=([^\][]*)\])?(?: ([\s\S]*))?$/;

/** `[reported-landing=<ISO>][derived-from=<text>] <note>`; plain note when there are no tags. */
export function composeNote({ landing = '', derivedFrom = '', note = '', edited = false } = {}) {
  const from = String(derivedFrom || '').trim();
  const text = String(note || '');
  if (edited && !from) throw Object.assign(new Error('You ticked “This is an edited copy”. Fill in “Derived from” under More options, or untick it.'), { code: 'note-tag' });
  if (landing && !validIso(landing)) throw Object.assign(new Error('Enter the reported landing time as a full date and time.'), { code: 'note-tag' });
  if (/[[\]]/.test(from)) throw Object.assign(new Error('“Derived from” can’t contain [ or ]. Use the item number or the SHA-256 fingerprint.'), { code: 'note-tag' });
  const tags = `${landing ? `[reported-landing=${landing}]` : ''}${from ? `[derived-from=${from}]` : ''}`;
  if (!tags) {
    if (/^\[(?:reported-landing|derived-from)=/.test(text)) throw Object.assign(new Error('A note can’t start with [reported-landing= or [derived-from=. Use the fields under More options instead.'), { code: 'note-tag' });
    return text;
  }
  return text ? `${tags} ${text}` : tags;
}

/** Inverse of composeNote. Anything that is not exactly the two tags stays a plain note. */
export function parseNote(value) {
  const text = String(value ?? '');
  if (!text.startsWith('[reported-landing=') && !text.startsWith('[derived-from=')) return { note: text };
  const m = TAGS.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined) || (m[1] !== undefined && !validIso(m[1])) || m[2] === '') return { note: text };
  return { ...(m[1] !== undefined ? { landing: m[1] } : {}), ...(m[2] !== undefined ? { derivedFrom: m[2] } : {}), note: m[3] ?? '' };
}

/** A `<input type="datetime-local">` value (this computer's time zone) to a UTC ISO string, or ''. */
export function toIsoFromLocal(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(String(value || ''))) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function duration(ms) {
  let s = Math.floor(Math.abs(ms) / 1000);
  const parts = [];
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['min', 60]]) {
    if (s >= size || parts.length) { parts.push(`${Math.floor(s / size)} ${unit}`); s %= size; }
  }
  parts.push(`${s} s`);
  return parts.join(' ');
}

/** Seal time minus reported landing time. A negative value stays negative: it means one of the times is wrong. */
export function reportedInterval(landingIso, sealedIso) {
  if (!validIso(landingIso) || !validIso(sealedIso)) return { ms: null, text: 'Unknown' };
  const ms = Date.parse(sealedIso) - Date.parse(landingIso);
  if (ms < 0) return { ms, text: `-${duration(ms)} (reported landing is after the seal time, so one of the two times is wrong)` };
  return { ms, text: `${duration(ms)} from the reported landing to the seal` };
}

export const SEALED_BASIS = "this computer's clock, not verified; from the receipt message, not signed";
/** Every time a recipient sees, with where it came from. `registry` ({ value, basis }) replaces the registry row
 * when the console is built with a registry (registry-ui.jsx registryTimeField); without one, no registry was used. */
export function timeFields({ landing = '', landingSigned = false, sealedAt = '', registry = null } = {}) {
  return [
    { label: 'Reported landing time', value: landing || 'Not entered', basis: landing ? (landingSigned ? 'operator-entered, signed, not verified' : 'operator-entered, not signed, not verified') : 'not entered by the operator' },
    { label: 'Sealed on this computer at', value: sealedAt || 'Unknown', basis: SEALED_BASIS },
    { label: 'Registry acceptance', ...(registry ? { value: registry.value, basis: registry.basis } : { value: 'Not registered', basis: 'no registry was used' }) },
    { label: 'Trusted timestamp', value: 'None', basis: 'receipt v1 has no signed time' },
    { label: 'Reported landing-to-seal interval', value: reportedInterval(landing, sealedAt).text, basis: 'worked out from the two times above; it is only as good as they are' },
  ];
}

const unquote = (text) => String(text || '').split(/\r?\n/).map((line) => line.replace(/^[>\s]+/, '')).join('\n');
const isoAfter = (label) => (text) => {
  const m = new RegExp(`^${label}:\\s*(\\S+)`, 'm').exec(unquote(text));
  return m && validIso(m[1]) ? m[1] : '';
};
/** The `Sealed:` time from a handover message (unsigned). */
export const parseSealedLine = isoAfter('Sealed');
/** The embedded-mode `Reported landing time:` line (unsigned). */
export const parseLandingLine = isoAfter('Reported landing time');
export const landingLine = (iso) => `Reported landing time: ${iso} (operator-entered, not signed, not verified)`;

/** trust: { status: trusted|unconfirmed|untrusted|replaced|compromised|wrong-key|invalid-signature, entry? } */
export function trustLine(trust, sources = {}) {
  const entry = trust?.entry;
  switch (trust?.status) {
    case 'trusted':
      if (PILOT_AUTHORIZATION_ACCEPTED && trust.via === 'pilot') return `Signed by a pilot key that ${entry.name} authorized until ${String(trust.notAfter || '').slice(0, 10)}`;
      return `Signed by a key you trust: ${entry.name} (added from ${sources[entry.source] || entry.source})`;
    case 'unconfirmed': return `Signed by a key saved for ${entry.name}, but how you confirmed it isn't recorded. Confirm its fingerprint on Trust.`;
    case 'compromised':
      if (PILOT_AUTHORIZATION_ACCEPTED && trust.listed) return `Signed by a key you marked as compromised on ${String(trust.compromisedAt || '').slice(0, 10)}. Don't rely on this proof without checking with the company.`;
      return `Signed by a key you marked as compromised: ${entry.name}. Don't rely on this proof without checking with the company.`;
    case 'replaced': return `Signed by a key that was replaced for ${entry.name} on ${String(entry.replacedAt || '').slice(0, 10) || 'an unknown date'}. Ask the company whether proofs from that key are still valid.`;
    case 'weak': return "This public key is weak and can't prove anything"; // docs/verifier.js WEAK_KEY_MESSAGE
    case 'wrong-key': return "Not signed by the key you chose. Don't rely on this proof.";
    case 'invalid-signature': return "The signature doesn't match. Don't rely on this proof.";
    default:
      if (PILOT_AUTHORIZATION_ACCEPTED && trust?.reason === 'authorization-ended') return `The company's authorization for this pilot key ended on ${String(trust.notAfter || '').slice(0, 10)}. Ask the company.`;
      return "Valid signature, but this key isn't in your trusted list — confirm its fingerprint through a channel you already know.";
  }
}
export const TRUST_KIND = { trusted: 'ok', unconfirmed: 'warn', untrusted: 'warn', replaced: 'warn', compromised: 'bad', 'wrong-key': 'bad', 'invalid-signature': 'bad', weak: 'bad' };

export const BYTES_DIFFER = Object.freeze({
  title: 'Bytes differ',
  text: "This file's bytes are not the ones that were sealed. Editing, re-saving, metadata changes, recompression, truncation or corruption can cause this. It is not proof of tampering, and HashWing doesn't pick a cause. Ask for the original file, or an archive that keeps the original bytes.",
});

const groups = (hex) => String(hex || '').match(/.{1,4}/g)?.join(' ') || '';
export const NOT_IN_LIST = 'Not in the list'; // the one name for extra files (EXPERIENCE.md "Verify verdicts"); the status key stays not-in-manifest
const STATUS = { match: 'Matches', 'bytes-differ': 'Bytes differ', missing: 'Missing', 'not-in-manifest': NOT_IN_LIST };

/**
 * OWNER DECISION 1 (decided by the owner 2026-11-18: keep strict). true: green "Verified" needs a key on
 * this device's trusted list, so complete files from an unpinned, replaced or one-time key read
 * "Files match · signer not confirmed". false: complete files read "Verified" whatever the key (the key trust line
 * still qualifies it). This is the one switch; nothing else reads the decision.
 */
export const VERIFIED_NEEDS_TRUSTED_KEY = true;

/**
 * Signing Option B (design §7.2), client switch. false: an `Authorized by company key:` line in a receipt message is
 * ignored and a pilot-signed proof reads "Files match · signer not confirmed". true: trusted-keys.mjs trustForProof
 * checks it against a confirmed pin with pilotKeys on. A build constant, so the bundler drops every pilot path while it
 * is false; tests flip it only by rewriting this line through a Vite plugin. The owner turns it on with PILOT_KEYS_ORGS.
 */
export const PILOT_AUTHORIZATION_ACCEPTED = false;

/**
 * Step 6 (Verify with a chosen company or a typed company key): a pilot proof counts for that company only when
 * trustForProof said trusted via pilot under a pin with exactly that fingerprint (`companyFingerprint`), or whose
 * signed statement names exactly that key (`companyKey`, 64 hex). Fails closed otherwise, and always with the switch off.
 */
export function pilotAccepted(trust, { companyFingerprint = '', companyKey = '' } = {}) {
  if (!PILOT_AUTHORIZATION_ACCEPTED || trust?.status !== 'trusted' || trust.via !== 'pilot' || (!companyFingerprint && !companyKey)) return false;
  if (companyFingerprint && trust.entry?.fingerprint !== companyFingerprint) return false;
  if (companyKey && trust.companyKey !== String(companyKey).trim().toLowerCase()) return false;
  return true;
}
/** Milliseconds until a pilot authorization ends (for re-checking an open result), clamped to setTimeout's range; null otherwise. */
export function pilotRecheckDelay(trust, now = Date.now()) {
  if (!PILOT_AUTHORIZATION_ACCEPTED || trust?.via !== 'pilot' || !trust.notAfter) return null;
  const at = Date.parse(trust.notAfter);
  return Number.isNaN(at) ? null : Math.min(Math.max(at - now + 1000, 0), 2 ** 31 - 1);
}

export const NOT_VERIFIED_NEXT = 'Check that you chose the right sealed file, pasted the whole receipt message, and entered the key the sender gave you separately.';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The Verify headline, first row that applies wins (EXPERIENCE.md "Verify verdicts"). signed: the signature checked
 * out against the key used; reason: why not, when it didn't. items/extras: pairFiles output (status keys);
 * coverage: { covered, total } receipt coverage or null. next.action: 'trust' | 'originals' | 'report' | null.
 */
/** company: { name, matches } when the recipient chose a trusted company; a signer that isn't it is Not verified, after compromised. */
export function verdict({ signed, reason = '', trust, items = [], extras = [], coverage = null, company = null }) {
  const status = trust?.status || 'untrusted';
  if (signed && status === 'compromised') return { key: 'compromised', headline: 'Signed by a key marked compromised', kind: 'bad', sentence: "This key was reported as compromised. Don't rely on these files until the company confirms them.", next: { text: 'Ask the company for a new seal', action: null } };
  if (company && !company.matches) return { key: 'not-verified', headline: 'Not verified', kind: 'bad', sentence: `Not signed by ${company.name}'s key. Don't rely on this proof.`, next: { text: NOT_VERIFIED_NEXT, action: null } };
  const keyFailed = ['wrong-key', 'invalid-signature', 'weak'].includes(status);
  if (!signed || keyFailed) return { key: 'not-verified', headline: 'Not verified', kind: 'bad', sentence: keyFailed ? trustLine({ status }) : reason, next: { text: NOT_VERIFIED_NEXT, action: null } };
  const count = (s) => items.filter((item) => item.status === s).length;
  if (count('bytes-differ')) return { key: 'differ', headline: 'Files differ', kind: 'warn', sentence: BYTES_DIFFER.text, next: { text: 'Ask for the original files', action: null } };
  const missing = count('missing');
  // Items sealed without a name pair only by size and SHA-256, so a changed copy reads as missing plus a file not in
  // the list. HashWing doesn't guess which chosen file was meant to be which item (AC-55).
  if (extras.length && items.some((item) => item.status === 'missing' && !item.name)) return { key: 'differ-or-missing', headline: 'Files differ or are missing', kind: 'warn', sentence: `${extras.length === 1 ? "1 file you chose doesn't" : `${extras.length} files you chose don't`} match any item in the list. They may be changed copies or files that weren't sealed.`, next: { text: 'Ask for the original files', action: null } };
  if (missing || (coverage && Number(coverage.covered) < Number(coverage.total))) return { key: 'incomplete', headline: 'Incomplete', kind: 'warn', sentence: missing ? `${count('match')} of ${plural(items.length, 'file was', 'files were')} checked. A file that is missing can't be checked.` : `Receipts cover ${coverage.covered} of ${coverage.total} items.`, next: { text: 'Add the missing originals', action: missing ? 'originals' : null } };
  if (extras.length) return { key: 'not-in-list', headline: NOT_IN_LIST, kind: 'warn', sentence: `Every listed file matches. ${extras.length === 1 ? "1 other file you chose isn't in the list and was not checked." : `${extras.length} other files you chose aren't in the list and were not checked.`}`, next: { text: "Remove files that aren't in the list", action: 'originals' } };
  if (VERIFIED_NEEDS_TRUSTED_KEY && status !== 'trusted') return { key: 'signer-not-confirmed', headline: 'Files match · signer not confirmed', kind: 'warn', sentence: "The files match what was sealed, but you haven't confirmed who sealed them.", next: { text: "Confirm the company's fingerprint on Trust", action: 'trust' } };
  return { key: 'verified', headline: 'Verified', kind: 'ok', sentence: status === 'trusted' ? 'Every file matches what was sealed, signed by a company you trust.' : 'Every file matches what was sealed.', next: { text: 'Download report', action: 'report' } };
}

/**
 * AC-37 (design §7.1): the share link's registry record against the checked receipt, run after verdict(). It can only
 * lower a result: a mismatch turns Verified into "Files match · doesn't match the link"; every other result, a match
 * and an unavailable record leave the result as it was. record: { head, count, key_fingerprint } or null when the link
 * was withdrawn or couldn't be checked; receipt: { head, count (decimal string), fingerprint } of the receipt line the
 * registry got, or null. Returns { result, line: { label, value, kind } }. Called only from registry-on code, so the
 * flag-off build drops it and its strings.
 */
export function applyRegistryRecord(result, record, receipt) {
  const label = 'Registry record';
  if (!record) return { result, line: { label, value: "This link was withdrawn or couldn't be checked", kind: 'info' } };
  let same = false;
  try { same = !!receipt && record.head === receipt.head && record.key_fingerprint === receipt.fingerprint && BigInt(record.count) === BigInt(receipt.count); } catch { same = false; }
  // Green only under Verified: a match beside any other headline is information, never a mixed signal.
  if (same) return { result, line: { label, value: "Matches the registry's record", kind: result?.key === 'verified' ? 'ok' : 'info' } };
  const line = { label, value: "Doesn't match the registry's record for this link", kind: 'warn' };
  if (result?.key !== 'verified') return { result, line };
  return { result: { key: 'link-mismatch', headline: "Files match · doesn't match the link", kind: 'warn', sentence: "The files match what was sealed, but not the registry's record for the link you opened. The link may belong to other files.", next: { text: 'Ask the sender for the right link', action: null } }, line };
}

/** The original file is offered only when the signer is acceptable: never under compromised, Not verified or a company mismatch. */
export const offersOriginal = (result) => !!result && !['compromised', 'not-verified'].includes(result.key);

/** "12 match · 1 differs · 1 missing · 0 not in the list" */
export function countsLine(items = [], extras = []) {
  const n = (s) => items.filter((item) => item.status === s).length;
  return `${n('match')} match · ${n('bytes-differ')} ${n('bytes-differ') === 1 ? 'differs' : 'differ'} · ${n('missing')} missing · ${extras.length} not in the list`;
}

/**
 * Pairing for Verify (AC-55): a named item pairs with the chosen file of the same name, so a renamed byte-identical
 * file reads Missing plus Not in the list; an item sealed without a name pairs by size and SHA-256. Throws an Error
 * with the user-facing sentence for the two ambiguous cases. locals: [{ name, bytes, sha256 }] in selection order.
 * ponytail: matches by name only; folder picks (relative paths) are not offered, add path keys if they are.
 */
export function pairFiles(manifest, locals) {
  const seen = new Set();
  for (const local of locals) { if (seen.has(local.name)) throw new Error(`Two chosen files have the same path: ${local.name}. Choose one.`); seen.add(local.name); }
  const folders = new Map();
  for (const item of manifest.items) {
    if (!item.name) continue;
    const base = item.name.split('/').pop();
    if (folders.has(base) && folders.get(base) !== item.name) throw new Error(`The list has two files named ${base} in different folders. Choose the folder instead of single files so each can be matched.`);
    folders.set(base, item.name);
  }
  const items = manifest.items.map((item) => ({ ...item, status: null, local: null }));
  const used = new Set();
  const take = (item, test) => {
    const index = locals.findIndex((local, i) => !used.has(i) && test(local));
    if (index < 0) return;
    used.add(index); item.local = index;
    item.status = locals[index].bytes === item.bytes && locals[index].sha256 === item.sha256 ? 'match' : 'bytes-differ';
  };
  for (const item of items) if (item.name) take(item, (local) => local.name === item.name.split('/').pop());
  for (const item of items) if (!item.name) take(item, (local) => local.bytes === item.bytes && local.sha256 === item.sha256);
  for (const item of items) if (item.status === null) item.status = 'missing';
  const extras = locals.flatMap((local, index) => used.has(index) ? [] : [{ local: index, name: local.name, bytes: local.bytes, sha256: local.sha256, status: 'not-in-manifest' }]);
  return { items, extras, allMatch: !extras.length && items.every((item) => item.status === 'match') };
}

/** Report for a verified manifest check. items: compareFiles items; locals: hashed local files. */
/** applyRecord: optional (result) => applyRegistryRecord(...) closure, built only in registry-on code. */
export function manifestReport({ sealedName = '', trust, sources = {}, keyFingerprint = '', head = '', sealedAt = '', items = [], extras = [], locals = [], registry = null, applyRecord = null }) {
  const checked = verdict({ signed: true, trust, items, extras });
  const { result, line: record } = applyRecord ? applyRecord(checked) : { result: checked, line: null };
  const resultLine = `Result: ${result.headline}. ${result.sentence}`;
  const recordLines = record ? [`${record.label}: ${record.value}`] : [];
  const parsed = items.map((item) => ({ ...item, ...parseNote(item.note) }));
  const landings = [...new Set(parsed.map((item) => item.landing).filter(Boolean))];
  const fields = timeFields({ landing: landings.length === 1 ? landings[0] : landings.length ? 'Differs by item (see items)' : '', landingSigned: true, sealedAt, registry });
  if (landings.length > 1) fields[4] = { ...fields[4], value: 'See items' };
  const line = trustLine(trust, sources);
  const entry = trust?.entry;
  const differs = parsed.some((item) => item.status === 'bytes-differ');
  const itemLines = parsed.map((item) => [
    `Item ${item.id}: ${STATUS[item.status]}`,
    `  Name in manifest: ${item.name || 'not included'}`,
    `  Size: ${item.bytes} bytes`,
    `  SHA-256 (sealed): ${item.sha256}`,
    ...(item.local == null ? [] : [`  Local file: ${locals[item.local]?.name ?? ''}`, `  Local SHA-256: ${locals[item.local]?.sha256 ?? ''}`]),
    ...(item.landing && landings.length > 1 ? [`  Reported landing time: ${item.landing} (operator-entered, signed, not verified)`] : []),
    ...(item.derivedFrom ? [`  Edited copy of: ${item.derivedFrom} (operator-entered, signed)`] : []),
    ...(item.note ? [`  Operator note: ${item.note}`] : []),
    ...(item.status === 'bytes-differ' ? [`  ${BYTES_DIFFER.title}: ${BYTES_DIFFER.text}`] : []),
  ]).flat();
  const extraLines = extras.map((extra) => `${NOT_IN_LIST}: ${extra.name} (${extra.bytes} bytes, SHA-256 ${extra.sha256})`);
  const text = [ // every report starts with the Result line, the same words as the headline on screen
    resultLine,
    ...recordLines,
    `HashWing manifest check report: ${sealedName}`,
    'Manifest: verified (signature checked)',
    `Key trust: ${line}`,
    ...(entry ? [`Key source: ${sources[entry.source] || entry.source}`] : []),
    `Key fingerprint: SHA-256 ${groups(keyFingerprint)}`,
    `Chain head: ${head}`,
    '',
    'Times:',
    ...fields.map((field) => `  ${field.label}: ${field.value} (${field.basis})`),
    '',
    'Files:',
    ...[...itemLines, ...extraLines].map((l) => `  ${l}`),
    ...(differs ? ['', `${BYTES_DIFFER.title}: ${BYTES_DIFFER.text}`] : []),
    '',
    'Names, sizes and digests come from the signed manifest. Operator notes and times are what the operator entered; HashWing did not measure them.',
  ].join('\n') + '\n';
  const markdown = `${[resultLine, ...recordLines].join('\n\n')}\n\n# HashWing manifest check report\n\n${[
    `- Sealed list: ${sealedName}`, '- Manifest: verified (signature checked)', `- Key trust: ${line}`,
    ...(entry ? [`- Key source: ${sources[entry.source] || entry.source}`] : []), `- Key fingerprint: \`SHA-256 ${groups(keyFingerprint)}\``, `- Chain head: \`${head}\``,
  ].join('\n')}\n\n## Times\n\n${fields.map((field) => `- ${field.label}: ${field.value} (${field.basis})`).join('\n')}\n\n## Files\n\n${[...itemLines, ...extraLines].map((l) => (l.startsWith('  ') ? `  - ${l.trim()}` : `- ${l}`)).join('\n')}\n${differs ? `\n## ${BYTES_DIFFER.title}\n\n${BYTES_DIFFER.text}\n` : ''}`;
  const keyTrust = { status: trust?.status || 'untrusted', line, company: entry?.name ?? null, source: entry?.source ?? null, sourceLabel: entry ? (sources[entry.source] || entry.source) : null, addedAt: entry?.addedAt || null, confirmedAt: entry?.confirmedAt || null, replacedAt: entry?.replacedAt || null, compromisedAt: trust?.compromisedAt || entry?.compromisedAt || null, fingerprint: keyFingerprint || null };
  const json = JSON.stringify({
    result: resultLine, kind: 'hashwing-manifest-check', sealedFile: sealedName, verdict: { key: result.key, headline: result.headline, sentence: result.sentence }, ...(record ? { record } : {}), manifestVerified: true, head, keyTrust,
    timeProvenance: { fields, intervalMs: reportedInterval(landings.length === 1 ? landings[0] : '', sealedAt).ms },
    fileComparison: {
      items: parsed.map((item) => ({ id: item.id, status: item.status, statusLabel: STATUS[item.status], name: item.name, bytes: item.bytes, sha256: item.sha256, localName: item.local == null ? null : locals[item.local]?.name ?? null, localSha256: item.local == null ? null : locals[item.local]?.sha256 ?? null, reportedLanding: item.landing || null, derivedFrom: item.derivedFrom || null, note: item.note })),
      extras: extras.map((extra) => ({ name: extra.name, bytes: extra.bytes, sha256: extra.sha256, status: 'not-in-manifest' })),
      bytesDiffer: differs ? BYTES_DIFFER : null,
    },
    report: text,
  }, null, 2);
  const pdfLines = [
    resultLine, ...recordLines, `Sealed list: ${sealedName}`, 'Manifest: verified (signature checked)', `Key trust: ${line}`,
    ...(entry ? [`Key source: ${sources[entry.source] || entry.source}`] : []), `Key fingerprint: SHA-256 ${groups(keyFingerprint)}`, `Chain head: ${head}`,
    '## Times', ...fields.map((field) => `${field.label}: ${field.value} (${field.basis})`),
    '## Files', ...itemLines.map((l) => l.trim()), ...extraLines,
    ...(differs ? [`## ${BYTES_DIFFER.title}`, BYTES_DIFFER.text] : []),
  ];
  return { text, markdown, json, pdfLines, fields };
}
