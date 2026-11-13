---
version: 1
name: flightseal
extends: ui.css            # docs/ui.css, the shared base; listed below only where this app adds or overrides
dial: ENERGY 1 / RHYTHM 1 / MOTION 1
colors:                    # the app adds no colour tokens; these are the ui.css tokens it uses
  bg:            { light: "#ffffff", dark: "#0d1117", use: "page, boxes, table cells", src: "ui.css:7,15" }
  bg-subtle:     { light: "#f6f8fa", dark: "#151b23", use: "header bar, box headers, table headers, hash blocks", src: "ui.css:7,15" }
  bg-inset:      { light: "#eef1f4", dark: "#010409", use: "chain strip track, button hover and pressed", src: "ui.css:7,15" }
  fg:            { light: "#1f2328", dark: "#e6edf3", use: "text, receipt ticks on the strip", src: "ui.css:7,15" }
  fg-muted:      { light: "#59636e", dark: "#9198a1", use: "secondary text, dt labels, verified bytes on the strip", src: "ui.css:7,15" }
  border:        { light: "#d1d9e0", dark: "#3d444d", use: "box and table rules, unchecked-bytes hatch (decorative only)", src: "ui.css:8,16" }
  border-strong: { light: "#818b98", dark: "#656c76", use: "input borders, chain strip outline", src: "ui.css:8,16" }
  accent:        { light: "#0b57d0", dark: "#4493f8", use: "links, record buttons, focus ring, selected row, Source on GitHub", src: "ui.css:8,16" }
  ok:            { light: "#1a7f37", dark: "#3fb950", use: "Intact verdict and ok labels (always with a check icon and a word)", src: "ui.css:9,17" }
  bad:           { light: "#cf222e", dark: "#f85149", use: "Tampered verdict, bad labels, break mark, broken row stripe", src: "ui.css:9,17" }
  bad-subtle:    { light: "#ffebe9", dark: "#25171c", use: "broken row and stored-link background", src: "ui.css:9,17" }
  warn:          { light: "#9a6700", dark: "#d29922", use: "Incomplete/Unverified verdicts, warn labels, note icon", src: "ui.css:9,17" }
  warn-subtle:   { light: "#fff8c5", dark: "#272115", use: "notes and the no-JavaScript message", src: "ui.css:9,17" }
contrast:                  # WCAG relative luminance, computed from the hex values above
  - { fg: fg,            bg: bg,          light: 15.80, dark: 16.02, need: 4.5, use: "body text" }
  - { fg: fg,            bg: bg-subtle,   light: 14.84, dark: 14.65, need: 4.5, use: "header and box headers" }
  - { fg: fg-muted,      bg: bg,          light: 6.11,  dark: 6.50,  need: 4.5, use: "muted text, dt labels, pager label" }
  - { fg: fg-muted,      bg: bg-subtle,   light: 5.74,  dark: 5.94,  need: 4.5, use: "tagline, table headers" }
  - { fg: fg-muted,      bg: bad-subtle,  light: 5.33,  dark: 5.92,  need: 4.5, use: "muted text in the broken row" }
  - { fg: accent,        bg: bg,          light: 6.39,  dark: 6.11,  need: 4.5, use: "links, record buttons" }
  - { fg: accent,        bg: bg-subtle,   light: 6.00,  dark: 5.59,  need: 4.5, use: "Source on GitHub in the header" }
  - { fg: accent,        bg: bad-subtle,  light: 5.57,  dark: 5.56,  need: 4.5, use: "record button in the broken row" }
  - { fg: fg,            bg: bad-subtle,  light: 13.78, dark: 14.59, need: 4.5, use: "broken row cells, stored link" }
  - { fg: bad,           bg: bg,          light: 5.36,  dark: 5.65,  need: 4.5, use: "Tampered verdict, bad labels" }
  - { fg: bad,           bg: bad-subtle,  light: 4.67,  dark: 5.14,  need: 4.5, use: "bad label in the broken row" }
  - { fg: ok,            bg: bg,          light: 5.08,  dark: 7.45,  need: 4.5, use: "Intact verdict, ok labels" }
  - { fg: warn,          bg: bg,          light: 4.87,  dark: 7.50,  need: 4.5, use: "warn verdicts and labels" }
  - { fg: warn,          bg: warn-subtle, light: 4.52,  dark: 6.33,  need: 3,   use: "note icon (the note's text is fg)" }
  - { fg: fg,            bg: warn-subtle, light: 14.66, dark: 13.52, need: 4.5, use: "note and no-JavaScript text" }
  - { fg: fg,            bg: bg-inset,    light: 13.93, dark: 17.38, need: 4.5, use: "button text while hovered or pressed" }
  - { fg: border-strong, bg: bg,          light: 3.45,  dark: 3.57,  need: 3,   use: "input borders, strip outline" }
  - { fg: accent,        bg: bg,          light: 6.39,  dark: 6.11,  need: 3,   use: "focus ring, selected row outline" }
  - { fg: fg-muted,      bg: bg-inset,    light: 5.39,  dark: 7.05,  need: 3,   use: "strip: verified bytes against the track" }
  - { fg: bad,           bg: bg-inset,    light: 4.72,  dark: 6.13,  need: 3,   use: "strip: break mark" }
  - { fg: bad,           bg: bg,          light: 5.36,  dark: 5.65,  need: 3,   use: "broken row stripe, compare box border" }
  - { fg: border,        bg: bg-inset,    light: 1.26,  dark: 2.09,  need: none, use: "unchecked hatch texture; the legend text carries the meaning" }
