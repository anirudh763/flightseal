// Pilot key authorizations (signing Option B, design §4.2): the browser twin of registry/registry/pilot_authorization.py.
// Same format, same reasons in the same order; tests/fixtures/pilot-authorization.json is checked by both.
import { ed25519Verify, weakPublicKey } from '../../docs/verifier.js';

export const PREFIX = 'hashwing-pilot-authorization v1';
export const LINE_PREFIX = 'Authorized by company key: ';
export const MAX_DAYS = 30;
const DAY = 86400;
const B64 = /^[A-Za-z0-9_-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/;

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (b) => Number.parseInt(b, 16));
const pad = (n, w = 2) => String(n).padStart(w, '0');
/** Epoch seconds to `YYYY-MM-DDTHH:MM:SSZ`. */
export function iso(t) {
  const d = new Date(t * 1000);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}
const statementText = (pilotKey, companyKey, notAfter) => [PREFIX, `pilot_key=${toHex(pilotKey)}`, `company_key=${toHex(companyKey)}`, `not_after=${iso(notAfter)}`].join('\n');
const encode = (text) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Curve membership, as registry/registry/ed25519.py _recover_x: weakPublicKey in docs/verifier.js catches small-order
// and non-canonical keys but not a y whose x is not on the curve.
const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
function powMod(b, e) {
  let r = 1n; b %= P;
  for (; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
  return r;
}
function onCurve(key) {
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(key[i]);
  const y = n & ((1n << 255n) - 1n), sign = n >> 255n;
  if (y >= P) return false;
  const x2 = (((y * y - 1n) % P + P) % P) * powMod((D * y * y + 1n) % P, P - 2n) % P;
  if (x2 === 0n) return sign === 0n;
  return powMod(x2, (P - 1n) / 2n) === 1n; // Euler: x² has a square root
}
export const weakKey = (key) => key.length !== 32 || weakPublicKey(key) || !onCurve(key);

/** { pilotKey, companyKey (Uint8Array), notAfter (epoch seconds) }, or null unless it is the canonical encoding of a
 * canonical statement (rebuilt and compared character for character, like the Python). */
export function parse(b64) {
  if (typeof b64 !== 'string' || !B64.test(b64)) return null;
  let text;
  try { text = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4)); } catch { return null; }
  if (/[^\x00-\x7f]/.test(text)) return null;
  const lines = text.split('\n');
  if (lines.length !== 4 || lines[0] !== PREFIX) return null;
  const fields = {};
  for (const [i, name] of ['pilot_key', 'company_key', 'not_after'].entries()) {
    if (!lines[i + 1].startsWith(`${name}=`)) return null;
    fields[name] = lines[i + 1].slice(name.length + 1);
  }
  const m = DATE.exec(fields.not_after);
  // Years below 1000 are refused as malformed (Date.UTC maps 0-99 to 19xx, and no real authorization is that old).
  if (!HEX64.test(fields.pilot_key) || !HEX64.test(fields.company_key) || !m || +m[1] < 1000) return null;
  const notAfter = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  if (!Number.isFinite(notAfter)) return null;
  const auth = { pilotKey: fromHex(fields.pilot_key), companyKey: fromHex(fields.company_key), notAfter };
  if (encode(statementText(auth.pilotKey, auth.companyKey, auth.notAfter)) !== b64) return null; // second 60, years < 100, loose bits
  return auth;
}

/** The signed bytes of a statement (company computer, design §6): built here only, never taken from a paste. */
export const statementBytes = (pilotKey, companyKey, notAfter) => new TextEncoder().encode(statementText(pilotKey, companyKey, notAfter));
export const toLine = (b64, sig) => `${LINE_PREFIX}${b64}.${sig}`;
/** Days-from-now lifetime, 10 minutes short so a clock a few minutes ahead of the registry never runs past 30 days. */
export const notAfterFor = (days, nowSec) => Math.floor(nowSec) + days * DAY - 600;

/**
 * The company computer's one builder: signs the statement for `pilotKey` under `companyKey` with `sign(bytes) -> hex`,
 * then checks the result round-trips through check() before returning the line. Throws Error(reason) otherwise.
 */
export async function authorize(pilotKey, companyKey, notAfter, sign, nowSec) {
  if (weakKey(pilotKey)) throw new Error('weak_pilot_key');
  if (same(pilotKey, companyKey)) throw new Error('same_key');
  const b64 = encode(statementText(pilotKey, companyKey, notAfter));
  const sig = await sign(statementBytes(pilotKey, companyKey, notAfter));
  const { reason } = await check(b64, sig, pilotKey, companyKey, nowSec);
  if (reason) throw new Error(reason);
  return toLine(b64, sig);
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** { reason, auth }: reason null when it holds, else the first failing one in the Python's order. `pilotKey` is the
 * key that must be authorized; `companyKey` the expected company key, or null when the caller compares it itself;
 * `now` the verifier's own clock in epoch seconds, never a time from the proof. */
export async function check(b64, sig, pilotKey, companyKey, now) {
  const auth = parse(b64);
  if (!auth || typeof sig !== 'string' || !HEX128.test(sig)) return { reason: 'malformed', auth: null };
  if (weakKey(auth.pilotKey)) return { reason: 'weak_pilot_key', auth };
  if (same(auth.pilotKey, auth.companyKey)) return { reason: 'same_key', auth };
  if (!same(auth.pilotKey, pilotKey)) return { reason: 'not_pilot_key', auth };
  const signed = new TextEncoder().encode(statementText(auth.pilotKey, auth.companyKey, auth.notAfter));
  if (!(await ed25519Verify(auth.companyKey, fromHex(sig), signed).catch(() => false))) return { reason: 'bad_signature', auth };
  if (auth.notAfter <= now) return { reason: 'ended', auth };
  if (auth.notAfter > now + MAX_DAYS * DAY) return { reason: 'too_long', auth };
  if (companyKey && !same(auth.companyKey, companyKey)) return { reason: 'not_company_key', auth };
  return { reason: null, auth };
}

/** The one `Authorized by company key:` line of a message: { found: false }, { found: true, malformed: true } or
 * { found: true, authorization, sig }. Lines split on \n only and count only from column 0, like parse_line. */
export function parseLine(message) {
  const found = String(message ?? '').split('\n').filter((line) => line.startsWith(LINE_PREFIX.trimEnd()));
  if (!found.length) return { found: false };
  if (found.length > 1 || !found[0].startsWith(LINE_PREFIX) || found[0].split('.').length !== 2) return { found: true, malformed: true };
  const [authorization, sig] = found[0].slice(LINE_PREFIX.length).split('.');
  return { found: true, authorization, sig };
}
