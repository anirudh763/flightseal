import React, { useEffect, useRef, useState } from 'react';
import flightSample from './scenario-gps.tlog?url&no-inline';
import sample from './scenario-crc.tlog?url&no-inline';
import { CAPTURE_LIMIT } from './inspect.mjs';

const labels = {
  crc: 'Checksum failed', unsupported: 'Unsupported message', reject: 'Unsupported flags',
  gap: 'Sequence gap', duplicate: 'Duplicate sequence', reorder: 'Sequence moved backward',
};

export function CaptureInspection({ onPackage, packageBlocked }) {
  const original = useRef(null);
  const active = useRef(null);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => () => {
    active.current?.stop();
    active.current = null;
  }, []);

  function cancel() {
    active.current?.stop();
    active.current = null;
    setBusy(false);
    setStatus('Inspection cancelled.');
  }

  async function run(file, sampleUrl = sample) {
    active.current?.stop();
    const controller = new AbortController();
    const task = { stop: () => controller.abort() };
    active.current = task;
    setResult(null);
    setBusy(true);
    setStatus('Inspecting capture…');
    function finish(message, report = null) {
      if (active.current !== task) return;
      task.stop();
      active.current = null;
      setBusy(false);
      setResult(report);
      setStatus(message);
    }
    try {
      if (!file) {
        const response = await fetch(sampleUrl, { signal: controller.signal });
        if (!response.ok) throw new Error('The sample could not load. Choose a local capture or try again.');
        file = new File([await response.blob()], sampleUrl === flightSample ? 'scenario-gps.tlog' : 'scenario-crc.tlog');
      }
      if (active.current !== task) return;
      if (!file.size || file.size > CAPTURE_LIMIT) throw new Error('Choose a nonempty capture up to 16 MiB.');
      const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
      task.stop = () => worker.terminate();
      worker.onmessage = ({ data }) => {
        if (data.error) finish(data.error);
        else if (active.current === task) {
          original.current = file;
          finish('Inspection complete.', { ...data.result, name: file.name });
        }
      };
      worker.onerror = () => finish('The capture inspector stopped. Try the file again.');
      worker.postMessage(file);
    } catch (error) {
      finish(error.message);
    }
  }

  return <section className="panel capture-inspection" aria-labelledby="capture-inspection-title">
    <div className="panel-head"><h2 id="capture-inspection-title">Inspect MAVLink</h2></div>
    <div className="panel-body">
      <label className="field-label" htmlFor="capture-input">Capture (.tlog or raw MAVLink, up to 16 MiB)</label>
      <input id="capture-input" type="file" onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void run(file);
      }} />
      <div className="capture-actions">
        <button className="button secondary" type="button" disabled={busy} onClick={() => void run(null)}>Inspect sample</button>
        <button className="button secondary" type="button" disabled={busy} onClick={() => void run(null, flightSample)}>Inspect flight sample</button>
        {busy && <button className="button secondary" type="button" onClick={cancel}>Cancel inspection</button>}
      </div>
      <p role="status">{status}</p>
      {result && <div className="capture-result">
        <h3>{result.name}</h3>
        <dl>
          <div><dt>Frames with valid checksums</dt><dd>{result.frames}</dd></div>
          <div><dt>Checksum failures</dt><dd>{result.checksumFailures}</dd></div>
          <div><dt>Unsupported messages</dt><dd>{result.unsupported}</dd></div>
          <div><dt>Sequence gaps</dt><dd>{result.sequenceGaps}</dd></div>
        </dl>
        {result.frames === 0 && <p>No frames passed checksum validation for the supported dialects.</p>}
        {!!result.findings.length && <ul>{result.findings.map(({ kind, offset }, i) =>
          <li key={i}>{labels[kind] || kind} at byte {offset}</li>)}</ul>}
        {result.omitted > 0 && <p>{result.omitted} additional findings omitted.</p>}
        <FlightView tracks={result.tracks} partial={result.unlistedFrames} />
        <button className="button secondary" type="button" disabled={packageBlocked} onClick={() => {
          const report = new File([JSON.stringify(result, null, 2) + '\n'], 'hashwing-flight-report.json', { type: 'application/json' });
          const url = URL.createObjectURL(report);
          const link = document.createElement('a');
          link.href = url;
          link.download = report.name;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          onPackage([original.current, report]);
        }}>Prepare evidence package</button>
        <p>Packet sender authentication was skipped. Use Seal &amp; send to preserve the original capture.</p>
      </div>}
    </div>
  </section>;
}


function FlightView({ tracks, partial }) {
  const canvas = useRef(null);
  const [senderIndex, setSenderIndex] = useState(0);
  const [pointIndex, setPointIndex] = useState(0);
  const points = tracks[senderIndex]?.points || tracks[0]?.points;
  useEffect(() => {
    if (!points?.length || !canvas.current) return;
    const ctx = canvas.current.getContext('2d');
    const lon = points.map(p => p.lon), lat = points.map(p => p.lat);
    const west = Math.min(...lon), south = Math.min(...lat);
    const span = Math.max(Math.max(...lon) - west, Math.max(...lat) - south, 0.00001);
    const position = p => [32 + (p.lon - west) / span * 260, 290 - (p.lat - south) / span * 260];
    ctx.clearRect(0, 0, 640, 320);
    ctx.strokeStyle = '#2355ba';
    ctx.lineWidth = 3;
    ctx.beginPath();
    points.forEach((point, i) => {
      const next = position(point);
      if (!i || Math.abs(point.lon - points[i - 1].lon) > 180) ctx.moveTo(...next);
      else ctx.lineTo(...next);
    });
    ctx.stroke();
    ctx.fillStyle = '#176342';
    ctx.beginPath();
    ctx.arc(...position(points[Math.min(pointIndex, points.length - 1)]), 6, 0, Math.PI * 2);
    ctx.fill();
  }, [points, pointIndex]);
  if (!points?.length) return <p>No supported position records were found in the inspected preview.</p>;
  const point = points[Math.min(pointIndex, points.length - 1)];
  return <section className="flight-view" aria-label="Flight path">
    <h4>Flight path</h4>
    {partial > 0 && <p>Path preview uses the first 1,000 valid frames.</p>}
    <label>Sender <select value={senderIndex} onChange={e => { setSenderIndex(Number(e.target.value)); setPointIndex(0); }}>
      {tracks.map(({ sender }, i) => <option key={sender} value={i}>{sender}</option>)}
    </select></label>
    <canvas ref={canvas} width="640" height="320" aria-hidden="true" />
    <label>Position record <input type="range" min="0" max={points.length - 1} value={Math.min(pointIndex, points.length - 1)} onChange={e => setPointIndex(Number(e.target.value))} /></label>
    <p>{point.lat.toFixed(6)}, {point.lon.toFixed(6)} · {point.altitudeM} m MSL · byte {point.offset}</p>
  </section>;
}
