- source_plan: `_bmad-output/initiative-hashwing-aws/plan-simpler-nav.md`
  summary: newweb/tests/profiles.mjs fails 3 of 7 checks (waits for a "Try Live Demo" button and a `.landing-navigation` "Create account" link that no longer exist).
  evidence: same 3 failures on unchanged main c375509 in a clean worktree; suite is not run in CI.
- source_plan: `_bmad-output/initiative-hashwing-aws/plan-simpler-nav.md`
  summary: AGENTS.md says tests/web/e2e.mjs has 6 checks; the file defines 5.
  evidence: grep of `await check(` in tests/web/e2e.mjs returns 5; all 5 pass.
