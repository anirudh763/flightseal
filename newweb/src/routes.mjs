const screens = new Set(['sandbox', 'verify', 'records', 'receipts', 'video', 'help', 'benchmarks', 'system']);
const aliases = new Map([['findings', 'sandbox'], ['examples', 'sandbox'], ['telemetry', 'sandbox']]);
const samples = new Set(['intact', 'tampered', 'rewritten', 'truncated', 'px4', 'px4-tampered', 'px4-full']);

export function parseRouteHash(hash) {
  const raw = String(hash || '');
  const body = raw.replace(/^#/, '');
  const [path = '', query = ''] = body.split('?', 2);
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  const requestedSample = params.get('sample');
  const base = { params, rawPath: path, legacy: false, sample: samples.has(requestedSample) ? requestedSample : null, record: params.get('record') };

  if (parts.length === 0) return { ...base, kind: 'landing', route: '/', screen: 'landing' };
  if (['privacy', 'terms', 'security'].includes(parts[0]) && parts.length === 1) return { ...base, kind: 'legal', route: `/${parts[0]}`, screen: parts[0], page: parts[0] };
  if (parts[0] === 'signup' || parts[0] === 'login') return { ...base, kind: parts[0], route: `/${parts[0]}`, screen: parts[0] };
  if (parts[0] === 'app') {
    const requested = parts[1] || 'sandbox';
    const screen = aliases.get(requested) || requested;
    if (!screens.has(screen)) return { ...base, kind: 'not-found', route: '/not-found', screen: 'not-found' };
    return { ...base, kind: 'workspace', route: `/app/${screen}`, screen, detail: parts[2] || null };
  }

  const legacyScreen = aliases.get(parts[0]) || parts[0];
  if (screens.has(legacyScreen)) return { ...base, kind: 'workspace', route: `/app/${legacyScreen}`, screen: legacyScreen, detail: parts[1] || null, legacy: true };
  return { ...base, kind: 'not-found', route: '/not-found', screen: 'not-found' };
}

export function screenFromHash(hash) {
  const route = parseRouteHash(hash);
  return route.kind === 'workspace' ? route.screen : route.screen;
}

export function routeHash(target, params = {}) {
  let path;
  if (target === '/' || target === 'landing') path = '/';
  else if (target === 'signup' || target === 'login') path = `/${target}`;
  else if (target === 'not-found' || !screens.has(target)) path = '/not-found';
  else path = `/app/${target}`;
  const query = new URLSearchParams();
  if (params.sample && samples.has(params.sample)) query.set('sample', params.sample);
  if (Number.isSafeInteger(Number(params.record)) && Number(params.record) >= 0 && params.record !== '') query.set('record', String(Number(params.record)));
  return `#${path}${query.size ? `?${query.toString()}` : ''}`;
}

export function safeReturnRoute(value) {
  if (typeof value !== 'string' || value.length > 120) return routeHash('sandbox');
  const normalized = value.startsWith('#') ? value : `#${value}`;
  const parsed = parseRouteHash(normalized);
  if (parsed.kind !== 'workspace') return routeHash('sandbox');
  const sample = samples.has(parsed.params.get('sample')) ? parsed.params.get('sample') : undefined;
  const rawRecord = parsed.params.get('record');
  const record = rawRecord && /^\d+$/.test(rawRecord) && Number.isSafeInteger(Number(rawRecord)) ? Number(rawRecord) : undefined;
  return routeHash(parsed.screen, { sample, record });
}

export const workspaceScreens = Object.freeze([...screens]);

// Keep Pages/hash links; local product paths share the same workspace state.
const productPaths = Object.freeze({ sandbox: '/', verify: '/verify', benchmarks: '/benchmarks', system: '/system' });
export function parseLocation({ pathname = '/', search = '', hash = '' }) {
  if (hash) return parseRouteHash(hash);
  if (pathname === '/flightseal/console/' || pathname === '/console/') return parseRouteHash('');
  const screen = Object.keys(productPaths).find((key) => productPaths[key] === pathname);
  if (!screen) return parseRouteHash('#/not-found');
  return { ...parseRouteHash(routeHash(screen) + search), direct: true, route: pathname };
}
export function productHref(screen, params = {}) {
  if (!(screen in productPaths)) return routeHash(screen, params);
  const query = routeHash(screen, params).split('?')[1];
  return productPaths[screen] + (query ? `?${query}` : '');
}
