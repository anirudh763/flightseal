// The one HTTP edge to the receipt registry. Every call resolves (never throws) to
//   {ok:true, status, data}  or  {ok:false, kind:'network'|'timeout'|'aborted'|'http'|'client', status, code}.
// kind 'client' means nothing was sent (a malformed share token, or no Web Crypto outside a secure context).

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomId = () => b64url(crypto.getRandomValues(new Uint8Array(32))); // 43 chars, 256 bits
async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function b64urlDecode(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// `<org>/<sub>` from a bearer JWT, decoded WITHOUT verification (the server verifies). null when unreadable.
export function tokenOwner(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  let claims;
  try { claims = JSON.parse(b64urlDecode(parts[1])); } catch { return null; }
  if (!claims || typeof claims !== 'object') return null;
  const org = claims['custom:org_id'] ?? claims.org_id; // the server's Cognito adapter reads custom:org_id
  const sub = claims.sub;
  if (typeof org !== 'string' || !org || typeof sub !== 'string' || !sub) return null;
  return `${org}/${sub}`;
}

export function createRegistryClient({ baseUrl = '', getToken, fetch: doFetch = globalThis.fetch?.bind(globalThis), timeoutMs = 10000 } = {}) {
  const root = baseUrl.replace(/\/+$/, '');

  async function request(method, path, body, { signal, token, auth = true } = {}) {
    if (signal?.aborted) return { ok: false, kind: 'aborted', status: 0, code: 'aborted' };
    const headers = { accept: 'application/json' };
    if (auth) {
      const tok = token ?? (await getToken?.());
      if (!tok) return { ok: false, kind: 'http', status: 401, code: 'unauthorized' };
      headers.authorization = `Bearer ${tok}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (signal?.aborted) return { ok: false, kind: 'aborted', status: 0, code: 'aborted' };
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await doFetch(root + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal, credentials: 'omit', cache: 'no-store' });
      const text = await res.text(); // a failed body read is a network/timeout/abort, like a failed fetch
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      if (res.ok) {
        // a 2xx that is not a JSON object did not come from the registry (e.g. a captive portal)
        if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, kind: 'http', status: res.status, code: 'bad_response' };
        return { ok: true, status: res.status, data };
      }
      const retryAfter = res.headers?.get?.('retry-after') ?? null; // readable cross-origin only if the server exposes it
      return { ok: false, kind: 'http', status: res.status, code: (data && typeof data.error === 'string') ? data.error : `http_${res.status}`,
        ...(retryAfter === null ? {} : { retryAfter }) };
    } catch {
      if (timedOut) return { ok: false, kind: 'timeout', status: 0, code: 'timeout' };
      if (signal?.aborted) return { ok: false, kind: 'aborted', status: 0, code: 'aborted' };
      return { ok: false, kind: 'network', status: 0, code: 'network' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    envelope: (opts) => request('POST', '/v1/envelopes', {}, opts),
    register: ({ receipt, idempotency_key, envelope_id }, opts) => request('POST', '/v1/registrations', { receipt, idempotency_key, envelope_id }, opts),
    listRegistrations: (opts) => request('GET', '/v1/registrations', undefined, opts),
    getEpoch: (opts) => request('GET', '/v1/epoch', undefined, opts),
    // The share token is made here and never sent: the registry stores only its SHA-256. The result always carries
    // `share` ({token, idempotency_key, path}); keep it and pass it back on a retry after a lost response, and the
    // registry returns the same share (or its current disposition) instead of making a second one.
    async createShare({ registration_id, expires_days = 30, token = randomId(), idempotency_key = randomId() } = {}, opts) {
      const share = { token, idempotency_key, path: `/v1/shares/${token}` };
      // the registry serves only 43-character base64url tokens, so any other token would make a dead link
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, kind: 'client', status: 0, code: 'bad_token', share };
      let tokenHash;
      try { tokenHash = await sha256Hex(token); } catch { return { ok: false, kind: 'client', status: 0, code: 'insecure_context', share }; }
      const body = { registration_id, token_hash: tokenHash, idempotency_key, expires_days };
      return { ...(await request('POST', '/v1/shares', body, opts)), share };
    },
    withdrawShare: (token, opts) => request('DELETE', `/v1/shares/${encodeURIComponent(token)}`, undefined, opts),
    getShare: (token, opts) => request('GET', `/v1/shares/${encodeURIComponent(token)}`, undefined, { ...opts, auth: false }), // public: no sign-in
    getRegistration: (id, opts) => request('GET', `/v1/registrations/${encodeURIComponent(id)}`, undefined, opts), // PROPOSED route: one record
    deleteRegistration: (id, opts) => request('DELETE', `/v1/registrations/${encodeURIComponent(id)}`, undefined, opts),
    // Company keys (admin routes except the list). Pass opts.token, taken once per press, so one action never spans two sign-ins.
    keyChallenge: (opts) => request('GET', '/v1/keys/challenge', undefined, opts),
    enrollKey: (body, opts) => request('POST', '/v1/keys', body, opts),
    listKeys: ({ cursor } = {}, opts) => request('GET', `/v1/keys${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, opts),
    // Pilot keys (Option B): any member gets a challenge and enrolls their own key; an admin retires one.
    pilotKeyChallenge: (opts) => request('GET', '/v1/pilot-keys/challenge', undefined, opts),
    enrollPilotKey: (body, opts) => request('POST', '/v1/pilot-keys', body, opts),
    retirePilotKey: (fp, opts) => request('POST', `/v1/pilot-keys/${encodeURIComponent(fp)}/retire`, {}, opts),
    compromiseKey: (fp, opts) => request('POST', `/v1/keys/${encodeURIComponent(fp)}/compromised`, {}, opts),
  };
}
