// Jobs (`#/app/jobs`) and the compact "Sealed on this device" list under the sealing result (EXPERIENCE.md, "Jobs").
// Rows come from jobs-store.mjs through App. This is the registry-off build's view: every row reads "Sealed locally".
// Registry statuses, the status filter and the row detail (share links, delete hosted record) plug in here when the
// flag is on (a later PR); until then the flag-on build keeps registry-ui.jsx's own list on Seal & send.
import React, { useEffect, useRef, useState } from 'react';
import { CircleDot, HardDrive } from 'lucide-react';

export const PER_PAGE = 25;
export const STORAGE_MEMORY = "This browser isn't keeping jobs (private window or storage blocked). Jobs you seal now will be gone when you close it.";
const EXPORT_FAILED = "Couldn't save the export. Try again, or check that downloads are allowed.";
const when = (ms) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);

/** The job's metadata and receipt message, never the files. Name: hashwing-job-{ref or date}.json */
export function jobExport(job) {
  const iso = new Date(job.sealedAt).toISOString();
  const name = `hashwing-job-${safe(job.jobRef) || iso.slice(0, 16).replace(/[:T]/g, '-')}.json`;
  const body = { format: 'hashwing-job v1', jobRef: job.jobRef || null, package: job.name, mode: job.mode, items: job.items, bytes: job.bytes, sealedAt: iso, receiptMessage: job.receipt };
  return { name, text: `${JSON.stringify(body, null, 2)}\n` };
}

const Status = () => <span className="status-label jobs-status"><CircleDot aria-hidden="true" size={12} />Sealed locally</span>;

export const SEAL_RUNNING = 'Finish or cancel the seal in progress first.';
const REMOVE_FAILED = "Couldn't remove this job. Try again, or reload the page.";

