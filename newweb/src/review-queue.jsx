import React, { useEffect, useState } from 'react';

async function request(path, body, csrf) {
  const response = await fetch('/api/' + path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || 'The queue is unavailable.');
    error.status = response.status;
    throw error;
  }
  return data;
}

export function ReviewQueue() {
  const [rows, setRows] = useState([]);
  const [digest, setDigest] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(true);
  const [needsSession, setNeedsSession] = useState(false);
  async function run(action) {
    setBusy(true);
    setStatus('');
    try {
      if (action) await action();
      setRows((await request('review-queue')).items);
      setNeedsSession(false);
      if (action) setStatus('Review queue updated.');
    } catch (error) {
      setRows([]);
      setNeedsSession(error.status === 401);
      setStatus(error.status === 401 ? 'Start a review session to use the queue.' : error.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void run(); }, []);
  const submit = async (path, body) => {
    const session = await request('session');
    await request(path, body, session.csrf_token);
  };
  return <section className="panel" aria-labelledby="review-queue-title">
    <div className="panel-head"><h2 id="review-queue-title">Evidence review queue</h2></div>
    <div className="panel-body">
      <p>Queue a SHA-256 fingerprint for follow-up. Review and verify the original files separately.</p>
      {needsSession ? <button type="button" className="button primary" disabled={busy} onClick={() => void run(() => request('session/guest', {}))}>Start review session</button> : <form onSubmit={event => {
        event.preventDefault();
        void run(async () => { await submit('review-queue', { digest: digest.trim().toLowerCase() }); setDigest(''); });
      }}>
        <label className="field-label" htmlFor="review-digest">SHA-256 fingerprint</label>
        <input id="review-digest" className="mono-input" value={digest} maxLength={64} onChange={e => setDigest(e.target.value)} />
        <button className="button primary" disabled={busy || !/^[a-f0-9]{64}$/i.test(digest.trim())}>Queue for review</button>
      </form>}
      <button className="button secondary" disabled={busy} type="button" onClick={() => void run()}>Refresh queue</button>
      <p role="status">{busy ? 'Loading review queue…' : status}</p>
      {!busy && !status && !rows.length && <p>No evidence queued.</p>}
      {rows.length > 0 && <ul className="review-queue-list">{rows.map(row => <li key={row.id}>
        <code className="wrap">{row.digest}</code>
        <span>{row.processed_at ? 'Reviewed' : 'Awaiting review'}</span>
        {!row.processed_at && <button type="button" className="button secondary" disabled={busy} onClick={() => void run(() => submit('review-queue/complete', { id: row.id }))}>Mark reviewed</button>}
      </li>)}</ul>}
    </div>
  </section>;
}
