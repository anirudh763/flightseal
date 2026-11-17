---
version: 4
name: FlightSeal workbench
styles: newweb/src/style.css
---

# FlightSeal workbench

The owner's November 14 workbench direction supersedes the mint folio design. The canonical console is `docs/console/`; root links redirect there with allowlisted sample and selection parameters. Do not maintain a separate Classic UI.

A light-neutral canvas, a 220px desktop session rail and a 48px command bar keep the loaded file and verification context visible. Use hairline pane dividers, small corners and compact typography rather than nested floating cards, compiler badges or a large marketing heading. Navigation uses labelled Lucide icons. The rail shows only known source metadata; unavailable drone IDs or dates are not invented.

Neutral actions and focus distinguish interaction from result. Emerald is reserved for successful integrity checks; crimson marks failures; amber marks incomplete or unverified evidence. All statuses have words and shape as well as color. Bytes, timestamps, counts, CRCs and hashes use tabular monospace. Abbreviated hashes expose a labelled full-value copy action. The chain head is not a whole-file SHA-256 digest.

At 768px the session rail collapses, and at 320px the panes stack without clipped controls or page overflow. Keep labelled 44px targets, visible keyboard focus, skip navigation, route heading focus and reduced-motion support. Use one selected record/time to coordinate the record inspector, available telemetry, offline GPS plot and video. Show units and clock limits. Video frame positioning is a playback aid, not signed capture-time proof.

Preserve loading/cancel, empty, success, incomplete, parse failure, quota and retry states. Clear stale positive results when inputs change. No record, receipt, source text, local path, key or private payload enters analytics or a URL. Cloud plans remain proposals; no fake purchase or waitlist submission.

The integrity report includes exact first-failure values with their actual type, receipt checks and full hashes on demand. No court-admissibility, sensor-truth, independent-witness or cloud-KMS claim. See WORKBENCH_CONTRACT.md for raw-source binding and trust semantics.

Verify actual flows at 320/768/1440, keyboard/focus, automated axe, console/CSP errors, deep links, offline, cancellation and the nine real-engine domain cases. Record finite measurements rather than universal performance or accessibility claims.


## Navigation and utility review — November 16

UI/UX Pro Max design-system generator matched aerospace / Minimalism & Swiss Style. Keep the existing locally bundled Space Grotesk UI and JetBrains Mono data typography, slate canvas #f3f6fa, cobalt action #2355ba, restrained 4/8/16/24/32px spacing, 44px controls, and semantic success/warning/failure tokens. The generated immersive landing and dark-first palette are recommendations, not a fit for this evidence workflow; no new fonts or framework are needed.

The command bar holds route title and account access. Source selection/sealing/report download live together in a labelled Source and report actions disclosure (open on Upload and seal). Other apps belongs in the rail. Offline/install/update tools live in their own disclosure after the task. Existing operation handlers, IDs, sample privacy and confirm-before-replace behavior remain. Escape closes an open utility and returns focus to its summary. Native disclosures preserve keyboard behavior without a custom menu framework. Verify 375/768/1024/1440 with route/history/refresh, independent tabs, actual tamper/restore and recovery, in addition to existing 320px coverage.

Verification fact values wrap inside their own cells, including the full SHA-256 value; the whole-file value remains fully displayed without overlapping receipt coverage, while existing compact copy badges retain their full values. The layout gate measures cell overflow as well as page overflow.

## Canonical workspaces and server storage (November 16)

Four exact product paths: Overview (purpose, actual session/current-result status, quick start), Workbench (existing C++/OpenSSL Wasm sealing/verification and contextual record tools), Reports (persisted runs, artifacts and existing exports), Settings (server session, real snapshots, browser backups, offline/install, health). Existing /verify, /benchmarks, /system and console hash links retain their domain screens. Space Grotesk/JetBrains Mono and the existing slate/cobalt light palette remain. ui-ux-pro-max Swiss/minimal aerospace guidance informs density and persistent navigation; generated alternatives are evidence, not replacement brand tokens.

Local server capability is embedded at container build time; the image's offline manifest hashes exactly match its marked HTML. The original source bundle stays suitable for browser-only Pages hosts. Private APIs are never service-worker cached. A fresh baseline did not reproduce the earlier warning; the new integration's HTML/hash mismatch was reproduced, fixed and tested with offline native verification and deferred-update protection.
