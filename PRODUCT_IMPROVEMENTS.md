# Product improvements — M33–M37

Kickoff: 2026-10-26. The user cancelled the proposed native-local deployment simplification and explicitly requested five tangible improvements, milestones and the previous dedicated-chat/coordinator-review workflow. Keep the current Electron/container deployment. No local-deployment rewrite or unsandboxed host execution is authorized by this sequence.

The reviewed M32 implementation remains the foundation. Baseline public main9cb3660232d8f0c38ddcabb748eceb0dc97a8b2b adds only the user's executable bit on setup.sh after the reviewed closeout; preserve that change. M21 packaging and all earlier worktrees/unreviewed source/notices changes remain paused and untouched. No release or M38.

## The five improvements

1. **M33 — Recovery dashboard.** Explain interrupted work in one place: what finished, what never started, what is still running or uncertain, and which existing action can safely continue. Today the UI has an interrupted banner, Resume and separate install recovery; it lacks an integrated recovery view. This milestone improves that view, not the underlying authority to replay or waive effects.
2. **M34 — Task file checkpoints.** Capture bounded project-code checkpoints at meaningful task boundaries. Preview and restore a coherent set of files, instead of undoing individual recorded writes one at a time. This is file restoration, not rollback of commands, installs, external services or conversation history.
3. **M35 — Live project preview.** Open the running project's development UI in an isolated preview panel. Bind it to that project's exact owned process/worker and show starting, ready, stopped and failed states. The application UI/API and provider secrets must remain separate from untrusted project content.
4. **M36 — Run and usage inspector.** Give each task a factual timeline, changed-file/test links, role/model requests, elapsed time and reported input/output tokens. Show unknown usage honestly; monetary estimates require explicit configured rates. Do not infer acceptance from a model summary.
5. **M37 — Sequential task queue.** Let the user write, reorder and deliberately start several tasks for one project. Run one at a time and stop for approvals, failure, uncertainty or user intervention. Restart restores the queue paused and never launches queued work automatically.

These are the authorized additions. Do not introduce parallel coders, cloud hosting, new model/provider integrations, deployment rewrites, additional numbered milestones or opportunistic M21 repairs.

## Unchanged application behavior

- Keep native tool calling, role prompts, goals, planStep execution authorization, scoped AGENTS, skills and the current project dropdown/import/export behavior.
- Keep Electron isolation/CSP/checked IPC, controller/worker separation, Docker control only in trusted host supervision, no Docker socket/private controller state/provider secrets/original-source mounts in workers, and no host-shell fallback.
- Keep explicit workspace and separate system-install policies, complete action validation, file hashes/editor leases, project mutation/cleanup reservations, atomic call/results, private bounded evidence, human provenance and uncertain-effect no replay.
- A dashboard, checkpoint, preview, inspector or queue is not execution authority. It cannot clear uncertainty, manufacture success, reuse expired approval or install decisions, or treat critic/model prose as acceptance.
- Persistent managed projects remain authoritative. Originals stay untouched; no sync/refresh/write-back/deletion. Existing explicit export remains available.
- Preserve old profiles, source selections, runtime data and earlier branches/worktrees. No migration requirement is added and no user data is silently erased.

## Milestone contracts and acceptance

### M33 — Recovery dashboard

Own a bounded authenticated read-only recovery projection/API and quiet recovery UI, affected shared/types.ts and docs/api-contract.md, tests and docs/reports/milestone-33.md. Reuse original durable run/call/result, process, install, goal and plan evidence. Unknown, absent, truncated and legacy evidence must stay visibly distinct from confirmed not_started or finished. Proposed DTOs/limits/source precedence must be reviewed before substantial implementation.

Link only to existing checked Resume, pause, process observation/cancellation and exact trusted install status/reconciliation flows. No generic resolve-uncertainty button, automatic reconciliation/replay, root transaction retry, new completion rules or action endpoint hidden behind a GET. Preserve original event IDs and human assignment provenance. No provider/key/launch capability/raw private-state payload leaks.

Acceptance: real Store/Runtime disk-SQLite restart scenarios for pre-dispatch interruption, lost post-dispatch reply, completed result, owned process, install recovery and paused/blocked goals; current concurrent revisions and user steering still checked. Browser/Electron checks verify understandable status, correct navigation/actions, stale refresh behavior and no auto-run on opening the dashboard. Existing CI remains applicable unless a concrete replacement is reviewed.

### M34 — Task file checkpoints

Own checkpoint capture/list/preview/restore/retention and a focused UI, schema/API/docs/tests/report. Propose bounded storage, capture-boundary, file identity, exclusions, integrity, retention and multi-file restore journal contracts first. Exclude app/provider state, unsafe links/special files, dependency/build caches and unbounded content; state exactly what was captured. No silent partial checkpoint represented as complete. Retention must never discard unresolved restore or runtime evidence.

