---
name: HashWing
description: Calm, light evidence console for sealing drone flight files and letting an outside reviewer check them. Inherits the repo-root DESIGN.md and the final token layer of newweb/src/style.css; this file restates those tokens by name and adds only the registry-status components.
status: final
updated: 2026-11-17
sources:
  - ../../../DESIGN.md
  - ../../../newweb/src/style.css
colors:
  # Values are the final :root layer in newweb/src/style.css (line 889). CSS variable names are legacy;
  # the mapping is in the Colors section (for example --forest holds the cobalt action color).
  canvas: '#f3f6fa'
  surface: '#ffffff'
  rail: '#eaf0f7'
  ink: '#1e3048'
  muted: '#4d6075'
  line: '#c3cedb'
  field-border: '#71829a'
  action: '#2355ba'
  action-hover: '#194393'
  action-tint: '#eaf0fc'
  nav-current: '#173f92'
  nav-current-bg: '#dce7fa'
  ok: '#176342'
  ok-bg: '#e8f5ed'
  warn: '#805000'
  warn-bg: '#fff4df'
  bad: '#9f2633'
  bad-bg: '#fff0ee'
  focus: '#2355ba'
typography:
  # Both fonts are bundled locally (OFL). No new fonts.
  title:
    fontFamily: 'Space Grotesk'
    fontSize: clamp(1.7rem, 3vw, 2.2rem)
    fontWeight: '700'
    lineHeight: '1.15'
  section:
    fontFamily: 'Space Grotesk'
    fontSize: 1.08rem
    fontWeight: '700'
    lineHeight: '1.3'
  body:
    fontFamily: 'Space Grotesk'
    fontSize: 1rem
    fontWeight: '400'
    lineHeight: '1.58'
  hint:
    fontFamily: 'Space Grotesk'
    fontSize: .86rem
    fontWeight: '400'
    lineHeight: '1.45'
  label:
    fontFamily: 'Space Grotesk'
    fontSize: .9rem
    fontWeight: '600'
    lineHeight: '1.3'
  data:
    fontFamily: 'JetBrains Mono'
    fontSize: .8rem
    fontWeight: '400'
    lineHeight: '1.45'
    note: 'font-variant-numeric: tabular-nums. Hashes, fingerprints, bytes, counts, timestamps.'
rounded:
  # [ASSUMPTION] Effective values in the late style.css layers; the early 8px --radius is overridden for controls.
  sm: 4px
  md: 6px
  lg: 8px
  full: 9999px
spacing:
  '1': 4px
  '2': 8px
  '3': 16px
  '4': 24px
  '5': 32px
  target: 44px
  gutter-phone: 16px
  rail-width: 220px
  commandbar-height: 48px
components:
  button-primary:
    background: '{colors.action}'
    foreground: '#ffffff'
    hover: '{colors.action-hover}'
    radius: '{rounded.sm}'
    minHeight: '{spacing.target}'
  button-secondary:
    background: '{colors.surface}'
    foreground: '{colors.ink}'
    border: '{colors.line}'
    radius: '{rounded.sm}'
    minHeight: '{spacing.target}'
  status-label-ok:
    background: '{colors.ok-bg}'
    foreground: '{colors.ok}'
    shape: circle
  status-label-warn:
    background: '{colors.warn-bg}'
    foreground: '{colors.warn}'
    shape: diamond
  status-label-bad:
    background: '{colors.bad-bg}'
    foreground: '{colors.bad}'
    shape: square
  status-label-neutral:
    background: '{colors.action-tint}'
    foreground: '{colors.muted}'
    shape: ring
  trust-line:
    radius: '{rounded.sm}'
    typography: '{typography.hint}'
  fingerprint:
    typography: '{typography.data}'
    note: 'Groups of four hex digits, wraps anywhere, never truncated without a full-value copy action.'
  registry-chip:
    radius: '{rounded.full}'
    minHeight: 28px
    typography: '{typography.hint}'
    note: 'New. One chip per sealed item; uses the status-label colors below by state.'
  notice-inline:
    background: '{colors.surface}'
    border: '{colors.line}'
    radius: '{rounded.lg}'
    note: 'Calm inline notice. Replaces banners and toasts for every state in EXPERIENCE.md.'
---

## Brand & Style

HashWing is an evidence tool for small drone inspection companies and the clients or insurers who receive their files. It has to feel calm and trustworthy: a quiet, light workspace where the one next step is obvious and nothing shouts. The owner's wording is "very user friendly, calm and premium; nothing hitting your face".

"Premium" here means restraint, not decoration. It comes from generous spacing, plain words, aligned data in a monospace face and precise status wording. There are no gradients, hero art, celebration animations or dark-first themes. This file does not change the repo-root `DESIGN.md`. It inherits the workbench direction there (light neutral canvas, 220px rail, 48px command bar, hairline dividers, small corners, labelled Lucide icons) and adds only what the registry and offline states need.

## Colors

Two groups: neutral colors that carry the interface, and status colors that carry results. The action color is never a result color.

