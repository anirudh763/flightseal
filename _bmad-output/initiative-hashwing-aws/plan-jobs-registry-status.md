---
title: 'Jobs: registry status per row, status filter and row detail (flag on)'
type: feature
ticket: ''
created: '2026-11-19'
status: in-progress
baseline_revision: '56fc2192098eefae77ce2e578cd43c32e237ccbd'
route: full
route_source: auto
risk: medium
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/AGENTS.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** In registry-on builds (`VITE_REGISTRY_URL` set) the Jobs page reads "Sealed locally" on every row, even for proofs the registry already registered; there is no status filter and no row detail (ledger R22, R26 flag-on part; EXPERIENCE.md AC-56..AC-58, AC-60).

**Approach:** Derive each job's registry status from the registry session snapshot that "Sealed on this device" already uses (outbox rows plus pending proofs, matched on the receipt line; no server call), and pass it into the registry-agnostic `JobsPage` from `main.jsx` behind `__REGISTRY_URL__`. Add a URL-backed status filter and a flag-on row detail. Keep the flag-on compact registry list as it is (documented decision, item d).

## Boundaries & Constraints

**Always:**
- Work ONLY in the worktree `/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-jobs` (branch `feat/jobs-registry-status`). Every path below is relative to it. Never edit `/Users/anirudhyadav/flightseal`.
- Status labels are the outbox's own labels, verbatim (`row.label`: Sealed locally, Registering, Waiting for connection, Registered, Registered, later deleted, Needs attention). Offline remap as `SealedOnDevice` does: `sealed_local` reads "Waiting for connection" while `!s.online`.
- Filter buckets: `waiting` = `sealed_local`, `registering`, `waiting_for_connection`, and pending proofs; `registered` = `registered` including "later deleted"; `problems` = `needs_attention`. A job with no outbox or pending record reads "Sealed locally" and is listed under All only. Never infer Registered without a row.
- `jobs.jsx` and `jobs-store.mjs` ship in the flag-off (Pages) bundle: they must not import registry code or carry registry wording. All registry strings live in `registry-ui.jsx`; `jobs.jsx` takes generic props.
- Flag-off build unchanged: rows read "Sealed locally", no filter, no row detail, no new elements in the table (keeps `newweb/tests/jobs.mjs` selectors `td:nth-child(3)`, `tbody tr` counts and the 320px order check valid).
- Owner scoping: Jobs rows stay the local scope's (unchanged). Registry status comes only from the current registry sign-in's outbox and this local scope's pending store; signed out, or another registry owner, means no record and an honest detail line.
- Docs/console rebuild per AGENTS.md: `git rm -r -q --cached docs/console; rm -rf docs/console; npm --prefix newweb run build; git add -A docs/console`; then `grep -l transfer docs/console/assets/hash-worker-*.js` finds a file and `grep -rl hashwing-pending docs/console` finds nothing.
- Local registry for manual runs: your own dev server on port 8798 (`python3 registry/devserver/server.py --port 8798`, pass `REGISTRY_DEV_URL=http://127.0.0.1:8798`); stop it when done. Never touch ports 8787, 4180 or 8797.

**Never:**
- A new server call per row or any network request from Jobs.
- Any status text reading "Verified" or implying the files were checked.
- Editing `registryTimeField`/`useRegistryTimeField`, `RegistryBarLink` (`registry-ui.jsx` ~300-332), `main.jsx` around the `RegistryBarLink` render (~1800), or the profile-removal code (`removeActiveProfile`, ~1455-1470): another builder is changing those. Don't assert `registryTimeField` strings in new tests.
- Share links / delete hosted record inside the Jobs row detail, the "{company}" row label, "Last confirmed by this device" wording (not an outbox label): out of scope, record as open.
- Replacing the flag-on "Sealed on this device" registry list (it carries sign-in, assign, export/import, retry, share, delete; most wiring checks drive it).
- Committing `_bmad/` or `.venv-agent`, force-push, merge.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Registered | outbox row `registered` for the job's receipt line | Row status "Registered" (ok style); detail: "Registered at {received_at UTC}. This is the registry's statement, not proof of the files." | none |
| Needs attention | outbox row `needs_attention` (e.g. key_not_enrolled) | "Needs attention" (warn); detail shows the same reason message the registry list uses, and the row's updated time | none |
| Waiting | pending proof, or `sealed_local`/`registering`/`waiting_for_connection`, or offline `sealed_local` | outbox label; listed under filter Waiting to send | none |
| No record | signed out (outbox closed) and not pending, or another registry owner | "Sealed locally"; detail says sign in to see registry status / no registry record on this device for the current sign-in; under All only | none |
| Filter + search + paging | `#/app/jobs?status=registered&q=x&page=2` | filter applied first, then search, 25 per page; status kept across search, page, clear search; Back/Forward work | unknown `status` value ignored (All) |
| Filter empty | filter matches nothing | "No jobs with this status." + "Show all jobs" | none |
| Flag off | no `__REGISTRY_URL__` | identical to today | none |

</intent-contract>

## Code Map

