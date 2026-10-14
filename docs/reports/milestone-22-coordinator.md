# M22 independent coordinator review

Candidate source `01ff6a8fd5c74af642d521c8e0a770aa7406960f`, assigned `codex/milestone-22`, isolated worktree `8cbf`, baseline `7bee8bc`. Not accepted or integrated. M21 packaging and its separate uncommitted source/notices work remain paused and untouched.

## Independently verified

- Clean source candidate at review start; baseline diff check passed. Source removes production references to legacy prose extraction/advisor normalization/format-repair parsing. Minimal native role guidance remains; M23 deeper prompt work is separate.
- Coordinator `npm run typecheck`, `npm run desktop:build` and full portable tests passed: **664 passed / 0 failed / 33 platform skips**. The actual JSON report is retained locally under the physical D: visualization directory `m22-coordinator-temp/tests.json`; no installed app, WSL backend or privileged workstation mutation. Existing large Vite chunk advisory remains.
- Source review covers native call assembly/history validation, central registry and execution boundaries, isolated install reviewer, context group accounting/compaction, profile marker rejection, recovery and clone/COMMIT transitions. Tests passing do not waive the findings below.
- Exact-source job/step verification: [Validate 38636289647](https://github.com/Deathstar1342/react-harness/actions/runs/38636289647) and [helper 38636289559](https://github.com/Deathstar1342/react-harness/actions/runs/38636289559) passed every required step. [Desktop 38636289519](https://github.com/Deathstar1342/react-harness/actions/runs/38636289519) Windows job `116100180423` passed, Linux job `116100180006` failed its real Electron/dedicated-backend step. The failure is retained; no claim that the combined desktop workflow passed.

## Requested corrections

1. Remaining `executePending` branches mutate already-cached pending result/stage/approval before durable persistence: install waiting/result, executing interruption recovery, rejected/stale approvals, plan-only rejection and stale-file outcome. Extend the clone/post-COMMIT pattern across those transitions and associated parent evidence/progress/status. Test after-write and pre-COMMIT rollback for the exact branches, checking cache and database/native correlation together. An actual side effect must retain uncertainty on failed outcome persistence; never replay it or claim it was not started.
2. Ordinary assistant content plus an empty native `tool_calls:[]` should represent zero calls. Accept absent/null/empty arrays without executing anything; continue rejecting `finish_reason:tool_calls` with zero calls, empty content with no calls, malformed elements/conflicting IDs/refusal/truncation. Child diagnosed the Linux smoke's synthetic ordinary-reply failure at this boundary. Fix native handling and add regressions instead of solely removing the array from fixtures. Refresh Settings lane labels and outdated request-count/timeout copy.
3. Enforce registry result/output/data bounds on actual handler paths. A malformed result after a possible side effect must not become false success, false not-started evidence or automatic replay.

Child acknowledged these corrections and is implementing them locally. Corrected source, targeted tests and complete applicable exact-source CI are still required. Keep earlier failed test/CI evidence. No credentials or user assistance are needed for this work; live STARK and actual installed-device acceptance remain separately deferred.