export function JobsPage({ rows, loaded, storage, error, q, page, onUrl, onResume, resumeBlocked, onRemove, onDownload, sealHref, onSeal }) {
  const [exportError, setExportError] = useState('');
  const [removeError, setRemoveError] = useState('');
  const [announce, setAnnounce] = useState('');
  const [removing, setRemoving] = useState(null);
  const captionRef = useRef(null);
  const searchRef = useRef(null);
  const focusCaptionRef = useRef(false);
  const dialogRef = useRef(null);
  const keepRef = useRef(null);
  const triggerRef = useRef(null);
  const afterRemoveRef = useRef(null);
  const needle = q.trim().toLowerCase();
  const matches = needle ? rows.filter((r) => r.jobRef.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)) : rows;
  const pages = Math.max(1, Math.ceil(matches.length / PER_PAGE));
  const current = Math.min(Math.max(1, page), pages);
  const shown = matches.slice((current - 1) * PER_PAGE, current * PER_PAGE);
  const first = (current - 1) * PER_PAGE + 1, last = first + shown.length - 1;
  const caption = needle
    ? `${matches.length} job${matches.length === 1 ? ' matches' : 's match'}${pages > 1 ? ` · showing ${first}–${last}` : ''}`
    : `Showing ${first}–${last} of ${matches.length}`;
  const seen = useRef(null);
  useEffect(() => { // a page change moves focus to the caption (read once on focus); a search change is announced politely
    const key = `${needle}|${current}`;
    if (focusCaptionRef.current) { focusCaptionRef.current = false; captionRef.current?.focus(); }
    else if (seen.current !== null && seen.current !== key) setAnnounce(caption);
    seen.current = key;
  }, [needle, current]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (loaded && rows.length && page !== current) onUrl({ q, page: current }, 'replace'); }, [loaded, rows.length, page, current]); // eslint-disable-line react-hooks/exhaustive-deps -- an out-of-range ?page settles on a real one
  useEffect(() => { // after Remove: the next row's Resume, or the page heading
    const next = afterRemoveRef.current;
    if (!next) return;
    afterRemoveRef.current = null;
    (next.id && document.getElementById(`job-resume-${next.id}`) || document.getElementById('page-jobs'))?.focus();
  }, [rows]);
  // Starting a search adds a history entry; editing one replaces it, so Back leaves the search in one step. Previous and Next push.
  const search = (value) => onUrl({ q: value, page: 1 }, q ? 'replace' : 'push');
  const goPage = (n) => { focusCaptionRef.current = true; onUrl({ q, page: n }, 'push'); };
  const exportJob = (job) => {
    try { const out = jobExport(job); onDownload(out.name, out.text); setExportError(''); }
    catch { setExportError(EXPORT_FAILED); }
  };
  const askRemove = (job, event) => { triggerRef.current = event.currentTarget; setRemoving(job); dialogRef.current?.showModal(); keepRef.current?.focus(); };
  const confirmRemove = async () => {
    const job = removing;
    const i = shown.findIndex((r) => r.id === job.id);
    afterRemoveRef.current = { id: (shown[i + 1] || shown[i - 1])?.id || null };
    triggerRef.current = null;
    dialogRef.current?.close();
    try { await onRemove(job.id); setRemoveError(''); setAnnounce('Job removed'); }
    catch { afterRemoveRef.current = null; setRemoveError(REMOVE_FAILED); }
  };
  return <section className="screen jobs-screen" aria-label="Jobs">
    <div className="jobs-intro"><p>Saved in this browser only. Not a cloud copy.</p><p className="field-hint">Kept until you remove it or clear this browser's data.</p></div>
    {storage === 'memory' && <p className="jobs-notice">{STORAGE_MEMORY}</p>}
    {error && <p className="jobs-notice" role="alert">{error}</p>}
    {exportError && <p className="jobs-notice receipt-error" role="alert">{exportError}</p>}
    {removeError && <p className="jobs-notice receipt-error" role="alert">{removeError}</p>}
    {resumeBlocked && rows.length > 0 && <p className="jobs-notice" id="jobs-resume-blocked">{SEAL_RUNNING}</p>}
    {!rows.length ? <div className="jobs-empty"><p>Nothing sealed in this browser yet.</p><a href={sealHref} onClick={onSeal}>Seal files</a></div> : <>
      <div className="jobs-search">
        <label className="field-label" htmlFor="jobs-search">Search job reference or file name</label>
        <input id="jobs-search" ref={searchRef} type="search" value={q} maxLength={200} autoComplete="off" onChange={(e) => search(e.target.value)} />
      </div>
      {!matches.length ? <div className="jobs-empty"><p>No jobs match "{q.trim()}".</p><button type="button" className="button secondary" onClick={() => { onUrl({ q: '', page: 1 }, 'push'); searchRef.current?.focus(); }}>Clear search</button></div> : <>
        <table className="jobs-table">
          <caption ref={captionRef} tabIndex="-1">{caption}</caption>
          <thead><tr><th scope="col">Job ref</th><th scope="col">Package</th><th scope="col">Status</th><th scope="col">Sealed</th><th scope="col">Actions</th></tr></thead>
          <tbody>{shown.map((job) => <tr key={job.id}>
            <td className={`jobs-ref${job.jobRef ? '' : ' jobs-ref-empty'}`}>{job.jobRef || <><span aria-hidden="true">—</span><span className="visually-hidden">No job reference</span></>}</td>
            <td className="jobs-name wrap">{job.name}</td>
            <td><Status /></td>
            <td className="jobs-when">{when(job.sealedAt)}</td>
            <td><div className="jobs-actions">
              <button id={`job-resume-${job.id}`} type="button" className="button secondary" aria-label={`Resume ${job.name}`} disabled={resumeBlocked} aria-describedby={resumeBlocked ? 'jobs-resume-blocked' : undefined} onClick={() => onResume(job)}>Resume</button>
              <button type="button" className="button secondary" aria-label={`Export ${job.name}`} onClick={() => exportJob(job)}>Export</button>
              <button type="button" className="button secondary" aria-label={`Remove ${job.name}`} onClick={(e) => askRemove(job, e)}>Remove</button>
            </div></td>
          </tr>)}</tbody>
        </table>
        {pages > 1 && <div className="actions-row jobs-pages">
          <button type="button" className="button secondary" disabled={current <= 1} onClick={() => goPage(current - 1)}>Previous</button>
          <button type="button" className="button secondary" disabled={current >= pages} onClick={() => goPage(current + 1)}>Next</button>
        </div>}
      </>}
    </>}
    <p className="visually-hidden" role="status">{announce}</p>
    <dialog ref={dialogRef} className="registry-dialog jobs-dialog" aria-labelledby="remove-job-title" aria-describedby="remove-job-text" onClose={() => { triggerRef.current?.focus(); setRemoving(null); }}>
      <h2 id="remove-job-title">Remove this job from this browser?</h2>
      <p id="remove-job-text">The sealed file and anything you sent are not affected.</p>
      <div className="actions-row"><button type="button" className="button secondary" onClick={confirmRemove}>Remove</button><button ref={keepRef} type="button" className="button secondary" onClick={() => dialogRef.current?.close()}>Keep it</button></div>
    </dialog>
  </section>;
}

/** Seal & send: the last five jobs, under the sealing result, with "All jobs". */
export function SealedRecent({ rows, storage, notice, allJobsHref, onAllJobs }) {
  return <section className="panel jobs-recent" aria-labelledby="sealed-recent-title"><div className="panel-head"><HardDrive aria-hidden="true" size={18} /><h2 id="sealed-recent-title">Sealed on this device</h2></div><div className="panel-body">
    {storage === 'memory' && <p className="jobs-notice">{STORAGE_MEMORY}</p>}
    {notice && <p className="jobs-notice" role="status">{notice}</p>}
    {rows.length ? <ul className="jobs-recent-rows">{rows.slice(0, 5).map((job) => <li key={job.id}>
      <span className="jobs-name wrap">{job.name}</span><Status /><span className="jobs-when">{when(job.sealedAt)}</span>
    </li>)}</ul> : <p className="field-hint">Nothing sealed on this device yet.</p>}
    <p className="jobs-all"><a href={allJobsHref} onClick={onAllJobs}>All jobs</a></p>
  </div></section>;
}
