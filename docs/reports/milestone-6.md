# Milestone 6 independent integration review

Independent review delivery is complete for the assigned baseline. Release acceptance remains coordinator-owned and is not claimed: two follow-up regressions remain red on this branch, and browser/live-provider/current Linux acceptance must be evaluated separately.

## Reviewed revisions and ownership

- Initial implementation: a185cc03bae453ce2699ac7e77fa19330bc90925.
- First review checkpoint: b5acfd4d65a53131e5e8a6b1ff1fdedc8c168311 (integrated by coordinator separately).
- Coordinator fixes af1dfde18be07716da5d66978690f6f1d46cd5a2 merged locally into codex/milestone-6 at ef68f0b00a00d9e049c9b43faef1fb534c918b70.
- Authored changes are limited to tests/release.test.ts and this report. No implementation edits, shared interface changes, merges to main, or M7 feature changes.

Read architecture, milestones, STATUS and API contract. Reviewed runtime action/approval/cancellation/recovery paths, SQLite persistence, managed context and scheduler, provider/protocol, server request guards/SSE/watchers, workspace path/Git/shell/JUnit boundaries, and client editor/conversation API interactions. Existing suites were inspected for coverage. This is a bounded engineering review, not a claim that every race or security issue has been excluded.

## Findings and exact reproduction coverage

| Finding | Trigger and impact | Review status |
| --- | --- | --- |
| P1 Git pathspec credential bypass | server/tools/index.ts gitDiff passed allowed filenames back to Git as patterns. A legal tracked `[.]env` expanded to protected `.env`, exposing its diff. Reproduced using synthetic temporary content only. | Coordinator --literal-pathspecs fix verified by passing regression after af1dfde merge. |
| P1 /plan during active implementation | server/runtime.ts submit previously treated /plan only as generic steering; an existing coder could mutate under autonomy. | Coordinator planOnly update verified by passing regression. |
| P2 sibling chats miss agent edits | Agent writes only notified originating chat and watcher suppression prevented sibling notification/approval invalidation. | Coordinator cross-chat notification fix verified by passing regression. |
| P2 historical approvals exhaust context | server/context.ts:68 attaches every historical approved record, including full action and diff, to noncompactable authoritative controls. Completed edits eventually prevent even small later requests. Test seeds eight completed approvals with 1500-byte edit content, selects 24k architect capacity, and submits a short follow-up: runtime errors before dispatch. | Reproduced at merged baseline. Coordinator reports active prepared-approval filtering fix on main; not imported/verified here. Regression starts at tests/release.test.ts:137. |
| P2 real external save suppressed | server/app.ts:45 drops every watcher event within 1000ms of an editor/agent save to that path. A distinct external save immediately after PUT is ignored, leaving editor/agent context stale. Hash checks still protect later stale writes. Test starts real watcher, PUT saves, changes file via fs.writeFile, waits 450ms: disk changed but no external event exists. | Reproduced at merged baseline and reported immediately. Replace blind time suppression with content/version deduplication or delayed recheck. Regression starts at tests/release.test.ts:235. |

All findings were sent to coordinator as confirmed. Existing historical-approval invalidation, latest-events pagination, transaction-event ordering and SSE cleanup fixes were not duplicated.

## Meaningful checks

Node v24.16.0 on native Windows. Locked dependencies installed with npm ci --offline --ignore-scripts in this isolated worktree. No dependency/lockfile changes. Tests use synthetic temporary projects and fixture model responses.

- npm run typecheck: passed.
- npm test: **218 passed, 2 failed, 10 skipped** (230 cases). Exactly the historical-context and external-save regressions above fail; they remain ordinary assertions, not expected-failure or skipped tests.
- npm test -- tests/release.test.ts: **8 passed, 2 failed**.
- npm run build: passed; Vite reported the existing large Monaco bundle warning. Generated build artifacts remain ignored and uncommitted.

Additional passing integration checks prove editor API lease ownership/stale conflict handling and lease retention across save; denied actions do not execute; architect/coder/critic requests share budget accounting; interrupt rejects a late otherwise valid model write and conservatively charges its request; reopening SQLite reconciles an executing shell without invoking it again; real HTTP SSE honors Last-Event-ID and terminates cleanly during backend shutdown. The initial five tests all pass after coordinator fixes.

## Delivery limits and integration instructions

Cherry-pick the final follow-up commit onto coordinator main; its parent merge need not be integrated. The follow-up commit modifies only the two assigned files. tests/release.test.ts also includes the coordinator's helper payload type correction to Record<string, unknown>.

Coordinator must run the delivered regressions against main with its context fix and an external-change fix, then rerun required combined checks. M7 workspace/directory APIs and redesigned UI are outside this reviewed revision. No shared interface assumptions changed.

Browser automation was not attempted because saved localhost permission verification remains blocked; no alternate browser/Playwright bypass was used. No live STARK credentials were present, and fixture validation is not live-provider acceptance. No local Linux/PTY check was performed; ten tests are platform-skipped. Coordinator-reported Linux CI results were not independently rerun here. These are remaining acceptance gates, not successful validations.

All review test/build commands completed. No persistent review dev server or process remains. Temporary fixture apps, SQLite connections and watchers are cleaned up. The managed worktree is retained for further authorized review.

## Coordinator integration validation

The regression suite is integrated on main at c0fc99a with implementation fixes. All ten independent release tests pass: historical approval context growth, rapid external saves, original Git/plan/cross-chat findings, editor conflicts, denial/budget accounting, cancellation, uncertain restart actions and SSE replay/shutdown. Editor-change events now include a content hash; the assertion accepts this additional metadata while still requiring the external-change event. Integrated full suite after M7: 237 passed, ten platform/fixture skips; typecheck and build passed on Windows. Linux final-SHA CI and visual/live-provider gates are recorded in STATUS.