typography:
  ui:   { family: "Atkinson Hyperlegible (its own digits, slashed zero included)", root: "93.75% (15px at the default 16px)", lineHeight: 1.5, src: "ui.css:4-5,10-11,19" }
  mono: { family: "ui-monospace,SFMono-Regular,Menlo,Consolas,...", use: "hashes, links, CRCs, file names, record numbers, numeric table cells, the text report and payload", src: "ui.css:11,20; app.css:82,84" }
  scale: { verdict: 1.35rem (1.15rem under 560px), h1: 1rem, h2: 1rem, h3: .95rem, body: 1rem, small: .85rem, min: "12px (.receipts .label, .8rem)" }
spacing: [2, 4, 6, 8, 10, 12, 14, 16, 20]       # px used for padding and gaps in app.css and ui.css
rounded: { strip: 3px, code: 4px, md: 6px, label: 2em }   # 2em only on status labels (ui.css:28)
elevation: { page: flat, dialog: "none: the app has no dialogs" }
motion:
  default: none
  allowed: [{ name: ".btn background/border", duration: 120ms, easing: ease, iterations: 1, reduce: off, src: "ui.css:39" }]
components:
  btn:          { base: "ui.css:23-26", radius: md, minTarget: "32px tall", states: [hover, active, focus-visible, disabled] }
  btn-small:    { base: "app.css:28", radius: md, minTarget: "28px tall", states: [hover, active, focus-visible, disabled], use: "Choose file, Remove, pager, Show, Copy report, Cancel" }
  input:        { base: "ui.css:27; app.css:25-26,79,101", radius: md, minTarget: "32px (jump field 28px)", states: [focus-visible, "aria-invalid (bad border)"] }
  label:        { base: "ui.css:28-29; app.css:88,93", radius: label, states: [ok, bad, warn], note: "always an icon plus a word" }
  box:          { base: "ui.css:30-31", radius: md, use: "Files, Result, Records, Record, Receipts" }
  repo-link:    { base: "ui.css:37", minTarget: "26.5px tall (2px vertical padding)", states: [hover, focus-visible] }
  verdict-line: { base: "app.css:37-39", states: [neutral, ok, bad, warn], note: "role=status, polite, atomic" }
  chain-strip:  { base: "app.css:45-54", note: "aria-hidden; the legend sentence under it says the same thing in text" }
  facts:        { base: "app.css:56-58", note: "dl; one column under 560px" }
  compare:      { base: "app.css:60-65", radius: md, note: "expected vs stored link, both in mono" }
  note:         { base: "app.css:68-69", radius: md, note: "warn-subtle background, warn icon, fg text" }
  records-table:{ base: "app.css:75-89", states: [row-bad, row-selected (aria-current), focus-visible on the record button] }
  pager:        { base: "app.js renderPage; app.css:77-78", states: [first page, middle, last page, one-record page, broken log] }
  receipts-table: { base: "app.css:92-95", note: "min-width 760px inside a focusable, labelled scroll region" }
---

# FlightSeal verifier design

## Overview

One screen that checks a sealed flight log in the browser. The focal point is the verdict line in the Result box ("Tampered: the chain breaks at record 150"); everything else is evidence for it: the facts list, the expected-versus-stored link, the chain strip, the records table opened at the broken record, and the receipts table. The first visit loads the tampered sample, so the screen is never empty. Dev-tool direction: a Primer-style header bar and boxes, a packet-list/packet-detail split pane for records, monospace for hashes and offsets.

## Colors

The app adds no colour tokens of its own; every value is a ui.css token (light and dark above, dark used through `prefers-color-scheme`, no toggle). Status colour is never the only signal: verdicts start with an icon and a word, labels carry an icon and a word, the broken row says "chain breaks here", and the strip has a legend sentence. The tightest pair is warn on warn-subtle (4.52:1 light), used only for the note icon, whose text is fg.

## Typography