- `newweb/src/jobs.jsx` -- `JobsPage`, `SealedRecent`, `Status`. Add optional props `statusOf(job) -> {label, kind, group, line, at} | null`, `filters` (array of `[value, label]`), `status` (URL value). When `statusOf` is undefined: today's behaviour exactly. Filter = `<select>` labelled "Status" next to search, values `''` (All) + `filters`; changing it calls `onUrl({q, status, page: 1}, 'push')`. Every existing `onUrl` call (search, `goPage`, Clear search, out-of-range settle effect) must carry `status`. Row detail (flag on only): a "Details" button (`aria-expanded`, `aria-controls`, `aria-label="Details for {name}"`) in `.jobs-actions`; when open, a following `<tr class="jobs-detail-row"><td colSpan=5>` with a `<dl>`: Job ref, Package, Items (and bytes, use `fmtBytes`-style plain number if no helper is importable; `jobs.jsx` has no fmtBytes — show `{items} item(s) · {bytes} bytes` with `toLocaleString('en-GB')`), Sealed (same `when()`), Registry status (`line` + its own time `at`, formatted with `when()`; registered rows use the `received_at` text already in `line`), and a "Copy receipt message" button (`navigator.clipboard.writeText(job.receipt)`; status "Receipt message copied." / failure "Couldn't copy. Use Export to save the receipt message." in the page's polite status region). Status element gets `kind` class (`ok`/`warn`/`neutral`) in addition to `status-label jobs-status`.
- `newweb/src/registry-ui.jsx` -- add `export function useJobsRegistry()` in the "Seal & send: Sealed on this device" section (after `chipOf`/`utc`, ~line 381), NOT near `registryTimeField`. Uses `useRegistry()`; builds one `Map(receiptLine -> status)` per snapshot from `s.rows` (offline remap) and `s.pending` (pending wins only when no outbox row). `chipOf(row)[1]` gives kind. Detail `line` text: registered -> `Registered at ${utc(received_at)}. This is the registry's statement, not proof of the files.`; deleted -> existing deleted sentence; needs_attention -> `attentionMessage(row) ?? (REASONS[row.reason] ?? REFUSED)[0]`; waiting_for_connection/registering/sealed_local -> the same body sentences `RegistryRow` uses; pending unassigned -> "Sealed while signed out, so it isn't assigned to a company yet. Assign it on Seal & send."; pending held -> "Sealed under another registry sign-in, so it won't be sent under yours."; no record and `!s.owner` -> "Sign in to the company registry to see this job's registry status."; no record, signed in -> "This device has no registry record for this job under the current sign-in." `at`: `updated_at` (rows) or `p.at` (pending); null otherwise. `statusOf(job)` splits `job.receipt` on `\n`, trims, returns the first line found in the map, else the no-record status (`group: null`, label "Sealed locally", kind neutral). `filters`: `[['waiting','Waiting to send'],['registered','Registered'],['problems','Needs attention']]`. Memoize on the snapshot (`useMemo`).
  Also return `ready`: `!s.owner || s.listed` so the page-clamp effect can wait for outbox rows on reload.
- `newweb/src/main.jsx` -- import `useJobsRegistry`; `const jobsRegistry = __REGISTRY_URL__ ? useJobsRegistry() : null; // eslint-disable-line react-hooks/rules-of-hooks -- a build-time constant` near the other registry hooks (~245); pass `statusOf`, `filters`, `status={route.params.get('status') || ''}`, and fold `ready` into `loaded` (`loaded={jobsState.scope === localScope && (jobsRegistry?.ready ?? true)}`) on `<JobsPage>` (~1893). Update the comments at `:1891` and `jobs.jsx:1-4`. Do not touch other spots.
- `newweb/src/routes.mjs:44-45` -- allow `status` for `jobs` when one of `waiting|registered|problems`.
- `newweb/src/style.css:1244-1283` -- `.jobs-filter` (label above select, 44px), `.jobs-detail-row` dl grid, 320px rules (detail row block, full-width buttons). No horizontal scroll at 320.
- `newweb/tests/registry-wiring.mjs` -- add new checks in their own context (`newContext()`), inserted just before `check('no console or page errors'…)` (~line 972), so existing line cites don't shift. Reuse `signIn`, `importSeedA`, `sealSmall`, `go`, `axe`, `registerLog`, `chipIs`, `openRow`, `tokenFor`, `ctx.setOffline` + `offline` flag pattern from the offline check (`:564-586`). Header comment check count.
- `newweb/tests/jobs.mjs` -- flag-off; must stay green unchanged (may add one assertion that no `#jobs-status-filter` and no "Details" button exist).
- `AGENTS.md` -- update the registry-wiring check count (currently "29 checks").
- `_bmad-output/initiative-hashwing-aws/initiative-hashwing-aws.md` rows R22 (line 56) and R26 (line 60) -- update status/evidence with exact file:line cites and test names/counts; also the "Follow-ups still open" line (~150) and EXPERIENCE.md AC-56/AC-60 tags (`ux-hashwing/EXPERIENCE.md:655,659`): do not mark AC-56/57 fully built; list what remains (share links/delete in row detail, "{company}" label, company switch, "Last confirmed by this device").

