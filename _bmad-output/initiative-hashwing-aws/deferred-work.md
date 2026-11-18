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
  summary: The workspace-server sign-out path (`WorkspaceStore` onLogout) keeps unsaved work for one download, but no test drives it.
  evidence: only reachable with a self-hosted workspace server; not in the console browser suites.
