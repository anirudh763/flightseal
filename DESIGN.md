---
version: 2
name: flightseal
extends: ui.css            # docs/ui.css, the shared round-4 light base; app layout and the chain in docs/app.css
dial: ENERGY 1 / RHYTHM 2 / MOTION 1
signature: EVIDENCE CHAIN  # records drawn as a vertical hash chain, break and covered boundary marked on it
colors:                    # light is the default for everyone; dark only after the "Dark theme" button
  canvas:   { light: "#f7f8fa", dark: "#0f171f", use: "page behind the workspace" }
  surface:  { light: "#ffffff", dark: "#16212b", use: "panels, header, verdict, inputs" }
  rail:     { light: "#f0f3f5", dark: "#121c25", use: "left rail and Menu sheet" }
  ink:      { light: "#152536", dark: "#e4ebf1", use: "text" }
  muted:    { light: "#4b5e6f", dark: "#a7b5c2", use: "secondary text, dt labels, chain metadata" }
  input:    { light: "#748694", dark: "#8696a4", use: "input and button borders, the chain line" }
  divider:  { light: "#dce2e8", dark: "#2d3c49", use: "panel borders and row rules" }
  primary:  { light: "#174b5a", dark: "#8ccbd9", use: "primary action, links, current nav item, covered-prefix line, focus" }
  ok:       { light: "#12633c", dark: "#73d29e", use: "Intact, covered links (always with a word)" }
  warn:     { light: "#925400", dark: "#ebb65e", use: "Unverified/Incomplete, receipts not checked (always with a word)" }
  bad:      { light: "#b42318", dark: "#ff9a8f", use: "Tampered, the break (always with a word and a diamond)" }
typography:
  ui:   { family: "Atkinson Hyperlegible (local woff2, SIL OFL 1.1)", size: "16px / 1.5", h1: "30px / 1.2", h2: "20px" }
  mono: { family: "system monospace", size: "14px", use: "hashes, links, CRCs, file names, the text report, payload only" }
spacing: [4, 8, 16, 24, 32]
rounded: { control: 7px, label: 2em }
targets: { controls: "44px min", inline record and receipt links: "24px min (WCAG 2.5.8)" }
elevation: flat               # 1px divider borders, no shadows, no gradients
motion: { default: none, allowed: "120ms button background change; off under prefers-reduced-motion" }
---

# FlightSeal verifier design

## Frame

- Wide screens (1000px and up): a 216px left rail (text wordmark "FlightSeal", one-line purpose, a **Work** group:
  Verify a file, Findings, Records, Receipts; a separate **Learn** group: Trust help, Examples; the Dark theme button
  and the source link at the foot), a white location header (Back on screens that depend on a run, breadcrumb
  "FlightSeal / Screen"), and the workspace with a 32px gutter, at most about 1100px of content.
- Below 1000px there is no permanent rail: a labelled **Menu** button opens it as a sheet. While it is open the rest
  of the page is inert, Tab stays inside, Escape or Close menu closes it and focus returns to Menu.
- Below 600px the gutter is 16px and the breadcrumb wraps under Menu and Back.

## Routes

Hash routes so GitHub Pages serves every screen from one file: `#/verify` (default), `#/findings`, `#/records`,
`#/records/<n>`, `#/receipts`, `#/receipts/<n>`, `#/help`, `#/examples`, and Not found for anything else under `#/`.
A loaded example is part of the address (`?sample=tampered`), so a view can be shared; files of your own are never
in the URL. Old `?sample=name&record=N` links are rewritten to `#/records/N?sample=name` (or `#/findings?...`).
Every route change sets `document.title` to "Screen – FlightSeal", marks the nav item with `aria-current="page"`,
and moves focus to the screen's H1 (no outline on the workspace). Selecting a record or receipt keeps focus on it.

## Screens

- **Verify a file**: three numbered steps (sealed log, optional receipts, the key you trust), one primary action
  (Show findings), and a status card that announces the current check. The witness assumption is stated next to
  the receipts field.
- **Findings**: the verdict (bordered in its status colour, with an icon and words), "where to look first" with
  the facts, the expected-versus-stored link and exactly one primary next action (Inspect record N, Review receipt
  N, Add receipts and a key...), an Interpretation aside that keeps file integrity and trust apart, then the
  evidence chain summary.
- **Records**: the evidence chain, one link per record, 50 per page, with the record detail beside it.
- **Receipts**: the receipts table (scrolls inside its own labelled region) and a receipt detail that compares the
  head in the receipt with the link in the log.
- Without a run, Findings, Records and Receipts show an empty state that says why and links to Verify; while a
  check runs they say what is being checked; after an error they say what failed. The run bar with progress and
  Cancel is shared by all screens.

## The evidence chain (signature)

Modelled on the commit graph of `git log --graph`: a vertical line on the left with one node per link, the content
to its right. Each link names the record (or run of records), its byte range and its status in words. Marks:

- filled dot: passes and covered by a matching receipt; hollow dot: passes, not covered;
- diamond on a tinted row: the first break ("chain breaks here [bad-link]"); dashed node: bytes not checked;
- small square: a receipt, attached after the record it pins, with its result as a labelled chip and a link to its
  detail; runs of receipts with the same result past the end are grouped;
- dashed primary line: the end of the covered prefix, with a sentence saying what lies below it.

Colour never carries meaning alone: every mark has text, and a legend sentence explains the shapes.

## Trust copy rules

Say what was checked and what was not. Never promise that the source data or every original byte is authentic. Wrong
key, bad signature or no Ed25519 is Unverified (not evidence either way). A receipt mismatch says "rewritten, or
these receipts belong to another log sealed with the same key". Receipts protect only if a separate witness kept
them.

## Known gaps

- Manual screen-reader check not run; automated axe-core only.
- Contrast was checked by axe-core on every screen in both themes, not computed per token pair as in version 1.
