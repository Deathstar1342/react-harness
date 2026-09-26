# Milestone 5: context management and account scheduling

Implemented on `codex/milestone-5`, based on `ec959650cb11dd948e6d2db692c79d85564043bf`.
Worktree: `C:\Users\joshu\.codex\worktrees\milestone-5\REACT harness`.

Only the assigned files are changed: `server/context.ts`, `server/scheduler.ts`, their two test files, and this report. Main integration and acceptance remain coordinator-owned.

## Behavior

- `createManagedHooks(provider, store, config, options?)` exports the runtime hooks for protocol parsing/instructions, message preparation, and scheduled completions. Options are `compactionThreshold` (default 0.7) and per-role `promptExtensions`. No shared type, API, dependency, or configuration-file change is required.
- Each frame retains its system instructions, original assignment, literal human turns and corrections, delivered steering, and four recent messages. Plans, pending actions, current approvals, objective, repair count, queued steering, generation, and all additional non-message Frame fields are supplied separately as authoritative runtime controls.
- Context capacity reserves output and tool-result space. Older history is summarized by actual model requests; oversized source is split at Unicode code-point boundaries, and reduction has at most four passes. Empty, truncated, oversized, non-reducing, or still-unfit results fail without replacing the frame. Protected context that cannot fit fails explicitly instead of being silently truncated.
- Full original frame snapshots are stored under `context:archive:<chat>:<frame>:<hash>`. Summaries under `context:summary:<chat>:<frame>:<hash>` retain their source/retained messages and archive reference. Completed intermediate summaries use `context:part:` keys. `context_summary` events expose the summary and artifact references through the existing Store event interface. User-facing messages are never deleted or rewritten. No new retrieval endpoint or summary browser panel is added.
- Compacted `frame.messages` contains an explicitly untrusted continuation summary, artifact references, and retained messages. Runtime must save the frame after preparation, as the assigned baseline already does. Summary artifacts and intermediate fragments are reusable after restart, including a crash between artifact commit and frame save. Concurrent identical preparations on one hook instance share work. Concurrent frame modification is detected before replacement.
- `BudgetScheduler` uses Store transactions and one account ledger (`scheduler:account:v1`) across chats, roles, and scheduler/Store instances sharing the database. It enforces rolling request/minute, token/minute and token/day limits. Coder requests cannot consume the final 20% of budget capacity, and coder concurrency leaves one of the default four active request slots available to other roles. Architect, critic, and compaction/control requests can use that headroom.
- Every completion is reserved before dispatch. Valid provider-reported input/output usage replaces the estimate; missing or invalid usage retains the conservative estimate. Estimates use one token per UTF-8 byte plus message framing and the requested output allowance. Uncertain/error/aborted calls retain their charge. Settlement timestamps conservatively cover calls spanning window boundaries.
- Pending reservations persist a 120-second request deadline. After restart they remain charged, then become uncertain charges at that deadline and age out through the rolling windows. They are never automatically replayed or immediately refunded. Impossible requests fail immediately; other capacity waits are bounded to 60 seconds and remain cancellable. In-flight cancellation/timeout aborts the provider signal and returns even if a provider neglects to settle its promise. Late completion cannot refund an uncertain charge.

## Required integration assumption

**Construct the production StarkProvider with `maxRetries: 0`.** The coordinator explicitly agreed to add this option and wire it in bootstrap. This milestone reserves exactly one request and one token estimate per `provider.complete` invocation. Internal transport retries would bypass those reservations. The milestone intentionally does not retry transient provider failures; they surface to the runtime for explicit resume, with each subsequent attempt requiring a fresh reservation. This also allows approximately one-million-token reservations under the configured 1.5M TPM instead of an unusable fixed three-attempt reserve.

Instantiate one managed hook set for the runtime, passing existing configured prompt extensions if desired. Both ordinary generation and compaction use the same persisted ledger. The ledger covers calls through these hooks, not traffic from other applications/account clients or direct `/models` discovery. Provider implementations must respect the supplied abort signal to stop transport activity; the scheduler can bound its own waiting but cannot forcibly terminate arbitrary custom provider code.

## Critic review coordination

The assigned baseline already enforces read-only critic tools, structured review verdicts, coder completion review, and two bounded repair attempts. I reported missing automatic phase/final/failure/scope checkpoints to the coordinator without editing runtime. The coordinator reported adding shell/Python/test checkpoints, repeated-action-failure checkpoints, critic-gated completed plan-step transitions, and delegate path scope enforcement in its own work. Those integration changes are outside this branch and require coordinator validation. Added Frame metadata is carried into authoritative context automatically.

## Validation

Windows, Node.js v24.16.0, installed from the existing lockfile with `npm ci`:

- `npm run typecheck`: passed.
- `npx vitest run tests/context.test.ts tests/scheduler.test.ts`: 26 passed.
- `npm test`: 154 passed in 8 files.
- `npm run build`: passed.
- `git diff --check`: passed before commit.

Tests include real SQLite reopen/restart, separate connections sharing reservations, rolling window boundaries, daily exhaustion, impossible budgets, headroom, in-flight and queued abort, ignored-abort timeout, usage reconciliation, one-million-token feasibility, Unicode estimation, scheduled real-hook summary generation with fake providers, source preservation, independent role summaries, exact old corrections, concurrent preparation, summary reuse after restart, compaction cancellation, concurrent guidance, bad summary rejection, and runtime integration proving summary prose cannot grant approval or execute an action.

No live STARK credentials were available, so provider-specific summary quality, tokenizer accuracy, and live throttling behavior are not claimed. No Linux/WSL/PTY or browser interaction validation was performed for these backend-only changes. Existing automated provider/protocol/runtime tests passed in the full suite. There are no user-assistance blockers.

## Operational limits

Conservative UTF-8 estimates may compact earlier or charge more than actual model usage. Preserving all literal user corrections can eventually fill the configured context; this fails visibly rather than erasing constraints. Archives are retained indefinitely and may need a separately designed retention/export policy. Daily budget exhaustion returns a resumable failure after the bounded wait instead of leaving an agent asleep for hours. Scheduling coordinates one backend database/account, not distributed installations with different databases.
