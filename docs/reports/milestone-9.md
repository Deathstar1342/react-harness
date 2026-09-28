# Milestone 9 — project instructions and freshness

Implementation branch: `codex/milestone-9`, based on reviewed M8/documentation base `0a7bd8f`. Delivery is limited to M9; the coordinator owns integration, STATUS/milestone sequencing, and tracker closure.

## Delivered behavior

- Automatically read root `AGENTS.md` for architect, coder, and critic through existing project-safe reads. Limit accepted guidance to 32,000 UTF-8 bytes; reject invalid encoding/NULs, directories, links, inconsistent snapshots, read errors, and oversize content. Missing and empty files are supported and distinct; nested discovery is out of scope.
- Attach a current guidance prefix outside durable conversation history and compaction summaries. The fixed system policy states that runtime controls/protocol and explicit human requests take precedence, while current project guidance supersedes conflicting historical project guidance. Original transcripts/summary archives remain intact. Semantic model compliance is not guaranteed; parser, role, permission, approval, scope, lease, and file-version enforcement remain independent code.
- Compare content fingerprints at loop/request boundaries, after context preparation, before formatting retries, after provider replies and tool inspections, at approval decisions, and immediately before tool dispatch. Changed guidance invalidates prepared proposals and pending/approved-but-unexecuted approvals across frames, and discards stale replies before acceptance. File-watcher delivery is not required.
- Refresh on explicit resume/restart. Invalid guidance discards prepared work and clears the fingerprint, so repairing to identical old bytes still requires reconsideration and a new approval when policy requires. Legacy prepared proposals without fingerprints are discarded. Executing/done records retain uncertain/recorded outcomes even if guidance is invalid; uncertain execution is never replayed. Completed approval history is preserved.
- Added an example instructions document and usage/API documentation. Existing test doubles now distinguish a missing root AGENTS.md from ordinary file reads; production validation was not weakened.

## Interface choices

- New `server/project-instructions.ts`: `readProjectInstructions`, `ProjectInstructionsError`, `PROJECT_INSTRUCTIONS_LIMIT`, `projectInstructionsPolicy`, and internal result type.
- Additive persisted runtime JSON fields `RunState.instructionsHash?: string|null` and `PendingAction.instructionsHash?: string|null`. Undefined means unvalidated/legacy, null means absent, string means SHA-256 content snapshot. No database migration, shared public schema, dependency, watcher, tool-security, context implementation, or frontend changes.
- Approval decisions recheck state after asynchronous guidance reads to reject concurrent/stale decisions. Existing approval endpoint may now return 409 for superseded/unreadable project guidance. A changed awaiting run starts reconsideration; invalid guidance requires repair and explicit resume.

## Validation

On Windows, Node.js 24.16.0:

- `npm run typecheck` — passed.
- `npm test` — **314 passed, 11 skipped**, 22 test files (20 passed, two platform-only files skipped).
- `npm run build` — passed, existing Monaco chunk-size warning only; generated outputs are not committed.
- `git diff --check` — passed.
- Focused runtime/context/API/settings integration pass before the final expanded suite — 51 passed, one skipped. Final full-suite evidence supersedes that intermediate count.

The new suite contributes 30 portable passes and one Unix file-symlink case skipped on Windows. It uses synthetic providers, real temporary project files, real workspace tools and SQLite (including close/reopen). Coverage includes all role requests and explicit priority, hostile guidance unable to grant approvals or architect/critic writes, coder edits to AGENTS.md, missing/present/deletion transitions, absent/empty/multibyte bounds, invalid text, directories/hard links/junctions, in-flight replies, initial inspection and approved reinspection changes, autonomous final-dispatch changes, invalid-at-decision handling, invalid-after-approval and exact-byte repair, pause/restart, interruption during provider/guidance reads, concurrent decisions, historical approvals, legacy prepared/executing/done recovery, invalid-guidance outcome recovery, and edits during real compaction with original archive retention.

Linux CI is recorded separately by exact pushed SHA in the delivery handoff. No local Linux/PTY execution or WSL/Podman changes were performed. Browser interaction was not attempted because the prior saved-permission failure remains unresolved. No live STARK validation is claimed; access at work remains deferred.

## Limits and remaining acceptance

Snapshot checks do not atomically lock files against external writers. Changes after the final read, or transient changes restored between reads, cannot be guaranteed visible before dispatch. Already running commands retain their outcomes and are not rolled back; pause/interrupt remains the cancellation mechanism. Repeated concurrent guidance edits are bounded by the ordinary run step budget. Existing shared safe-read I/O bounds apply before the loader's smaller accepted-guidance bound.

Fresh hierarchy guidance reduces stale-context drift but cannot prove model obedience or task quality. Live-provider and browser acceptance remain separate from these automated checks. No user-dependent implementation blocker remains.
