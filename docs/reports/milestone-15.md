# Milestone 15 - same-chat planning bridge and evidence-linked progress

Implemented only M15 on `codex/milestone-15`, based on reviewed/published main `9b6339f`. Worktree: `C:/Users/joshu/.codex/worktrees/eef8/REACT harness` (physical junction target `D:/CodexData/.codex/worktrees/eef8/REACT harness`). Coordinator owns integration, STATUS/milestone dispatch, and final main publication. No successor, dependency, packaging, import, container or data-migration expansion.

## Behavior and review contract

Planning mode now survives finished turns and restart. Header **Plan** opens a compact, independently scrollable panel outside the transcript; **Start building** continues the same chat using its plan/history. Exact whole-message `go ahead` / `start building` intent is also accepted (case-insensitive, optional single period/exclamation mark); quoted examples, conditions and other prose stay restricted. `/plan` restores the restriction. The coordinator approved the additive contract and conservative revision policy before implementation.

`Chat.mode` and `modeVersion` bind the session. POST `/api/chats/:id/start-building` strictly requires `{planId,planVersion,modeVersion}`. The transition and user message/run commit together, and its durable receipt makes duplicate/concurrent clicks idempotent. Old receipts cannot authorize a later planning epoch. Active model responses are invalidated through existing generation/steering; active control decisions or executing/uncertain operations must settle first. Pending approvals are invalidated, saved mode is rechecked before recovered prepared dispatch, and uncertain actions are never replayed.

`Plan.id/version` and optional `delegate.planStep:{planId,planVersion,phaseId,stepId}` bind one coder frame to one exact step/revision. `PlanStep.evidence` and `plan_progress` retain delegation, outcome and durable source-event IDs; review events retain bounded tool-event references. Progress reflects actual start, tools, blockers, failures, stops/restart and completion awaiting review. Only the matching completion critic's structured pass, following coder final and recorded coder/reviewer tool evidence, can complete a current owned step. Checkpoint, unrelated, stale, legacy and unassociated reviews cannot complete or replace a plan. Critic acceptance remains a model verdict, not proof that tests passed.

The architect retains structural revision authority. Ordered IDs and titles define structural equality; identical re-emission ignores status changes and preserves progress/version. A structural edit increments revision and resets current progress to pending (or explicit blocked), retaining historical failure/uncertainty records. Model `done`/`in_progress` never becomes observed progress. Legacy plans receive identity and conservative status normalization. New steering blocks and removes the old assignment's completion authority; a fresh associated delegation is required for acceptance under changed guidance. The current snapshot and evidence event commit together; delegation creation and completion-review consumption also commit with frame state.

API/architecture/setup documents contain full contracts and limitations. No SQLite table or dependency was added. Current server responses populate the additive fields; shared DTOs leave them optional for older snapshots. Existing approval, editor lease, stale-file, project instruction, per-chat model and secret boundaries remain intact.

## Exact prompt changes

The advisor/recommendation vocabulary, role introductions, ordinary Chat Completions transport, formatting retry guidance and coder/critic action instructions are preserved.

1. `server/protocol.ts` architect action guide appends the optional `planStep?:{planId:string,planVersion:number,phaseId:string,stepId:string}` delegate argument. Parser validation adds only that strict optional object.
2. `server/runtime.ts` architect request guidance adds: `If delegation covers a plan step, add parameters.planStep={"planId":"current plan id","planVersion":1,"phaseId":"phase id","stepId":"step id"} using exact current identities. Omit it for unrelated work.` The example revision must be replaced by the exact current revision supplied in authoritative plan state.
3. Its existing set_plan line adds: `Recorded progress is owned by the application; structural revisions reset progress, identical structure preserves it.` The plan-save tool response now states the saved revision and whether progress reset or was preserved.
4. The old newly-done set_plan path no longer creates a phase-review prompt that could accept unassociated completion. A recovered legacy phase-review result retains the current plan and explicitly says so. Completion uses the existing coder-completion review prompt, with application-owned identity linking; no model mode-transition action or direct-execution claim was added.

## Coordinator review correction

Independent review of initial delivery `f49c4121d5f53562688b93eff43db7801ad5a037` found that its claimed atomic delegation creation was not implemented: progress could commit before the run snapshot. Coder final/review creation had the same gap. Submission also mutated cached permissions and queued a loop before the database commit, allowing a rolled-back build transition to leave a live loop in execution mode. The initial report overstated these boundaries; this correction supersedes that claim.

Submission now prepares a separate run draft without changing cached permissions, generation, steering or frames. Durable mode, message, receipt and run commit first. Only then are the changes published to the live root and the loop launched. Active submissions preserve existing frame identities; failed writes/commits leave the objects already held by an in-flight provider request untouched. Delegation creation, coder-final/completion-critic creation, and accepted-review consumption use cloned run drafts and one transaction for frame state, ownership and progress/events; the live root is updated only after successful commit. No speculative cache mutation needs to be repaired on rollback.

