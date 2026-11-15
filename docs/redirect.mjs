export function canonicalConsoleURL(current, consoleURL = new URL('./console/', current)) {
  const fragment = current.hash.replace(/^#\/?/, '');
  const [path, query = ''] = fragment.split('?');
  const [route, selection] = path.split('/');
  const parameters = new URLSearchParams(query);
  const target = new URL(consoleURL);
  const routes = { findings: 'sandbox', examples: 'sandbox', sandbox: 'sandbox', verify: 'verify', records: 'records', receipts: 'receipts', video: 'video', telemetry: 'telemetry', help: 'help' };
  const destination = routes[route] || (current.searchParams.has('record') ? 'records' : 'sandbox');
  const sample = parameters.get('sample') || current.searchParams.get('sample');
  const selected = new URLSearchParams();
  if (['intact', 'tampered', 'rewritten', 'truncated', 'px4-intact', 'px4-tampered', 'px4-full'].includes(sample)) selected.set('sample', sample);
  const record = destination === 'records' ? selection || parameters.get('record') || current.searchParams.get('record') : null;
  const receipt = destination === 'receipts' ? selection || parameters.get('receipt') : null;
  if (record && /^\d{1,10}$/.test(record)) selected.set('record', String(Number(record)));
  if (receipt && /^\d{1,5}$/.test(receipt)) selected.set('receipt', String(Number(receipt)));
  target.hash = `/${destination}${selected.size ? `?${selected}` : ''}`;
  return target;
}

if (typeof window !== 'undefined') window.location.replace(canonicalConsoleURL(new URL(window.location.href), new URL('./console/', import.meta.url)));