Restore requires a fresh explicit human decision, preview token/revision, project idle state, no active worker/preview writer or dirty editor, current file hashes and normal mutation reservations. Never use blind git reset/clean or overwrite later edits. Keep partial restore uncertainty durable and avoid replay after restart. Append restoration history; do not erase chats, approvals or original outcomes, and invalidate affected workspace/goal evidence normally. Restoring files cannot undo installs or external shell effects.

Acceptance: additions/deletions/moves/multi-file restoration, Git/non-Git projects, stale preview, user edits, dirty leases, failed COMMIT, interruption/partial restore, unsafe paths/links, quotas and retention; actual multi-file UI preview/restore with honest evidence classes.

### M35 — Live project preview

Own bounded preview lifecycle, exact-owned project server binding, trusted host transport and isolated renderer surface, DTO/API/docs/tests/report. Review concrete process/worker/port/route/origin/session/network/CSP/secret/cleanup contracts before interface changes. Reuse existing owned project processes; never adopt arbitrary host ports/PIDs/containers or expose a generic Docker/host proxy.

Untrusted project pages receive no app preload/Node bridge, controller token, provider keys, app cookies or private API access. Use a separate origin/session and narrowly reviewed routes; reject traversal, private control targets, unsafe redirects/popups and stale project/session mappings. Fixed broker operations only, no arbitrary socket forwarding. Preview cannot silently start commands: existing mode/plan/approval/freshness gates authorize any start. Stop/restart binds the exact owned worker and preserves uncertainty; no unrelated workload termination.

Acceptance: actual disposable Linux worker dev server plus real browser/Electron preview, reload/stop/crash/restart, project switching, stale bindings, hostile page trying to reach app/API/private endpoints, popup/navigation escapes, secret isolation and exact cleanup. Windows Docker device evidence remains separate; no local workstation provisioning.

### M36 — Run and usage inspector

Own bounded per-run history/aggregation and UI, needed durable request/model/usage metadata, DTO/API/docs/tests/report. Review run identity, aggregation, pagination, missing data, retention and privacy first. Original event/request/call IDs remain correlated; do not rewrite old rows or insert model-generated proof.

Use provider-reported token counts and actual request/model snapshots. Missing/cancelled/incomplete usage is unknown rather than zero. Separate application budgets from actual provider quotas. Monetary estimates use explicitly configured rates with currency/model/date and unknown pricing remains unknown; no fabricated catalog capability or private work-service polling. Protect endpoint/account/key/raw provider/hidden prompt and verification-ledger content.

Acceptance: multiple roles/requests, streaming and cancellation, duplicate/replayed UI events, missing usage, bounds/pagination, restart, rate changes and coherent changed-file/test/plan links. UI stays responsive on long histories and labels factual versus estimated totals.

### M37 — Sequential task queue

Own durable human-authored queue entries/order/controls, serialized scheduler admission, UI, DTO/API/docs/tests/report. Review original human provenance, goal/chat creation, queue revision, at-most-once durable dispatch, restart and completion admission first. Preserve per-project serialization and existing single-coder behavior; no parallel agent feature.

Explicit Start authorizes queue progression only within the reviewed project/scope. A task must reach the existing runtime acceptance condition and release its reservations before the next can start. Approval, install decision, failure, uncertain effect, blocked goal or user pause stops progression. Model prose cannot skip a blocked task or manufacture original human input. Edits/reorders/cancellation invalidate stale scheduling claims. App/backend restart restores paused state, no automatic queued execution or uncertain job replay.

Acceptance: actual multi-task sequencing, approval/failure/uncertainty stop, steering, stale reorder/cancel races, background/preview ownership, crash between durable claim and dispatch, goal completion evidence and paused restart. Complete cross-feature evaluation with M33–M36 before sequence delivery.

## Delivery workflow

Run M33 -> M34 -> M35 -> M36 -> M37 sequentially in dedicated Milestone x chats and isolated codex/milestone-x worktrees from reviewed published main. Coordinator reviews concrete early contracts, helps routine stalls, independently reviews handoffs, requests corrections, validates integration, pushes main and verifies EVERY applicable exact CI job/step plus fresh source-bound receipts before successors. Children do not merge main, dispatch successors or publish releases. Preserve failures and report platform/evidence limits.

Resume the existing15-minute heartbeat. Use compact wait_threads when an active child has not reported; stay quiet on unchanged/non-actionable status. User authorization for coordinator decisions, ongoing child messaging and public GitHub commits/pushes persists. Pause immediately if progress genuinely requires user assistance after independent work is complete; work-only STARK access is deferred acceptance, not a credential-polling blocker. Pause after independently validated M37 main delivery and report the remaining M21 hold, without automatic resumption.

Use physical D for all source/Git metadata/temp/cache/build/fixture/receipt writes. The original C checkout is stale and C storage was full; never use a C alias or delete/move existing checkouts/OneDrive/worktrees/global configuration. No workstation engine/WSL/helper/preview/global provisioning or privileged install without specific authorization. Disposable CI/VMs cover privileged/Linux/container tests. Never commit secrets, private PDF, runtime data, user projects or generated artifacts.
