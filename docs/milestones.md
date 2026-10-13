# Delivery milestones

## Approved M12–M15 sequence (2026-10-13)

Delivery: all four milestones are reviewed, integrated and published on GitHub main with exact Linux CI passing. M15 integration `141d8f4` passed run `38375035736`; detailed evidence and acceptance limits are in STATUS and each milestone report. A separately approved small visible-name/logo follow-up to **abysSUS** follows M15; it is not an additional numbered milestone. Containerization and executable packaging remain deferred.

The user reports that `init_test` works with STARK at work and authorizes bringing it into `main` (this repository has no `master`). Preserve the advisor-style model wording and ordinary Chat Completions compatibility. Local main was fast-forwarded to `b12bb53`; publish the integration after M12 repairs and independent validation. The older delivery records below remain historical.

Use the previous workflow: sequential dedicated chats named exactly `Milestone 12`, `Milestone 13`, `Milestone 14`, and `Milestone 15`, each in an isolated `codex/` branch/worktree. Children commit and report to coordinator `01a0dc0a-8866-7182-acd2-da997779962d`; the user explicitly authorizes messaging between these chats, routine coordinator decisions, commits and pushes. Children do not merge main or begin successor work. The coordinator independently reviews, requests corrections, validates and pushes integration before dispatching the successor. Check the active chat every 15 minutes, stay quiet when unchanged, pause immediately for a genuine user-assistance blocker, and pause after M15 delivery. Work-only live STARK access is a known acceptance limit, not an implementation blocker.

### M12 — Error presentation and focused runtime corrections

- Preserve the working advisor protocol, latest-user-message guidance and bounded format retries. Avoid wholesale prompt rewrites or telling models they directly execute actions.
- Historical errors belong to their originating turn/action. Persistent composer notices represent unresolved current blockers only, with appropriate dismissal/resolution. Preserve approvals and uncertainty rather than hiding them.
- Investigate false tool-failure labels with a bounded evidence-first pass; fix reproducible straightforward causes, record unresolved cases without speculative rewrites. Distinguish command exit success from report/format/UI failures.
- Correct the checkpoint message that declares a preceding failed action successful; critic verdicts must not rewrite observed execution evidence.
- Tighten JSON recovery at the parser boundary: accept a complete validated object or an unambiguous whole-message fenced object; never extract an executable nested action from incomplete outer JSON, arrays, examples or arbitrary surrounding prose. Formatting retries may request a complete recommendation. Preserve schema and policy checks and do not log raw rejected model content unconditionally.
- Reconcile the three known baseline test failures with intended behavior: one obsolete protocol-wording assertion and two connection diagnostic retry-count assertions. Add meaningful regressions for the new parsing/error behavior, not merely weaker assertions.
- Own `server/protocol.ts`, `server/runtime.ts`, error-related `client/**`, focused tests (including settings/protocol regression updates), scoped API/type changes only if necessary, and `docs/reports/milestone-12.md`. No project deletion, provider settings or plan workflow implementation yet.

### M13 — Chat and project removal

- Subtle accessible sidebar overflow menus, visible on hover/focus/selection; preserve the dark, flat design and navigation/editor guards.
- Delete a chat and its dependent app records. Project confirmation offers **Remove from app only**, **Delete project and files**, and Cancel. App-only removal preserves every project file. File deletion shows the exact canonical directory and requires an additional explicit confirmation.
- Destructive operations are server-validated and serialized against active work, pending operations and dirty editor leases; never delete a running workspace. Reject unsafe roots, the app/config/data directories, overlapping registered projects and link/path substitution hazards. Do not traverse links into other directories. Revalidate the exact confirmed target immediately before the operation.
- Deletion applies only to the selected registered project, not its workspace parent. Imported projects may be deleted only with the same explicit exact-path confirmation. Partial failures must remain visible/recoverable; never report deletion as successful when files or records could not be removed.
- Own scoped `client/**`, project/chat API/store/runtime lifecycle and tool/watch/session cleanup paths, shared contracts, targeted tests, relevant architecture/API/setup docs, and `docs/reports/milestone-13.md`. Do not broaden into arbitrary filesystem management.

### M14 — Provider settings and per-chat model assignments

