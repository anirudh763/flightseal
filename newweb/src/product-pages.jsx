import React, { useEffect, useRef, useState } from 'react';
import { verifyFile } from '../../docs/wasm/client.mjs';

export function SystemPage() {
  const [state, setState] = useState({ loading: true });
  const request = useRef(null);
  const refresh = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    setState((value) => ({ ...value, loading: true }));
    try {
      const rows = await Promise.all(['/healthz', '/readyz', '/api/system', '/metrics'].map(async (path) => {
        try {
          const response = await fetch(path, { signal: controller.signal, cache: 'no-store' });
          const text = await response.text();
          if (!response.headers.get('content-type')?.includes(path === '/metrics' ? 'text/plain' : 'application/json')) throw new Error('Endpoint is unavailable on this host.');
          return { path, status: response.status, ok: response.ok, body: path === '/metrics' ? text : JSON.parse(text) };
        } catch (error) { return { path, ok: false, error: error.name === 'AbortError' ? 'Request timed out or was canceled.' : error.message }; }
      }));
      if (request.current === controller) setState({ loading: false, rows, checked: new Date().toLocaleString() });
    } finally { clearTimeout(timeout); }
  };
  useEffect(() => { refresh(); return () => request.current?.abort(); }, []);
  const system = state.rows?.find((row) => row.path === '/api/system' && row.ok)?.body;
  const metrics = state.rows?.find((row) => row.path === '/metrics' && row.ok)?.body;
  return <section className="screen product-page" aria-label="Live service health">
    <section className="panel"><div className="panel-head"><h2>Service checks</h2><button className="button secondary" type="button" onClick={refresh} disabled={state.loading}>{state.loading ? 'Checking…' : 'Refresh health'}</button></div><div className="panel-body">
      <p role="status">{state.loading ? 'Checking this host…' : `Last checked: ${state.checked}`}</p>
      <dl className="health-checks">{state.rows?.filter((row) => row.path !== '/metrics').map((row) => <div key={row.path}><dt><code>{row.path}</code></dt><dd><span className={`status-label ${row.ok ? 'ok' : 'warn'}`}>{row.error ? 'Unavailable' : row.ok ? 'Available' : 'Not ready'}</span> {row.error || `HTTP ${row.status} · ${row.body?.status || row.body?.service || 'Response received'}`}</dd></div>)}</dl>
      {!state.loading && !system && <p className="field-hint">Health data needs the local serving process. On static Pages hosting, these endpoints are unavailable.</p>}
      {system && <><dl className="system-summary"><div><dt>Uptime</dt><dd>{Number.isFinite(system.uptime_seconds) ? `${system.uptime_seconds.toFixed(1)} seconds` : 'Unavailable'}</dd></div><div><dt>HTTP requests</dt><dd>{system.http?.requests_total ?? 'Unavailable'}</dd></div><div><dt>HTTP errors</dt><dd>{system.http?.errors_total ?? 'Unavailable'}</dd></div></dl><p className="field-hint">{system.scope || 'HTTP serving process only.'} Service readiness does not verify a flight log or receipt.</p></>}
    </div></section>
    <section className="panel"><div className="panel-head"><h2>Prometheus metrics</h2>{metrics && <a className="button secondary" href="/metrics" target="_blank" rel="noreferrer">Open metrics</a>}</div><div className="panel-body">{metrics ? <><p>Current process counters and latency buckets; no historical series.</p><details><summary>Raw metric samples</summary><pre className="report-text metrics-text" tabIndex="0" role="region" aria-label="Prometheus metric samples">{metrics}</pre></details></> : <p role="status">{state.loading ? 'Loading metrics…' : 'Metrics unavailable. Start the local serving process and refresh health.'}</p>}</div></section>
  </section>;
}

export function BenchmarkPage() {
  const [state, setState] = useState({});
  const request = useRef(null);
  useEffect(() => () => request.current?.abort(), []);
  const run = async () => {
    const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 60000);
    setState({ loading: true });
    try {
      const response = await fetch('/flightseal/samples/intact.fseal', { signal: controller.signal });
      if (!response.ok) throw new Error('The included log could not be loaded. Check the sample files and retry.');
      const blob = await response.blob();
      if (blob.size > 256 * 1024) throw new Error('The benchmark fixture exceeds its 256 KiB bound.');
      const file = new File([blob], 'intact.fseal');
      await verifyFile(file, '', '', { signal: controller.signal });
      const durations = [];
      let result;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        result = await verifyFile(file, '', '', { signal: controller.signal });
        if (result.status !== 'intact') throw new Error(`Fixture verification returned ${result.status}.`);
        durations.push(performance.now() - start);
      }
      const ordered = [...durations].sort((a, b) => a - b);
      setState({ result, durations, bytes: file.size, median: ordered[1], checked: new Date().toLocaleString() });
    } catch (error) { setState({ error: error.name === 'AbortError' ? 'Benchmark canceled or exceeded its 60-second limit. Retry when ready.' : error.message }); }
    finally { clearTimeout(timer); request.current = null; }
  };
  return <section className="screen product-page" aria-label="Crash safety and throughput">
    <section className="panel"><div className="panel-head"><h2>Browser verification measurement</h2></div><div className="panel-body">
      <p>Included 800-record log. One warm-up, three sequential C++/Wasm checks; no receipts. File fetch is excluded.</p>
      <div className="actions-row"><button className="button primary" type="button" onClick={run} disabled={state.loading}>{state.loading ? 'Measuring…' : 'Run verification benchmark'}</button>{state.loading && <button className="button secondary" type="button" onClick={() => request.current?.abort()}>Cancel benchmark</button>}</div>
      {state.loading && <p role="status">Verifying the included log. This tab may use CPU for up to 60 seconds.</p>}
      {state.error && <p role="alert" className="receipt-error">{state.error}</p>}
      {state.result && <div role="status"><dl className="system-summary"><div><dt>Median elapsed</dt><dd>{state.median.toFixed(2)} ms</dd></div><div><dt>Log throughput</dt><dd>{(state.bytes / 1048576 / (state.median / 1000)).toFixed(2)} MiB/s</dd></div><div><dt>Records checked</dt><dd>{state.result.records}</dd></div></dl><p>Samples: {state.durations.map((n) => `${n.toFixed(2)} ms`).join(', ')}. Measured {state.checked}.</p><p className="field-hint">This browser and device only; includes worker messaging and file access. Three samples cannot establish p99 or server capacity.</p></div>}
      {!state.result && !state.loading && <p className="field-hint">No measurement in this tab yet.</p>}
    </div></section>
    <section className="panel"><div className="panel-head"><h2>Crash safety</h2></div><div className="panel-body"><p>No current host crash-recovery measurement is available in this interface.</p><p className="field-hint">The native test suite exercises interrupted writes and acknowledged records. Browser verification does not measure disk durability or safely crash the serving process.</p><details><summary>Native benchmark procedure</summary><p>Use the existing <code>fseal-bench RECORDS.tsv WORKDIR 5</code> on the target disk. Record hardware, filesystem, dataset, durability policy and raw output. Historical VM results in the README are separate from this browser run.</p></details></div></section>
  </section>;
}
