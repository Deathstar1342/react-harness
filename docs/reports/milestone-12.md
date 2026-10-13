# Milestone 12 — Error presentation and focused runtime corrections

Delivered for coordinator review on 2026-10-13. This report belongs to the M12 implementation commit; use `git log -1 --format=%H -- docs/reports/milestone-12.md` to identify that candidate. The exact SHA is also sent in the coordinator handoff.

- Branch: `codex/milestone-12`.
- Worktree: `C:/Users/joshu/.codex/worktrees/14ad/REACT harness` (junction resolves under `D:/CodexData/.codex/worktrees/14ad/REACT harness`).
- Base: `d3bd8fc290427e866f504f48a458321eca4b8b30`, including user-tested `init_test` at `b12bb53`. No reset to remote main and no integration into main.
- Scope: M12 only. Coordinator STATUS/milestones, provider settings, deletion and plan features are unchanged.

## Changes and evidence

Historical event-only failures now appear at their recorded transcript position, using retained message event order and timestamp fallback for omitted message events. New caught policy/inspection failures are durable tool messages. Error/tool events reference exact message IDs; replayed events are deduplicated by event ID. Identical text never establishes identity. Legacy unlinked errors may remain duplicated alongside old messages rather than being silently suppressed. Missing linked messages remain visible, and retained tool messages survive event-window omission.

The composer keeps current connection/request failures separate. Refresh resolves connection errors; local action errors have a Dismiss control and clear on a subsequent action. Dismissal does not change persisted evidence or approvals. The stopped-run notice follows current run status. Active approval cards, failed tools, uncertain/interrupted command evidence and structured test results remain visible with Debug off.

The bounded false-failure investigation followed `WorkspaceTools.runTests` through runtime feedback, transcript labels and existing M11 command lifecycle evidence. A reproducible case returns `ok:false` with exit 0 when JUnit evidence is unavailable/invalid. Chat and model feedback previously labelled the whole action failed. They now preserve command exit success while explicitly showing the separate tool/report problem; test-report status remains error. Nonzero exits, uncertainty and actual cancellation/timeout remain distinct. No live STARK or user-workspace failure trace was available to establish any other cause; no speculative tool/provider rewrite was made.

Checkpoint pass text no longer declares the preceding failed action successful. It preserves recorded failures/uncertainty and includes critic findings. Tests exercise both three failed executions and three failed inspections before a passing checkpoint, confirming all three failed results remain in the resumed model context and transcript.

The parser recovery helper now unwraps only a whole-message, newline-delimited triple-backtick fence with optional `json` label and a complete schema-valid response. It never scans for objects inside arbitrary prose, arrays, examples or unfinished outer JSON. The ordinary complete-object parser, advisor normalization, action schemas and runtime policy/approval checks remain intact. Prefix tests cover every truncation of an outer object containing a valid nested recommendation. Runtime tests prove zero tool inspection/execution/approval on repeated rejected examples, fresh format repair dispatches only the new recommendation, and fenced proposals still obey role restrictions and approval denial.

Removed unconditional recovered-content and proposed-plan/action logging. Sanitized parser failures still become durable actionable run errors after the existing four attempts (initial plus three format retries). Advisor prompts, latest-user guidance and retry wording are preserved; only observed-outcome and checkpoint feedback changed.

The three known baseline assertion failures were reconciled without changing product prompts or diagnostics: role tests now assert advisor wording, exact recommendation fields, evidence requirements and role-specific allowed actions. Both streaming and non-streaming connection tests assert the actual model sequence `a, c, c, r`, the coder-only format repair conversation, all four usage reservations, sanitized results and no tool execution or chat creation.

## Changed interfaces

Documented in `docs/api-contract.md`:

- Optional `messageId` on newly emitted runtime `error` and result-bearing/rejected `tool` events.
- Optional tool message metadata `commandId`, `commandStatus`, `exitCode`, or `rejected:true` for policy/inspection rejection. Existing `Message.metadata` accommodates these without shared-type changes. Command status derives from existing M11 evidence rules, not model prose or `ok` alone.
- No new endpoint, database migration, dependency, shell environment or permission change. Legacy records need no migration. Old unlinked events cannot be safely assigned an identity; old event-only errors outside the existing 1,000-event response window remain an existing history limitation.

## Validation

Final source checks on Windows, Node 24.16.0:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | 399 passed, 13 skipped; 27 test files passed, 2 skipped (412 tests total) |
| `npm run build` | Passed; existing bundle-size warning remains |
| `git diff --check` | Passed |
| Focused parser/runtime/settings/UI subset | 120 passed before the four rendered Conversation regressions were added; final full suite includes them |
| Rendered Conversation and chronological error helper subset | 9 passed |

New tests are in `tests/runtime-m12.test.ts`, `tests/ui-errors.test.ts`, and `tests/ui-error-render.test.ts`, plus additions to protocol tests. Rendered component checks cover chronological placement outside the composer, escaping, current connection recovery, stopped-run status changes, pending approval controls, uncertainty and exit-0/report problems. These are server-rendered React checks, not browser interaction acceptance. Existing integration, restart, terminal, approvals, freshness and release regressions also passed in the full suite.

Initial sandbox attempts were unsuccessful: npm reported `Exit handler never called`; Vitest encountered temporary SSR module ENOENT errors and localhost transport failures; Vite encountered EPERM resolving a Monaco worker. Normal-access reruns installed the unchanged lockfile, passed focused/full tests, and built successfully. The initial new test code also had two TypeScript fixture typing errors, corrected before final validation. No failed attempt is claimed as a pass.

Linux/WSL and real PTY checks were not executed here; the 13 Windows platform skips remain. No actual browser interaction, visual/device acceptance or live STARK validation is claimed. Existing lockfile install reported five dependency audit findings (two low, one high, two critical); dependencies were not altered within M12. No credentials, local databases, user project contents or generated build artifacts are included in the delivery.

Coordinator owns independent review, integration and exact Linux CI. No genuine user-assistance blocker remains. Child remains idle after the committed handoff.
