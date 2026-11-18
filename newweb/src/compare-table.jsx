// Verify result: the verdict headline with its separate lines (EXPERIENCE.md "Verify verdicts") and the file
// comparison, a table at 720px of container width and up, one summary per file below that.
import React, { useEffect, useRef, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { MANIFEST_STATUS } from '../../docs/manifest.mjs';

export const STATUS_KIND = { match: 'ok', 'bytes-differ': 'warn', missing: 'warn', 'not-in-manifest': 'warn' };
const exact = (n) => Number(n).toLocaleString('en-US');

export function StatusChip({ status }) {
  const kind = STATUS_KIND[status];
  return <span className={`status-label ${kind}`}><span className={`status-shape ${kind}`} aria-hidden="true" />{MANIFEST_STATUS[status]}</span>;
}

/** result: verdict() output. focusKey: changes once per finished check, so the headline takes focus once (focus table). */
export function VerdictBlock({ result, focusKey, lines, trustHref, onTrust, onReport, children }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, [focusKey]);
  const { text, action } = result.next;
  const next = action === 'trust' ? <a className="button secondary" href={trustHref} onClick={onTrust}>{text}</a>
    : action === 'originals' ? <button className="button secondary" type="button" onClick={() => document.getElementById('check-originals')?.focus()}>{text}</button>
    : action === 'report' && onReport ? <button className="button secondary" type="button" onClick={onReport}><Download aria-hidden="true" size={16} />{text}</button>
    : <p><strong>Next step:</strong> {text}</p>;
  return <div className={`verdict ${result.kind}`} data-verdict={result.key}>
    <h3 id="verdict-heading" ref={ref} tabIndex={-1} className="verdict-headline"><span className={`status-shape ${result.kind}`} aria-hidden="true" />{result.headline}</h3>
    <p className="verdict-sentence">{result.sentence}</p>
    <div className="verdict-next">{next}</div>
    <dl className="verdict-lines">{lines.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {children}
  </div>;
}

/** rows: [{ key, name, note?, bytes (null for a missing file), status, sha256 }] */
export function CompareTable({ rows, label }) {
  const [copied, setCopied] = useState('');
  const copy = async (row) => {
    try { await navigator.clipboard.writeText(row.sha256); setCopied(`SHA-256 of ${row.name} copied`); }
    catch { setCopied('This browser blocked copying. Open Details and select the hash.'); }
  };
  const copyButton = (row) => <button className="button secondary copy-hash" type="button" aria-label={`Copy SHA-256 of ${row.name}`} onClick={() => copy(row)}><Copy aria-hidden="true" size={16} />Copy</button>;
  const bytes = (row) => row.bytes == null ? '—' : exact(row.bytes);
  return <div className="compare-wrap">
    <table className="manifest-table compare-table">
      <caption className="visually-hidden">{label}</caption>
      <thead><tr><th scope="col">File</th><th scope="col">Bytes</th><th scope="col">Status</th><th scope="col">SHA-256</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}>
        <td className="wrap">{row.name}{row.note}</td>
        <td className="mono-values">{bytes(row)}</td>
        <td><StatusChip status={row.status} />{row.extra}</td>
        <td><span className="hash-cell"><code>{row.sha256.slice(0, 4)}…{row.sha256.slice(-4)}</code>{copyButton(row)}</span></td>
      </tr>)}</tbody>
    </table>
    <ul className="compare-summaries" aria-label={label}>{rows.map((row) => <li key={row.key}>
      <p className="compare-name wrap">{row.name}</p>{row.note}
      <p className="compare-facts"><StatusChip status={row.status} /><span className="mono-values">{bytes(row)}{row.bytes == null ? '' : ' bytes'}</span></p>
      {row.extra}
      <details className="report-details compare-details"><summary>Details</summary><div><code className="wrap">{row.sha256}</code>{copyButton(row)}</div></details>
    </li>)}</ul>
    <p className="visually-hidden" role="status">{copied}</p>
  </div>;
}