- Settings selects architect/coder/critic defaults using `/models`, with manual ID entry when discovery is incomplete. Preserve connection-test behavior and allow a masked key to be replaced/cleared. Keep transport/JSON toggles out of this feature.
- Persist defaults and the API key in the backend `.env`, preserving unrelated entries and using validated, atomic updates; prevent newline/config injection, unsafe file targets and accidental exposure. Never echo the stored key in API responses, logs, browser persistence, probes or child shell environments. The explicitly entered key necessarily travels in the protected settings request only.
- Snapshot model IDs into durable chat records at creation. Changing defaults affects **new chats only**. Backfill existing chats with their pre-change effective assignments before accepting new defaults; use their saved models throughout runtime, critic and compaction calls and across restarts. The API key remains shared configuration, not a per-chat secret snapshot.
- Configure the server safely without interrupting an in-flight request or mixing provider state. Document whether credential replacement takes effect on the next request; never silently migrate old chat model IDs.
- Own scoped settings UI/API/config/provider/context/runtime/store wiring, shared contracts, targeted tests, architecture/API/setup docs and `docs/reports/milestone-14.md`. No native provider tools/Responses API or new secret-management dependency without coordinator review.

### M15 — Planning to execution and accessible progress

- Add **Start building** to explicitly transition a planning chat into execution using its existing plan/history. Support clear user intent such as “go ahead” through a validated mode-transition recommendation or equivalent coordinator-reviewed mechanism; ambiguous prose cannot override plan-only restrictions. Model-facing language must remain recommendation/advisor oriented.
- Persist mode changes, enforce approvals and fresh versions, handle active requests/steering/restart and make repeated clicks idempotent. A generated plan alone never authorizes execution.
- Move the plan from the beginning of the transcript into an on-demand collapsible panel reachable from a stable chat-header Plan control. Show compact phase/step progress without persistent large chrome or requiring a scroll to the top. Preserve editor state and narrow-screen access.
- Associate delegated work with stable plan step identities and update progress from actual start/completion/review outcomes. A successful tool call alone is not a completed step. Preserve blockers, failures, manual plan revisions and critic acceptance; the architect can still revise scope. Avoid fabricated completion for legacy/unassociated work.
- Own scoped plan UI/API/runtime/store/shared-contract changes, targeted tests, architecture/API/setup docs and `docs/reports/milestone-15.md`. Keep prompt changes minimal and explain each in the handoff.

All deliveries require commit SHA, changed interfaces, typecheck, full tests, build and targeted evidence with explicit Windows/Linux/browser/STARK limitations. Coordinator owns `docs/STATUS.md` and milestone dispatch records. Additive contracts within each scope are preapproved subject to independent review; ask the coordinator about broader changes. Do not publish credentials, local databases, user project files or generated artifacts.

| ID | Milestone | Acceptance |
| --- | --- | --- |
| M0 | Foundation and coordination | Reproducible Node/React scaffold, shared interfaces, CI, GitHub milestones, persistent coordination record |
| M1 | STARK provider and JSON protocol | Model discovery, text streaming, complete validated actions, cancellation, bounded retries, mock-provider tests |
| M2 | Durable conversations and orchestration | SQLite projects/chats/events, architect delegation, approval/resume, restart recovery, steering |
| M3 | Workspace tools and persistent shells | Confined file tools, hashes and stale-write checks, diffs, editor leases, PTY state, Git, structured test artifacts |
| M4 | Chat workspace interface | Project/chat navigation, real API chat, plans, editable syntax-highlighted files, diffs, approvals, test results |
| M5 | Reviews and context management | Critic checkpoints, bounded repairs, summaries with durable state retained, configurable budgets |
| M6 | Integrated release validation | Reviewed integration, meaningful automated/browser/Linux tests, setup docs, honest remaining live-provider acceptance |
| M7 | Seamless dark workspace | Codex-inspired dark chat interface with less button chrome, folder explorer for import, automatic new-project workspace, and Settings to choose its drive/folder |
| M8 | Settings and focused chat | Test connection; approval level in Settings with distinct current-chat/default scopes; persistent debug toggle; internal agent chatter hidden by default while errors and approvals remain visible |
| M9 | Project instructions | Root AGENTS.md applies to all roles, refreshes safely after changes, survives compaction/restart, and cannot override runtime controls |
| M10 | Changes review and conservative undo | Project-wide Git changes and separate agent-write history; file diffs; version/lease-protected per-write undo with durable uncertain-outcome handling |
| M11 | On-demand terminal | Terminal button beside Files; collapsible read-only command/output view with running/completed/exit evidence; closed by default; tests remain accessible |

Milestones may develop concurrently after interfaces are established. Integration remains coordinator-owned. Implement the single-coder loop before attempting parallel coder execution.

## Approved follow-up workflow (2026-09-27)

Delivery record (2026-09-28): M8–M11 are reviewed, integrated and passed exact Linux CI. Their scoped GitHub issues/milestones are closed and the existing heartbeat is paused. No successor milestone is scheduled. See STATUS and acceptance for commit/run evidence and the still-open browser/live-STARK acceptance gates. The workflow below records the approved process used for this sequence.

