// Verify's opening choice (EXPERIENCE.md "Verify", AC-09, AC-54, AC-65, AC-67) and the flag-on link step.
import React, { useState } from 'react';
import { Check } from 'lucide-react';

/**
 * OWNER DECISION 2 (decided by the owner 2026-11-18: open on "I have files"). Verify opens on "I have files"; with the
 * registry flag on, "I have a HashWing link" is one click away and is chosen on arrival from a share link. The
 * public Pages build (flag off) has no link choice at all (AC-65), since it cannot open a link. 'link' would make
 * flag-on builds open on the link step instead. This is the one switch.
 */
export const VERIFY_OPENS_ON = 'files';

/** The token from a pasted share link (anything after `share=`), or the pasted text itself. */
export const shareTokenFrom = (text) => /[?&#]share=([^&\s]+)/.exec(String(text))?.[1] || String(text).trim();

export function VerifyChooser({ mode, onChange }) {
  return <fieldset className="verify-chooser">
    <legend>What were you sent?</legend>
    <div className="choice-buttons">{[['link', 'I have a HashWing link'], ['files', 'I have files']].map(([value, label]) => <label key={value} className="choice-button">
      <input type="radio" name="verify-mode" value={value} checked={mode === value} onChange={() => onChange(value)} />
      <Check className="choice-mark" aria-hidden="true" size={16} />{label}
    </label>)}</div>
  </fieldset>;
}

/** Link field, Open link, the registry's record (children) and "Check the files". A link never marks files verified. */
export function LinkStep({ initial, opened, onOpen, onCheckFiles, children }) {
  const [text, setText] = useState(initial || '');
  return <section className="panel verify-link" aria-labelledby="verify-link-title"><div className="panel-head"><h2 id="verify-link-title">Open the link</h2></div><div className="panel-body">
    <label className="field-label" htmlFor="verify-link">Link</label>
    <div className="link-row">
      <input id="verify-link" className="mono-input" value={text} autoComplete="off" spellCheck="false" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) onOpen(shareTokenFrom(text)); }} />
      <button className={`button ${opened ? 'secondary' : 'primary'}`} type="button" disabled={!text.trim()} onClick={() => onOpen(shareTokenFrom(text))}>Open link</button>
    </div>
    {opened && <>{children}<p className="field-hint">Files not checked yet.</p>
      <button className="button primary" type="button" onClick={onCheckFiles}>Check the files</button></>}
  </div></section>;
}