## Tasks & Acceptance

**Execution:**
- [x] `newweb/src/routes.mjs` -- allowlist `status` -- URL state.
- [x] `newweb/src/registry-ui.jsx` -- `useJobsRegistry()` -- status from the existing snapshot.
- [x] `newweb/src/jobs.jsx` -- props, filter, detail -- generic, no registry wording.
- [x] `newweb/src/main.jsx` -- wire behind `__REGISTRY_URL__` -- flag-off unchanged.
- [x] `newweb/src/style.css` -- filter and detail styles, 320px.
- [x] `newweb/tests/registry-wiring.mjs` -- flag-on Jobs checks (below).
- [x] rebuild `docs/console` (flag off) per Boundaries; commit with it.
- [x] `AGENTS.md`, ledger R22/R26, EXPERIENCE AC tags -- exact evidence.

**Acceptance Criteria (flag-on checks to add, each in the new context):**
- Given a signed-in pilot with SEED_A imported, when one file is sealed with SEED_A (registers), one with the one-time key after "Clear key" (Needs attention, key_not_enrolled), and one signed out (pending, Sealed locally), then Jobs shows per row exactly the label the "Sealed on this device" list shows for that file, the page text contains no "Verified", and the register log count does not change while Jobs is opened, filtered and rows expanded.
- Given those rows, when the Status filter is set to Registered / Needs attention / Waiting to send / All, then only matching rows show, the URL has `status=…`, a search keeps the status in the URL, Back restores the previous filter, and an empty filter shows "No jobs with this status." with "Show all jobs".
- Given a row, when Details is opened with the keyboard (Tab to the button, Enter), then `aria-expanded` is true, the detail shows job ref, package, items, sealed time, the registry status line with its time (registered: "Registered at … UTC. This is the registry's statement, not proof of the files."), and "Copy receipt message"; Escape is not required; pressing the button again collapses it.
- Given registry sign-out, when Jobs is opened, then the rows are still listed and the previously registered row reads "Sealed locally" with the sign-in detail line (no stale Registered).
- Given 320px width, when Jobs is open with filter and an expanded detail, then axe reports 0 violations and there is no horizontal scroll (also at 1440); screenshots saved to `newweb/.test-artifacts/registry-wiring/`.
- Given the flag-off build, `node newweb/tests/jobs.mjs` (via `npm --prefix newweb run test:browser`) stays green and the flag-off scan check in registry-wiring stays green.

## Implementation Notes

- The `<dt>` "Registry status" is registry wording, so `jobs.jsx` takes it as a `detailLabel` prop (default "Status") from `useJobsRegistry()`; flag-off `docs/console` has no "Registry status", "Waiting to send" or "registry's statement".
- `jobsStatusMap`/`jobStatus` are exported pure functions (tested in `registry-session.test.mjs`); the hook memoizes them on the snapshot.

## Plan Change Log

- A Registered row's detail carries no device "Updated" time (`at: null`): its line already holds the registry's `received_at`. Other states keep `updated_at` / the pending `at`.

- `ready` is `s.listed || s.listError || (!s.owner && no saved token)`, not `!s.owner || s.listed`: on reload the owner is set only after the saved sign-in resumes asynchronously, so `!s.owner` alone was true too early and an out-of-range page could settle before the outbox rows arrived. If a saved token fails to resume, the clamp waits until the next render (the visible page is clamped anyway).
- Signed in but the outbox list not open yet, the no-record line reads "This device's registry list isn't open yet." (as the Verify time row does), not "no registry record".

## Review Triage Log

## Design Notes

Item (d), R26 "in every build": decided not to replace the flag-on registry list in this PR. The flag-on build already lists every job on Jobs with its registry status; the registry list on Seal & send is the only place for assign, retry, export/import, share links and delete. Moving those into the Jobs row detail is the prerequisite for one compact list in both builds; record it as open in R26.

## Verification

**Commands:** (run from the worktree root; build `build/fseal` first if missing: `cmake -S . -B build && cmake --build build -j`; copy `tests/.data` from `/Users/anirudhyadav/flightseal/tests/.data` if missing)
- `npm --prefix newweb run build` then the docs/console greps -- expected: one hash-worker file found, no hashwing-pending hits.
- `npm --prefix newweb run test:browser` -- expected: console, manifest-mode and jobs all pass.
- `REGISTRY_DEV_URL=http://127.0.0.1:8798 node newweb/tests/registry-wiring.mjs` (with your dev server on 8798, `--port 8798`) -- expected: all checks pass, count = old 29 + new.
- `node newweb/tests/profiles.mjs` -- expected: all pass.
- `PATH=/Users/anirudhyadav/flightseal/.venv-agent/bin:$PATH node --test tests/web/*.test.mjs` -- expected: all pass.
- `node --test newweb/tests/jobs-store.test.mjs newweb/tests/registry-session.test.mjs` -- expected: all pass.
