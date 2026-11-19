// Company key enrollment, pure (no JSX, no side effects). company-keys.jsx is the only caller, behind __REGISTRY_URL__.
// Rule B1: the browser never signs bytes the registry chose. It builds the challenge bytes itself, from the org in
// its own sign-in and a 32-lowercase-hex nonce, and signs only when the registry's `message` is exactly that string.
// This is a second, independent copy of the format (registry/registry/enroll_challenge.py is the Python one).
import { fingerprintHex } from './trusted-keys.mjs';

const NONCE = /^[0-9a-f]{32}$/;
const MAX_PAGES = 20; // 20 pages of 50 keys
const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

/** The bytes to sign for a `GET /v1/keys/challenge` answer, or null when it isn't the challenge this client expects. */
export function challengeBytes(org, challenge) {
  const nonce = challenge?.nonce, message = challenge?.message;
  if (typeof org !== 'string' || !org || typeof nonce !== 'string' || typeof message !== 'string' || !NONCE.test(nonce)) return null;
  const built = `hashwing-key-enroll v1\n${org}\n${nonce}`;
  return message === built ? new TextEncoder().encode(built) : null;
}

/** Every key of this org, following next_cursor (at most MAX_PAGES pages). The failed result as is, otherwise. */
export async function listAllKeys(client, opts = {}) {
  const keys = [];
  let cursor = null, active = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.listKeys(cursor ? { cursor } : {}, opts);
    if (!res.ok) return res;
    if (Array.isArray(res.data.keys)) keys.push(...res.data.keys.filter((k) => k && typeof k.key_fingerprint === 'string'));
    active = typeof res.data.active_key === 'string' ? res.data.active_key : null;
    cursor = typeof res.data.next_cursor === 'string' ? res.data.next_cursor : null;
    if (!cursor) return { ok: true, keys, active_key: active, truncated: false };
  }
  return { ok: true, keys, active_key: active, truncated: true };
}

/**
 * One press of Enroll / Replace: one challenge, one signature over the locally built bytes, one POST.
 * `sign(bytes)` returns the signature as 128 hex. Resolves {ok:true, data} or {ok:false, reason, code, status, kind}.
 * Never retries by itself.
 */
export async function enroll({ client, org, token, sign, publicKeyHex, confirmReplace = false }) {
  const ch = await client.keyChallenge({ token });
  if (!ch.ok) return { ok: false, reason: 'http', code: ch.code, status: ch.status, kind: ch.kind };
  const bytes = challengeBytes(org, ch.data);
  if (!bytes) return { ok: false, reason: 'unexpected_challenge', code: 'unexpected_challenge' };
  let signature;
  try { signature = await sign(bytes); } catch { return { ok: false, reason: 'sign_failed', code: 'sign_failed' }; }
  const body = { public_key: publicKeyHex, nonce: ch.data.nonce, signature };
  if (confirmReplace) body.confirm_replace = true;
  const res = await client.enrollKey(body, { token });
  if (res.ok) return { ok: true, data: res.data };
  if (res.status === 409 && res.code === 'confirm_required') return { ok: false, reason: 'confirm_required', code: res.code, status: 409 };
  if (res.status === 400 && res.code === 'bad_challenge') return { ok: false, reason: 'bad_challenge', code: res.code, status: 400 };
  if (res.status === 409 && res.code === 'key_exists') {
    // A lost answer to an earlier press, or a key enrolled before: success only when it is the active key now.
    const list = await listAllKeys(client, { token });
    if (!list.ok) return { ok: false, reason: 'http', code: list.code, status: list.status, kind: list.kind };
    if (list.active_key && list.active_key === await fingerprintHex(publicKeyHex)) return { ok: true, data: { key_fingerprint: list.active_key, state: 'active' }, recovered: true };
    return { ok: false, reason: 'enrolled_before', code: res.code, status: 409 };
  }
  return { ok: false, reason: 'http', code: res.code, status: res.status, kind: res.kind };
}

const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d\d-\d\d(T|$)/.test(iso) ? iso.slice(0, 10) : '');
const withDay = (text, iso) => (day(iso) ? `${text} on ${day(iso)}` : text);
/** The plain label of a key row. The registry's state name "rotated" is never shown. */
export function stateLabel(row) {
  switch (row?.state) {
    case 'active': return 'Active';
    case 'rotated': return withDay('Replaced', row.changed_at);
    case 'compromised': return withDay('Marked compromised', row.changed_at);
    case 'retired': return withDay('Removed', row.changed_at);
    default: return 'Not in use';
  }
}
export const stateKind = (row) => (row?.state === 'active' ? 'ok' : row?.state === 'compromised' ? 'bad' : 'neutral');
/** "Enrolled {date}" plus " by you"; a missing date is left out. */
export function enrolledLine(row) {
  const d = day(row?.enrolled_at);
  if (!d && row?.enrolled_by_me !== true) return '';
  return `Enrolled${d ? ` ${d}` : ''}${row?.enrolled_by_me === true ? ' by you' : ''}`;
}

/** The plain line for a failed action or list (the raw code goes under More options). */
export function errorLine(res) {
  if (res.reason === 'unexpected_challenge') return 'The registry sent an unexpected challenge. Nothing was signed.';
  if (res.reason === 'bad_challenge') return 'That request expired. Press the button again.';
  if (res.reason === 'enrolled_before') return "This key was enrolled before and can't be enrolled again.";
  if (res.reason === 'sign_failed') return "This browser couldn't sign with the loaded key. Nothing was sent.";
  if (res.kind === 'network' || res.kind === 'timeout') return "Couldn't reach the company registry. Try again in a few minutes.";
  if (res.status === 401) return 'Your registry sign-in has ended. Sign in again under Company registry.';
  if (res.status === 403) return 'Only a company admin can change company keys.';
  if (res.status === 404) return "This key isn't in your company's list any more.";
  if (res.status === 409 && res.code === 'conflict') return 'The key list changed meanwhile, so it was reloaded. Check it and try again.';
  if (res.status === 422 && res.code === 'bad_signature') return "The registry couldn't check this key's signature.";
  if (res.status === 503 || res.status === 429) return 'The registry is busy. Try again in a few minutes.';
  return "The registry couldn't do that right now. Try again in a few minutes.";
}

function pkcs8Of(pem) {
  const m = String(pem || '').trim().match(/^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PRIVATE KEY-----$/);
  if (!m) throw new Error('not a PKCS#8 PEM');
  return Uint8Array.from(atob(m[1].replace(/\s/g, '')), (c) => c.charCodeAt(0));
}
/** The raw public key (64 hex) of an Ed25519 PKCS#8 PEM. A throwaway extractable import; only the JWK's `x` is read. */
export async function publicKeyHexFromPem(pem, cryptoObject = globalThis.crypto) {
  const temp = await cryptoObject.subtle.importKey('pkcs8', pkcs8Of(pem), { name: 'Ed25519' }, true, ['sign']);
  const { x } = await cryptoObject.subtle.exportKey('jwk', temp);
  const raw = Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (x.length % 4)) % 4)), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('not an Ed25519 key');
  return hex(raw);
}
/** sign(bytes) -> 128 hex, with a non-extractable import of the PEM. */
export async function signerFromPem(pem, cryptoObject = globalThis.crypto) {
  const key = await cryptoObject.subtle.importKey('pkcs8', pkcs8Of(pem), { name: 'Ed25519' }, false, ['sign']);
  return async (bytes) => hex(await cryptoObject.subtle.sign({ name: 'Ed25519' }, key, bytes));
}
