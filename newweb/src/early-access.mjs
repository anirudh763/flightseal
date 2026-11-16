export async function deliverEarlyAccessRequest(endpoint, request, fetcher = globalThis.fetch) {
  if (typeof endpoint !== 'string' || !endpoint) throw new Error('No remote early access endpoint is configured.');
  const url = new URL(endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.hash) throw new Error('The early access endpoint must use HTTPS and contain no credentials or fragment.');
  if (!request || Object.keys(request).some((key) => !['email', 'teamSize', 'useCase'].includes(key))) throw new Error('Only email, team size and use case can be sent.');
  const response = await fetcher(url.href, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email: String(request.email || ''), teamSize: String(request.teamSize || ''), useCase: String(request.useCase || '') }),
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (response.ok && body?.received === true) return { received: true, status: response.status };
  throw new Error(`Endpoint did not acknowledge receipt (HTTP ${response.status}).`);
}
