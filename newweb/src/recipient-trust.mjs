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
/** Every time a recipient sees, with where it came from. */
export function timeFields({ landing = '', landingSigned = false, sealedAt = '' } = {}) {
  return [
    { label: 'Reported landing time', value: landing || 'Not entered', basis: landing ? (landingSigned ? 'operator-entered, signed, not verified' : 'operator-entered, not signed, not verified') : 'not entered by the operator' },
    { label: 'Sealed on this computer at', value: sealedAt || 'Unknown', basis: SEALED_BASIS },
    { label: 'Registry acceptance', value: 'Not registered', basis: 'no registry was used' },
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

/** trust: { status: trusted|untrusted|replaced|compromised|wrong-key|invalid-signature, entry? } */
export function trustLine(trust, sources = {}) {
  const entry = trust?.entry;
  switch (trust?.status) {
    case 'trusted': return `Signed by a key you trust: ${entry.name} (added from ${sources[entry.source] || entry.source})`;
    case 'compromised': return `Signed by a key you marked as compromised: ${entry.name}. Don't rely on this proof without checking with the company.`;
    case 'replaced': return `Signed by a key that was replaced for ${entry.name} on ${String(entry.replacedAt || '').slice(0, 10) || 'an unknown date'}. Ask the company whether proofs from that key are still valid.`;
    case 'wrong-key': return "Not signed by the key you chose. Don't rely on this proof.";
    case 'invalid-signature': return "The signature doesn't match. Don't rely on this proof.";
    default: return "Valid signature, but this key isn't in your trusted list — confirm its fingerprint through a channel you already know.";
  }
}
export const TRUST_KIND = { trusted: 'ok', untrusted: 'warn', replaced: 'warn', compromised: 'bad', 'wrong-key': 'bad', 'invalid-signature': 'bad' };

export const BYTES_DIFFER = Object.freeze({
  title: 'Bytes differ',
  text: "This file's bytes are not the ones that were sealed. Editing, re-saving, metadata changes, recompression, truncation or corruption can cause this. It is not proof of tampering, and HashWing doesn't pick a cause. Ask for the original file, or an archive that keeps the original bytes.",
});

const groups = (hex) => String(hex || '').match(/.{1,4}/g)?.join(' ') || '';
const STATUS = { match: 'Matches', 'bytes-differ': 'Bytes differ', missing: 'Missing', 'not-in-manifest': 'Not in manifest' };

/** Report for a verified manifest check. items: compareFiles items; locals: hashed local files. */
export function manifestReport({ sealedName = '', trust, sources = {}, keyFingerprint = '', head = '', sealedAt = '', items = [], extras = [], locals = [] }) {
  const parsed = items.map((item) => ({ ...item, ...parseNote(item.note) }));
  const landings = [...new Set(parsed.map((item) => item.landing).filter(Boolean))];
  const fields = timeFields({ landing: landings.length === 1 ? landings[0] : landings.length ? 'Differs by item (see items)' : '', landingSigned: true, sealedAt });
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
  const extraLines = extras.map((extra) => `Not in manifest: ${extra.name} (${extra.bytes} bytes, SHA-256 ${extra.sha256})`);
  const text = [
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
  const markdown = `# HashWing manifest check report\n\n${[
    `- Sealed list: ${sealedName}`, '- Manifest: verified (signature checked)', `- Key trust: ${line}`,
    ...(entry ? [`- Key source: ${sources[entry.source] || entry.source}`] : []), `- Key fingerprint: \`SHA-256 ${groups(keyFingerprint)}\``, `- Chain head: \`${head}\``,
  ].join('\n')}\n\n## Times\n\n${fields.map((field) => `- ${field.label}: ${field.value} (${field.basis})`).join('\n')}\n\n## Files\n\n${[...itemLines, ...extraLines].map((l) => (l.startsWith('  ') ? `  - ${l.trim()}` : `- ${l}`)).join('\n')}\n${differs ? `\n## ${BYTES_DIFFER.title}\n\n${BYTES_DIFFER.text}\n` : ''}`;
  const keyTrust = { status: trust?.status || 'untrusted', line, company: entry?.name ?? null, source: entry?.source ?? null, sourceLabel: entry ? (sources[entry.source] || entry.source) : null, addedAt: entry?.addedAt || null, replacedAt: entry?.replacedAt || null, compromisedAt: entry?.compromisedAt || null, fingerprint: keyFingerprint || null };
  const json = JSON.stringify({
    kind: 'hashwing-manifest-check', sealedFile: sealedName, manifestVerified: true, head, keyTrust,
    timeProvenance: { fields, intervalMs: reportedInterval(landings.length === 1 ? landings[0] : '', sealedAt).ms },
    fileComparison: {
      items: parsed.map((item) => ({ id: item.id, status: item.status, statusLabel: STATUS[item.status], name: item.name, bytes: item.bytes, sha256: item.sha256, localName: item.local == null ? null : locals[item.local]?.name ?? null, localSha256: item.local == null ? null : locals[item.local]?.sha256 ?? null, reportedLanding: item.landing || null, derivedFrom: item.derivedFrom || null, note: item.note })),
      extras: extras.map((extra) => ({ name: extra.name, bytes: extra.bytes, sha256: extra.sha256, status: 'not-in-manifest' })),
      bytesDiffer: differs ? BYTES_DIFFER : null,
    },
    report: text,
  }, null, 2);
  const pdfLines = [
    `Sealed list: ${sealedName}`, 'Manifest: verified (signature checked)', `Key trust: ${line}`,
    ...(entry ? [`Key source: ${sources[entry.source] || entry.source}`] : []), `Key fingerprint: SHA-256 ${groups(keyFingerprint)}`, `Chain head: ${head}`,
    '## Times', ...fields.map((field) => `${field.label}: ${field.value} (${field.basis})`),
    '## Files', ...itemLines.map((l) => l.trim()), ...extraLines,
    ...(differs ? [`## ${BYTES_DIFFER.title}`, BYTES_DIFFER.text] : []),
  ];
  return { text, markdown, json, pdfLines, fields };
}
