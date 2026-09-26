# Milestone 6 independent review checkpoint

Paused at the user's request for a Codex refresh. Resume only on explicit instruction. Review is incomplete; this is not release acceptance.

## Scope and baseline

- Exact reviewed implementation: a185cc03bae453ce2699ac7e77fa19330bc90925.
- Isolated branch: codex/milestone-6.
- Owned changes only: tests/release.test.ts and this report. No implementation or interface changes.
- Read architecture, milestones, STATUS, API contract and implementation across runtime, API, storage, context/scheduler, provider/protocol, tools, and editor/conversation UI. Further review and validation remain unfinished.

## Confirmed findings

1. **P1: Git diff credential-path bypass.** In server/tools/index.ts, gitDiff filters filenames then passes them to Git as unrestricted pathspecs. A permitted tracked filename `[.]env` expands to `.env`, leaking protected changes to tool/model/frontend output. Reproduced on Windows with synthetic credentials only. Enforce literal pathspec handling in both filename discovery and diff commands. Sent immediately to coordinator.
2. **P1: /plan during an existing run does not enforce planning-only behavior.** Runtime.submit in server/runtime.ts queues generic steering without changing existing.planOnly. An existing coder can still write. Regression starts with a pending review proposal, explicitly changes approval mode through the API, sends /plan, and observes an unauthorized planning-mode mutation. Coordinator reports a fix on main; not verified here.
3. **P2: Agent writes do not notify sibling chats.** Runtime.executePending emits file_changed only to the originating chat. server/app.ts records the project/path in recentWrites, suppressing the watcher notification. Sibling editors/agents miss the change, and sibling proposals remain pending. Reproduced with a paused sibling chat and real watcher. Coordinator reports a fix on main; not verified here.

Coordinator owns all fixes. Known historical approval invalidation, latest-events pagination, transaction event ordering and SSE shutdown work was not duplicated.

## Validation checkpoint

Node v24.16.0, native Windows. Installed lockfile dependencies in this isolated worktree with npm ci --offline --ignore-scripts (no lockfile changes).

`npm test -- tests/release.test.ts`: **3 failed, 2 passed**. Failures are ordinary regression assertions for the three confirmed findings above, intentionally left visible for coordinator validation against fixes. Passing checks cover API editor ownership/conflicts and protection across save; denied approval plus scheduler accounting for architect/coder/critic.

No typecheck, full suite or build run after adding these tests before the stop request. No browser automation attempted: the saved localhost permission verification block remains in force. No local Linux/PTY execution or live STARK validation; no credentials available. Fixture providers and synthetic temporary projects do not establish live-provider acceptance. No new user assistance requested beyond existing acceptance gates.

## Resume handoff

Coordinator can integrate tests then run them against fixed main. Re-run typecheck, full test suite and build; continue scoped review and browser/Linux acceptance only when authorized and available. Review branch may remain red until fixes are integrated. No changed shared interface assumptions. No running test or development processes were launched persistently by this review; all tool calls completed and fixture teardown closed app/database/watchers.