Deliver M8, M9, M10, and M11 **sequentially**, each in a dedicated chat named exactly `Milestone x` and an isolated `codex/` branch/worktree from reviewed main. The coordinator reviews code and evidence, requests fixes, runs integration checks, and pushes main before dispatching the next milestone. The user authorizes the coordinator to decide routine design, interface, and implementation choices; escalate only decisions that truly need the user's information or approval. Child chats must send routine questions to the coordinator rather than stall awaiting the user.

The existing 15-minute heartbeat monitors the active chat, helps with stalls, reviews deliveries, and advances the sequence. Stay quiet when unchanged. Pause immediately when progress truly requires user assistance; pause once M8–M11 are delivered. Live STARK access at work is an explicitly deferred acceptance gate, not a reason to stall independent implementation or repeatedly request credentials.

The interrupted coordinator draft is saved at `8a87bb2` on `codex/feature-preparation-20260927`. It is **not integrated** and must not be cherry-picked wholesale. [Preparation report](reports/feature-preparation-2026-09-27.md) maps its files to milestones and records unvalidated behavior.

### M8 scope and acceptance

- Add Test connection in Settings: catalog availability, exact configured model IDs, bounded reply-format probes using normal transport and scheduler accounting. Never execute returned actions or display raw JSON/keys. Handle cancellation, timeouts, concurrent checks, refusals, malformed replies, and sanitized failure reports.
- Move approval selection from composer to Settings. Explicitly label current-chat mode separately from a persisted default for future chats. Changing one must not silently change unrelated chats or execute pending proposals.
- Persist debug preference. Default chat shows user/architect conversation and actionable errors/approvals, with internal coder/critic/tool detail available only when debug is on. Test outcomes remain accessible; hiding diagnostics must not hide failures.
- No streaming toggle or JSON-format setting. Preserve editor resize/expand behavior, dirty leases, project navigation, and existing settings.
- Child owns `client/**`, `server/app.ts`, new `server/diagnostics.ts` and settings helper if needed, `shared/types.ts`, scoped tests, `docs/api-contract.md`, and `docs/reports/milestone-8.md`. Coordinator preauthorizes additive settings/diagnostics contracts fitting this scope; document exact choices. Request scope expansion before editing other runtime/security modules or dependencies.

### M9 scope and acceptance

- Fresh bounded root AGENTS.md guidance for every role; include outside compacted history, follow explicit user requests, preserve enforced permissions, and detect changed guidance before relying on old proposals.
- Cover absent/oversize/linked files, edits during requests/approval waits, compaction, and restart with meaningful tests. Nested instruction discovery is out of scope for this iteration.
- Child owns `server/project-instructions.ts`, `server/runtime.ts`, relevant context integration only as needed, targeted tests, an example instructions document, API/usage documentation, and its report.

### M10 scope and acceptance

- Show current Git modifications including pre-existing/manual changes, separately labelled from recorded agent edits. Browse files and readable diffs without exposing protected credential paths.
- Durable before/after history for confirmed agent file writes, and explicit preview before undoing one recorded write. Restore modified content or remove a newly created file only when current version and editor leases permit; preserve later manual changes by refusing incompatible undo.
- Handle concurrent requests, stale previews, crashes, uncertain outcomes, deleted/renamed paths, and pre-existing dirty Git work. No destructive Git reset and no automatic replay of uncertain undo. Arbitrary shell effects have review, not automatic undo.
- Child owns changes/store/file-tool/runtime integration and shared contracts, related UI, targeted tests, API/usage docs, and its report; coordinator reviews all mutation boundaries.

### M11 scope and acceptance

- Terminal button beside Files opens an on-demand, initially closed read-only command/output panel. Show real command lifecycle and exit evidence, associate output correctly, and distinguish interrupted/uncertain sessions.
- Preserve test report access and error visibility without exposing internal critic chatter in ordinary chat. Opening/closing the panel never runs a command or resets an agent shell.
- No interactive command entry in this milestone. Preserve Linux PTY behavior and honestly report Windows/browser/live-provider limits.
- Child owns terminal UI and bounded event/schema additions if required, relevant tests, API/usage docs, and its report.

Every delivery includes commit SHA, changed interfaces, typecheck/full tests/build, meaningful focused tests, and explicit browser/Linux/provider limitations. Coordinator-owned STATUS, milestone sequencing, and integration must not be overwritten by child chats.

## Release scope

The first release must support all requested core user flows with one coder. Parallel coders and isolated integration are an extension only after that baseline is verified. Do not imply parallel execution is implemented just because the architecture permits it.

## Public tracker

Milestones and their delivery issues are tracked in the repository's GitHub tracker. Close them only when the stated acceptance is actually met; record deferred and environment-dependent checks explicitly.
