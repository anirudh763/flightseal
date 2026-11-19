- source_plan: `_bmad-output/initiative-hashwing-aws/plan-simpler-nav.md`
  summary: newweb/tests/profiles.mjs fails 3 of 7 checks (waits for a "Try Live Demo" button and a `.landing-navigation` "Create account" link that no longer exist).
  evidence: same 3 failures on unchanged main c375509 in a clean worktree; suite is not run in CI.
- source_plan: `_bmad-output/initiative-hashwing-aws/plan-simpler-nav.md`
  summary: AGENTS.md says tests/web/e2e.mjs has 6 checks; the file defines 5.
  evidence: grep of `await check(` in tests/web/e2e.mjs returns 5; all 5 pass.
- source_plan: `_bmad-output/initiative-hashwing-aws/plan-fix-lost-work.md`
  summary: RESOLVED. profiles.mjs 3/7 was stale selectors from the simpler-nav change, not lost work ("Create account" / "Log in" moved to `.landing-persistent-actions`, "Try Live Demo" became "Run real verification" which stays on the landing page, the record list opens on page 1, and "Create account" appears twice on the login page). Selectors fixed; 8/8 (7 checks plus the browser-error check).
  evidence: `node newweb/tests/profiles.mjs` on fix/lost-work.
- source_plan: `_bmad-output/initiative-hashwing-aws/plan-fix-lost-work.md`
  summary: No browser test of a proof held under another registry owner (it needs a full 200-row queue); covered in Node by registry-session.test.mjs.
  evidence: registry-session.test.mjs "an unsent proof keeps the registry owner it was sealed under".
- source_plan: `_bmad-output/initiative-hashwing-aws/plan-fix-lost-work.md`
  summary: private-lifecycle.mjs (which drives `WorkspaceStore.logout`) is not run in CI; it needs the served web app with persistence on. Its new check "server logout keeps unsaved sealed output..." passed locally (20/20) against tools/http_server.py on 127.0.0.1:3911 with this branch's docs/.
  evidence: `HASHWING_BASE_URL=http://127.0.0.1:3911 node newweb/tests/private-lifecycle.mjs` on fix/lost-work.
- source_plan: `_bmad-output/initiative-hashwing-aws/plan-fix-lost-work.md`
  summary: Pending-proof IndexedDB has no Node unit test (no IndexedDB in Node); it is driven in the browser by registry-wiring.mjs (reload keeps the proof, another-tab logout then log back in shows it). A removed local profile's pending database is not deleted; a selected File cannot survive reload (the page now says to choose it again).
  evidence: registry-wiring.mjs 28/28 on fix/lost-work.
- source_plan: `_bmad-output/initiative-hashwing-aws/plan-fix-lost-work.md`
  summary: (PR #37 review 5) An app logout writes no profile-scoped marker, so a discarded or restored tab of that local profile that missed the logout message does not log itself out when it reopens (the registry sign-out marker covers only registry sign-out).
  evidence: review of 9c46754; local-auth announceLocalLogout is BroadcastChannel only.
- source_plan: `_bmad-output/initiative-hashwing-aws/plan-fix-lost-work.md`
  summary: (PR #37 review 6) The registry sign-out marker compares wall-clock times: a clock jump between sign-in and sign-out can mis-order them, and with more than 50 owners the oldest entry is evicted, after which a restored tab of that owner can reuse its saved token.
  evidence: review of 9c46754; `markSignedOut` keeps the newest 50.
- source_plan: `_bmad-output/initiative-hashwing-aws/plan-fix-lost-work.md`
  summary: (PR #37 review 9) The "choose them again" reload notice does not cover the large-file picker, and it also shows after a seal has completed (the chosen file stays set). A reload while a seal is still running now warns (busy or large-file seal active).
  evidence: review of 9c46754; main.jsx `hashwing-files-chosen` tracks protectFile, checkFile and logFile only.
- source_plan: `_bmad-output/initiative-hashwing-aws/plan-fix-lost-work.md`
  summary: (PR #37 review 10, 3) Untested: a denied IndexedDB open (falls back to memory, covered only by the no-IndexedDB test), clipboard or download failure on the kept-work paths, the per-file buttons after a zip failure, and the retry of an owner's pending proof when its full queue gains room (needs a registry that acks; code calls flushOwned on every outbox change). A failed pending-store write (quota) is covered by registry-session.
  evidence: registry-session.test.mjs "the pending store refuses a full store…".
- source_plan: `_bmad-output/initiative-hashwing-aws/plan-trust-company-keys.md`
  summary: The flag-off Trust and limits sentence "Company sign-in isn't part of this copy of HashWing." (AC-50, design §6) is not added: it changes flag-off text, which the plan keeps unchanged.
  evidence: plan "Never" list; `newweb/tests/registry-wiring.mjs` flag-off check asserts the Trust headings only.
- source_plan: `_bmad-output/initiative-hashwing-aws/plan-trust-company-keys.md`
  summary: The compromise dialog says "Older proofs from it will show a warning." (plan copy). Verify does not read registry key state, so a recipient sees that warning only after marking the key compromised in their own Trusted companies list (R35, design PR 2).
  evidence: `newweb/src/company-keys.jsx` compromise dialog; `recipient-trust.mjs` and `trusted-keys.mjs` unchanged.