Atkinson Hyperlegible for all UI text, including digits. Until this change the app used a renamed copy of the font with the digits cut out (a unicode-range trick) because the slashed zero "reads oddly in prose"; that made digits switch face inside words such as "Ed25519" and made flightseal's numbers look unlike the other four tools. The override is gone, so the slashed zero now appears in prose numbers too: it is part of why the font was picked (0 versus O for low vision). Monospace is kept for hashes, links, CRCs, file names, record numbers and the numeric table cells, with `tabular-nums`. The root size is 93.75%, so a larger browser default font size scales the page.

## Layout

- Wider than 960px: Files (300 to 380px) beside Result; Records (1.6fr) beside Record detail (min 280px); Receipts full width; "What a pass means" capped at 80ch.
- 960px and under: one column. The Result box then sits below Files, so pressing a "Load ... sample" button scrolls the Result box to the top when it is off screen (instant, no smooth scroll; keyboard focus stays on the button).
- 560px and under: tighter page padding, facts in one column, verdict 1.15rem.
- The records and receipts tables scroll sideways inside `role=region` containers with a label and `tabindex=0`; the page itself does not scroll sideways at 320px or at 200% zoom (checked by tests/web/e2e.mjs).

## Elevation and shapes

Flat: 1px borders, no shadows. Radius 6px on boxes, buttons, inputs and notes; 4px on the hash blocks inside the compare box; 3px on the strip; 2em only on status labels.

Written reasons for the decorations the standard asks about:
- Broken-row stripe (`tr.row-bad th`, inset 3px bad): keeps the broken row findable in a dense table when the row tint is hard to see; paired with the "chain breaks here" label and icon.
- Hatched "unchecked" bytes on the strip (repeating gradient of border on bg-inset): a texture, not a colour, so "not checked" differs from "verified" without colour; the legend says it in words.
- The noscript message and the notes no longer have a coloured left stripe; they use the warn-subtle background, a border and (for notes) a warn icon.

## Motion

None by default. The only transition is the shared `.btn` background/border change (120ms), inside `prefers-reduced-motion: no-preference`; ui.css turns all transitions and animations off under `reduce`. Nothing loops. The phone scroll to the Result box is instant.

## Components

- Buttons: `.btn` (32px) and `.btn.small` (28px); hover and pressed use bg-inset; disabled is 55% opacity with a not-allowed cursor. Pager buttons that become disabled hand focus to their neighbour.
- File fields: the native file inputs are hidden (their own text says "No file chosen" while a sample is loaded); a "Choose file" button named "Choose file Sealed log (.fseal)" opens them, and the file name and size sit next to it.
- Public key input: mono, `aria-describedby` hint; a key that is not 64 hex digits sets `aria-invalid` (bad border) and the Result box says "The public key must be 64 hexadecimal digits. The receipts were not checked."
- Verdict: one `role=status` region, polite and atomic, replaced once per run.
- Pager: "Records 50 to 99 of 800, page 2 of 16". After a break the count is what was checked: "Record 150 of 151 checked (verification stopped at record 150), page 4 of 4". A page holding one record names one record.
- Records table: the record number is a button ("Show record N"); the selected row gets a 2px accent outline and `aria-current`; the broken row gets the bad tint, stripe and label.
- Receipts table: result labels at 12px with icon and word; signature status in words.
- Source on GitHub: the shared `.app-header .repo` link, underlined accent, pushed right.

## States

- Empty: "Load a sealed log or a sample to check it."
- Loading: for large files, a progress bar labelled "Verifying" with a Cancel button; Cancel shows "Verification cancelled." and no verdict.
- Errors: each names the cause and the next step, for example "Could not load the intact sample: ... Check your connection and reload, or choose your own files."; malformed receipts name the line.
- No JavaScript: a message that says the page needs JavaScript and gives the `fseal verify` command.
- Offline: the service worker (docs/sw.js) caches the page, scripts, fonts and samples after one visit; bump its VERSION when any cached file changes.

## Do and don't

- Do keep the verdict wording and the report text identical to the CLI; the tests compare them.
- Do keep numbers computed from the loaded file; never round "151 checked" up to the log length.
- Don't add colour-only state, a second accent, or a decorative stripe without a reason written here.
- Don't move focus to the Result box when a sample loads; the status region announces it.

## Known gaps

- `.verdict:focus{outline:none}` (app.css:36): the Result box is a skip-link target with `tabindex=-1`, not a control, so it shows no ring when the skip link lands there.
- At 375px the pager label after a break is long and wraps the Next/Last buttons onto their own row.
- The public key error is shown in the Result box, not under the field, and is not linked to it with `aria-describedby` (DESIGN standard section 3, Forms).
- The chain strip is `aria-hidden`; screen-reader users get the legend sentence and the facts list instead.
- Checked with axe-core (light and dark, 1280 and 375px) and Playwright keyboard, reflow and zoom tests. A manual screen-reader check has not been run.