| Token | CSS variable today | Use | Not used for |
|---|---|---|---|
| `{colors.canvas}` | `--canvas` | Page background | Panels |
| `{colors.surface}` | `--surface` | Panels, command bar, inputs | Page background |
| `{colors.rail}` | `.workbench-rail` | Desktop navigation rail | Content |
| `{colors.ink}` / `{colors.muted}` | `--ink` / `--muted` | Body text and secondary text | Status |
| `{colors.line}` / `{colors.field-border}` | `--line` / `--field-border` | Hairline dividers / input borders | Emphasis |
| `{colors.action}` | `--forest` (legacy name; holds cobalt) | Primary buttons, links, focus ring, current nav | Success or "verified" |
| `{colors.ok}` on `{colors.ok-bg}` | `--ok` / `--ok-bg` | A check that passed: "Manifest verified", "Matches", "Signed by a key you trust", "Registered" | Buttons, decoration |
| `{colors.warn}` on `{colors.warn-bg}` | `--warn` / `--warn-bg` | Incomplete or not-yet-proven: "Bytes differ", "Not yet registered", "Needs attention", untrusted or replaced key | Errors that mean "don't rely on this" |
| `{colors.bad}` on `{colors.bad-bg}` | `--bad` / `--bad-bg` | Check failed: "Manifest not verified", wrong key, compromised key | Network or offline states |

Rules:

- **"Bytes differ" uses warn, not bad.** It is not proof of tampering, so it does not get the failure color.
- **Offline is not a failure.** "Waiting for connection" uses the neutral label (`status-label-neutral`), never bad.
- **Light theme only.** Root `DESIGN.md` sets `color-scheme: light`, and this spec adds no dark tokens. `forced-colors: active` must still show every status by its word and shape.
- Text on every background in this table must meet WCAG 2.2 AA (4.5:1 for body text). The existing pairs already pass; any new pair must be measured.

## Typography

Two bundled faces. No new fonts.

- **Space Grotesk** is used for everything people read: `{typography.title}` for the route heading in the command bar, `{typography.section}` for panel headings, `{typography.body}` for explanations and `{typography.hint}` for field hints and status basis lines.
- **JetBrains Mono** (`{typography.data}`, tabular numerals) is used only for machine values: SHA-256 values, key fingerprints, byte counts, record counts and ISO timestamps. Text people read is never set in mono.

Uppercase eyebrows and letter-spaced labels are not added to new surfaces. Headings use sentence case.

## Layout & Spacing

The spacing scale is 4 / 8 / 16 / 24 / 32 (`{spacing.1}` to `{spacing.5}`). Every interactive target is at least `{spacing.target}` (44px) tall and wide.

| Width | Layout |
|---|---|
| 1440px | 220px rail + command bar + content up to 1280px. Seal & send shows one step panel at a time, with an optional side summary. |
| 768px | The rail collapses to a "Menu" button. Content is one column. |
| 320px | One column, `{spacing.gutter-phone}` side gutter, no horizontal page scroll, no clipped controls. Hashes and fingerprints wrap inside their own cells. |

One primary button per step panel, placed at the end of the step's fields and aligned left.

## Elevation & Depth

Flat. Separation comes from `{colors.line}` hairlines and the `{colors.surface}`-on-`{colors.canvas}` contrast. There are no floating cards inside cards, no drop shadows on panels and no modal overlays for status. Native `<dialog>` is used only for confirmations that change stored data (replace a key, delete a hosted record), and then with a plain backdrop.

## Shapes

- `{rounded.sm}` (4px): buttons, inputs, nav items, trust lines.
- `{rounded.md}` (6px): multi-line text areas.
- `{rounded.lg}` (8px): panels, inline notices, dialogs.
- `{rounded.full}`: status labels and the registry chip only.

Each status has its own shape, so color is never the only signal. These shapes already exist in `.status-shape` and `.trust-line`: a circle means ok, a diamond means warn, a square means bad, and an outlined ring means neutral (new).

## Components

Existing and unchanged: button primary/secondary, `.status-label`, `.trust-line`, `.fingerprint`, `.time-fields`, `.report-details` ("More options" / "What is this?" disclosures), `.confirm-box`, `.nav-more`.

New for the registry wiring:

- **Registry chip** (`{components.registry-chip}`). A pill next to each sealed item and in the Records list. It shows a word, a shape and a color:
  - Sealed locally: neutral ring
  - Waiting for connection: neutral ring
  - Registering: neutral ring with a static three-dot mark (no spinner when reduced motion is set)
  - Registered: ok circle
  - Needs attention: warn diamond

  The chip text is always a word, never only an icon.
- **Inline notice** (`{components.notice-inline}`). A one- or two-sentence notice placed directly under the thing it is about, with at most one action button (secondary style). Every empty, offline, error and next-step message in `EXPERIENCE.md` uses it. Notices don't animate in and don't auto-dismiss.
- **Share link row.** It shows the link on one line in `{typography.data}`, with two buttons: "Copy link" (secondary) and "Withdraw link" (secondary text in `{colors.ink}`; the danger color is not used here because withdrawing can be undone by making a new link).
- **Delete hosted record button.** A secondary button labelled "Delete hosted record". The confirm dialog's confirm button uses `{colors.bad}` fill. This is the only place the bad color fills a button.

## Do's and Don'ts

| Do | Don't |
|---|---|
| Show one primary button per step | Put two primary buttons side by side |
| Put status words next to their shape and color | Use color alone, or icons alone |
| Use warn for "Bytes differ" and "Not yet registered" | Use red for anything that is not a failed check |
| Use the neutral ring for offline and queued states | Use banners, toasts or modal alerts for status |
| Put hashes and fingerprints in mono, wrapped, with a copy action | Truncate a hash without a full-value copy |
| Keep the light palette from the root `DESIGN.md` | Add a dark theme, gradients, hero imagery or new fonts |
| Keep "More options" and "What is this?" closed by default | Open advanced fields or long explanations by default |
