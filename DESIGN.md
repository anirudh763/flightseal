---
version: 3
name: FlightSeal evidence folio
styles: docs/ui.css, docs/app.css
dial: ENERGY 2 / RHYTHM 3 / MOTION 1
signature: centered verification sheet, numbered findings, chronological evidence chain, receipt comparison sheets
---

# FlightSeal evidence folio

FlightSeal is a local file verification workspace. The central decision is whether the supplied log agrees with its hash chain and any independently kept receipts. The interface keeps that result separate from a conclusion about the source data's authenticity.

## Identity and purpose

The council's mint / forest / amber direction replaces the former shared 216px left rail. A horizontal folio index leads into one centered input sheet. Numbered input rows establish the order of the check; numbered findings separate the conclusion, first useful action and chronological evidence. Receipt comparison sheets stack beneath the receipts register. System sans-serif keeps reading and controls familiar; tabular figures align sequence numbers, with monospace reserved for filenames, hashes, byte values and reports.

The opaque white sheets separate evidence from the mint workspace. Forest marks the verification action and current destination. Amber means an actual warning or unverified result, always in words. Fine rules separate fields and evidence rows; no decorative graph paper, shadows, glass, invented scores or trust shields are used. The three input rows represent the real inputs. The only motion is 120ms control feedback, disabled by reduced-motion preference.

## Tokens

| Role | Light | Explicit dark |
|---|---|---|
| Canvas | `#EFF7F2` | `#10251C` |
| Sheet | `#FFFFFF` | `#172F24` |
| Text | `#19362B` | `#E5F1E9` |
| Secondary text | `#4B6358` | `#ACC5B5` |
| Control boundary | `#688173` | `#88A593` |
| Divider | `#CCDCD1` | `#3A5646` |
| Forest action / focus | `#195944` | `#9CD6B7` |
| On action | `#FFFFFF` | `#10251C` |
| Intact | `#12633C` | `#73D29E` |
| Warning / unverified | `#925400` | `#EBB65E` |
| Tampered / break | `#B42318` | `#FF9A8F` |

The page defaults to light even under OS dark preference. Only the explicit, remembered theme control selects dark. Body text is 16px / 1.5; H1 is 32px desktop and 28px on phones. Buttons and data-route links are at least 44px high and wide. Prose links remain inline. Small 4px sheet corners distinguish sheets from 6px controls; status labels have square 3px corners. Disabled controls retain readable text and a dashed boundary.

## Composition and reflow

At desktop width the folio index spans the top of the page. It contains Verify, Findings, Records, Receipts, Trust help and Examples, plus theme and source. A single page banner below it contains the breadcrumb, Back where relevant and local-file context. The content width is at most 1120px; the Verify sheet is centered at 900px and its primary action fits the initial 1440 × 900 viewport.

Below 1000px the labelled Menu opens an inset, scrollable sheet with the same destinations. The page behind it becomes inert; Tab stays inside, Escape closes it and focus returns to Menu. At 768px the input sheet remains a single column with numbered rows and the check context in two columns. At 320px the fields, file names and trust instructions stack deliberately, with a full-width primary action. No content is clipped to conceal overflow. Technical receipt tables scroll inside their labelled region.

Findings starts with the actual conclusion, then the first useful action alongside Interpretation, followed by the evidence chain. Records pair the chronological chain and a selected record at desktop, stacking on tablets. Receipts use a full-width register followed by a centered selected comparison sheet. Trust help is a readable document sheet; examples are descriptive rows containing the existing sample controls.

## Routes and state

Preserve `#/verify`, `#/findings`, `#/records`, `#/records/<n>`, `#/receipts`, `#/receipts/<n>`, `#/help`, `#/examples` and Not found. Sample identity remains in the route query; local filenames and payloads never enter the URL. Existing legacy links, Back/Forward, selection, title changes, current navigation and H1 focus remain in `docs/app.js`. This visual revision does not change that file, the sample-loading race guard, Cancel, missing-key logic, crypto or parser behavior.

Without a run, data screens explain why they are empty and link to Verify. Loading names the work in progress and exposes Cancel; errors explain the failure. The same existing run state appears in the Verify sheet footer.

## Evidence chain and trust language

The vertical line is the actual record sequence: a filled dot means a checked, receipt-covered link; a hollow dot means checked but uncovered; a diamond and words mark the first break; dashed nodes mean unchecked bytes. Square receipt pins attach where issued. A dashed boundary names the end of receipt coverage. Status text and shape carry meaning independently of color.

Keep the qualified conclusions: a hash chain is not data authenticity; wrong keys, failed signatures and unavailable Ed25519 are Unverified. A receipt mismatch may mean a rewritten log or receipts for another log sealed with the same key. Receipt protection assumes a separate witness kept them. PX4 examples contain selected decoded records and do not authenticate every byte of the original ULog. Keep the documented limits and AI-assistance disclosure.

## Verification boundary

Use the existing browser route, keyboard, axe, offline, cancellation, trust and input-state regressions. Palette and desktop silhouette assertions change with this deliberate design; privacy and behavior assertions remain intact. Capture actual desktop, 768px, 320px and grayscale views. Native CLI comparison tests require a compatible built `fseal`; full native/parity checks run in release CI. No manual screen-reader or real-device keyboard testing is claimed.