Twelve new deterministic regressions inject failures after the run write reaches SQLite and immediately before COMMIT. They cover both button and whole-message build intent during an active planning request, idle build failures that must never queue provider work, orphan-free delegation creation, coder-final/review creation rollback, and accepted-review consumption rollback. Assertions check durable mode/messages/receipts/events, live root/frame state, absence of emitted orphan events and no writes when the pending provider reply resolves. Current full checks pass as listed below. No prompt, UI, API contract, branding or scope expansion accompanies this correction.

## Validation

Native Windows, Node `v24.16.0`:

- `npm run typecheck`: passed.
- `npm test -- --reporter=dot`: **495 passed, 15 skipped**, 33 test files passed / 2 opt-in files skipped. Final suite completed in 23.99 seconds.
- `npm run build`: passed; existing large Monaco/chunk advisory remains.
- `git diff --check`: passed (Git reports existing LF-to-CRLF normalization notices).
- Added 38 runtime/API/store planning cases and 2 panel-render tests, including 12 persistence fault-injection cases. Coverage includes mode persistence and physical DB reopen/backfill, explicit/quoted intent, no-plan refusal, duplicate/concurrent/restarted requests, stale mode epochs and plan revisions, in-flight generation invalidation, approval invalidation, uncertain recovery, prepared-write mode enforcement, tool-success versus completion, missing evidence, failures/repair limits, exact critic identity, legacy/checkpoint reviews, new delegation ownership, revised reused IDs, protocol/API injection and escaped/omitted source evidence. Existing full-suite stale-file, steering, approval, project removal, provider settings, secrecy and restart regressions remain passing.

Failed attempts retained in this report: initial sandbox `npm ci` ended with npm's `Exit handler never called`; host retry succeeded. Initial sandbox test execution failed loading temporary transformed modules (`ENOENT`) and realpath (`EPERM`), so it is not counted as a code pass. The first production build caught a Windows-script encoding error in newly added middle-dot text; UTF-8 was fixed, and host build also avoided the sandbox Monaco realpath failure. The first host full suite had 477 passes and one outdated exact delegate-guide assertion; the assertion now checks the intended optional argument and the final full suite passes. No test was weakened to accept invalid execution.

## Background Chrome evidence

Used Chrome Hands Free only, a task-owned background tab and `tests/planning-browser-fixture.ts`, which creates a temporary project/database with explicit synthetic provider responses. No user files, real API credentials, live provider requests, OS input, focus-control fallback or unrelated tab navigation.

Observed on the initial production UI/backend candidate `f49c412` before the coordinator persistence correction:

- Plan initially collapsed, reachable in stable chat header. With the long transcript at scrollTop 1338, the Plan button remained at viewport top 22.5px; the panel is outside `.conversation-scroll`.
- Start building changed the same chat to execution and reached idle with one accepted step. Durable progress sequence was `started`, `working`, `reviewing`, `accepted`, with a matching review source event. UI showed `1 / 1 steps` and evidence/history disclosures.
- An unsent composer draft retained its exact text and DOM identity through transition and toggles. Open Monaco editor DOM identity also remained unchanged.
- Closing the panel and Escape from inside it returned focus to the header Plan control.
- A same-origin 390x844 iframe exercised actual narrow viewport CSS: document width 390, panel bounds 0..390, visible Plan control, and Start building button within x=215.30..330 and y=118..159. This is a browser viewport check, not physical mobile acceptance.
- After `/plan`, replaying the old build receipt returned HTTP 409 with the stale planning-session message.
- Replayed the core same-chat transition before initial delivery. The coordinator persistence correction is covered by the new fault-injection/full regression runs; this browser pass was not rerun against the corrected backend. UI source is unchanged.

Browser limitations: Monaco's background automation click on the editor textbox timed out, and the subsequent scoped keyboard/focus attempt did not establish a dirty buffer. A Chrome aria-hidden focus warning followed that forced Monaco focus attempt. Mounted-editor preservation is verified; actual dirty-editor typing/toggle acceptance is not claimed. No screenshot/pixel audit or physical-device test was performed. Recent plan history retains the existing 1,000-event HTTP bound and explicitly labels omitted source evidence; old events remain in SQLite. Fixture tabs/processes and their exact temporary directories were cleaned up.

## Acceptance limits and handoff

Linux/WSL/PTY and exact candidate GitHub Linux CI were not run by this child; the coordinator must validate integration on Linux. Windows platform skips are not Linux passes. Live STARK remains the known work-only acceptance gate and is not an implementation blocker. Model semantics, critic quality and real workload acceptance remain separate from deterministic synthetic-provider tests.

No genuine user-assistance blocker. Preserve this branch/worktree for review. Coordinator receives the exact committed SHA and publication result in the handoff message; no main merge or successor work is authorized here.
