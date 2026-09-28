# Milestone 11 — on-demand terminal

## Delivery

Branch: `codex/milestone-11`. Reviewed base: `c503eae294057d2de619e58d5a2f3e22a9f07a68` (M10 integration `466524d`). Child chat: `01a0e64b-5b04-78c2-af86-720ab6240cbc`. Scope is M11 only; coordinator owns main integration, STATUS/milestones/architecture/acceptance records, tracker closure and scheduling. No preparation branch was merged.

Terminal beside Files opens an initially closed read-only panel within the selected conversation. Its toggle and close button only update local React state. Conversation/editor components stay mounted; the keyed conversation resets terminal visibility on chat switching and filters evidence by chat ID. Without a selected chat, Terminal is disabled. The existing Tests drawer, actionable chat errors, approvals, Debug Activity and Settings remain available.

Commands are grouped by exact durable action ID with frame/role and logical shell session metadata. The panel shows command text (Python source for execute_python), recorded lifecycle and exit evidence, captured output, uncertainty, cancellation/timeout, shell reset, missing starts and truncation. It does not display ordinary internal agent commentary. Legacy/unmatched command events remain explicitly unassociated. Output is escaped text with common ANSI/control sequences removed; no interactive input, emulator or shell side effect is attached to the panel.

## Contracts and persistence

Coordinator approved the additive interface proposal before shared edits:

- New typed `CommandEvent` on existing `command` SSE/durable events: commandId, agentId, sessionId, role, action, status and optional output/exit/cancellation/timeout/reset/truncation/message evidence.
- Existing `tool` and `tool_output` retain their fields and gain commandId/sessionId; output chunks also carry a truncation flag. Optional `ChatDetail.eventsTruncated` reports actual history omission. `CommandOutput` documents optional IDs for legacy compatibility.
- No SQLite schema, endpoint, dependency, approval/security policy, model protocol or editor-lease changes. Existing event history, HTTP detail refetch and SSE replay remain authoritative.
- Internal optional `PendingAction.commandOutcomeRecorded` is committed with terminal evidence. Dispatch intent/start is atomic with executing; outcome is atomic with done. Recovery emits uncertainty for executing commands even in paused chats, persists an idempotence marker, preserves recovery stage and never reruns execution. Completed records are not reclassified by restart.
- Session identity is a logical shell slot within a chat/project, not a unique persistent OS process. Shell-reset notices preserve that distinction. Existing shell behavior is unchanged except preserving its truncation flag through abnormal outcomes.

`completed` requires command exit 0 and `failed` a nonzero command exit. A stopped request alone is not interruption evidence. Cancellation/timeout tool outcomes are `interrupted`; missing exit evidence, execution exceptions and lost command boundaries are `uncertain`. A shell-process exit is not exposed as the command exit. A test command with exit 0 but an unavailable/invalid report still shows Completed / Exit 0, a separate tool-problem message, and the existing erroneous structured report.

The latest 1,000 events feed the panel. Stream chunks retain at most 16,000 characters and each projected command at most 64,000. A final real output snapshot (also capped at 64,000) replaces overlapping streamed chunks; missing snapshots preserve streamed evidence. Diagnostics retain 16,000 characters plus fixed labeling. Backend/tool limits and UI limits are flagged. Legacy entries show at most their last 16,000 characters. This milestone does not add archive pagination or retention cleanup; event rows remain in SQLite.

## Validation

Windows, Node `v24.16.0`, fresh `npm ci --ignore-scripts --no-audit --no-fund` without dependency changes:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed after correcting the new test fixture's required models/chat arguments |
| `npm test` | 359 passed, 13 platform skips; 24 test files passed, 2 skipped |
| Focused M11 runtime + UI tests | 23 portable tests pass; one real-PTY test skips on Windows (included in full suite) |
| `npm run build` | Passed; existing large Monaco bundle warning remains |
| `git diff --check` | Passed |

Runtime tests exercise atomic event/state visibility, sequential commands in one shell, exact output identity, no duplicate legacy entries for new commands, stop-request versus actual outcome, completion arriving after pause, late callbacks, throw-after-output retention and no replay, run_tests exit/report distinction, missing exit and actual output bounds. SQLite close/reopen twice verifies durable, idempotent recovery and preserved partial output. History truncation checks use actual event counts.

Projection/markup tests cover SSE-style duplicate event IDs, final snapshot replacement, cross-chat/session/agent rejection, missing starts/completions, legacy output, unknown outcomes, repeated starts after outcomes, empty captured output, truncation, Python source, timeout/reset notices, escaped console markup and hidden critic/read-tool prose. Source-contract tests verify the local toggle, default closed state, retained Tests drawer and keyed chat isolation. Existing full-suite SSE Last-Event-ID, release, M8 settings, M9 guidance, M10 changes/undo and editor safety tests remain green.

## Acceptance limits

No actual browser interaction or visual acceptance is claimed. The previously reported saved-localhost permission-verification block was respected; no alternate browser/computer-use route was attempted. Source/markup assertions are not browser evidence.

No local Linux/PTY execution is claimed. The new Linux-only case checks actual PTY empty output, nonzero exit and output truncation; coordinator must run it with the existing Linux/PTY suite on the exact integrated candidate. No ordinary Linux distro was installed and Podman's distro was untouched.

No live STARK validation is claimed; work-network/provider access remains deliberately deferred. No credentials or project contents are needed for these independent checks. No new user-assistance blocker or scheduler was introduced. Public push is limited to the authorized milestone branch; remain idle for coordinator review after delivery.
