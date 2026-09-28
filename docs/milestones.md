# Delivery milestones

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
