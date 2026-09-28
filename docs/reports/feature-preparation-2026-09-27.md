# Partial feature preparation — 2026-09-27

The user stopped direct coordinator implementation and requested the earlier workflow: numbered milestone chats implement isolated changes; the coordinator reviews, integrates, validates, and pushes main. This report records the work already attempted. It is a draft reference, not an accepted implementation.

## User decisions

- Add a **Test connection** button. JSON is the internal model response protocol, not a user setting. Streaming is transport behavior, not a newly requested settings toggle. Show understandable diagnostic results without raw model JSON or secrets.
- Approval-level selection belongs in Settings. Preserve actionable approval requests and exact file diffs in chat. Define clearly whether a settings change affects the current chat or future chats; avoid silently changing unrelated chats.
- Keep architect chat central. Hide internal coder/critic chatter and detailed tool traces by default; offer a debug switch in Settings. Errors and approval requests must remain visible without debug enabled.
- Add project-root AGENTS.md support to reduce drift.
- Add project changes review with conservative selective undo that preserves later manual work.
- Put terminal access behind a button next to Files. It should not occupy the main chat continuously.
- Live STARK testing is deferred until the user is at work. Do not repeatedly request credentials or claim synthetic tests establish provider compatibility.

## Draft changes already written

These files are saved together on `codex/feature-preparation-20260927`, based on main `864b7db`. Do **not** cherry-pick the whole draft into a milestone or main. Read the relevant parts and implement only that milestone's approved scope.

| Files | Draft behavior | Intended owner |
| --- | --- | --- |
| `server/diagnostics.ts` | Read-only provider catalog check followed by an ordinary JSON final-response probe for architect, coder, critic; uses managed completion hook when available; bounded output; no returned action is executed | M8 |
| `server/app.ts` diagnostic additions | POST `/api/connection-check`, one concurrent check, 90-second timeout | M8 |
| `shared/types.ts` diagnostic additions | `ConnectionCheck`, `ConnectionReport` | M8 |
| `server/project-instructions.ts` | Read root AGENTS.md through existing safe file tools before requests; 32000-byte bound; guidance cannot override runtime controls | M9 |
| `server/runtime.ts` guidance additions | Reattach guidance outside compacted history for every role | M9 |
| `server/changes.ts` | Project Git status/history listing, exact snapshot preview, conservative per-write undo | M10 |
| `server/store.ts` additions | Additive `file_changes` table, bounded recent summaries, snapshot retrieval, operation status updates | M10 |
| `server/runtime.ts` write additions | Capture pre-write snapshot; record before/after only on confirmed writes with matching content hash | M10 |
| `server/tools/files.ts`, `server/tools/index.ts` | Version-checked removal primitive for undoing new files; use existing file locks/dirty leases; list individual untracked paths | M10 |
| `server/app.ts` change additions | GET changes/change/diff and POST undo; broadcast resulting file change | M10 |
| `shared/types.ts` change additions | Snapshot/history types and optional trusted `ToolService.remove` primitive | M10 |

No frontend work was implemented in this draft. No debug toggle, approval-settings move, connection button, changes panel, or terminal button exists yet. No new feature tests were written. No new dependency was added. Existing project data and credentials were not changed.

## Verification and known review work

`npm run typecheck` passed and `git diff --check` found no whitespace errors on the partial draft. The full test suite, production build, Linux CI, and browser interactions were **not** run for these changes. Prior successful baseline checks do not validate this draft.

- M8: independently verify error sanitization, cancellation/disconnection/shutdown handling, scheduler accounting, missing role IDs, refusals, truncated/malformed replies, duplicate clicks, and client timeouts. The draft's 90-second server timeout exceeds the existing default 30-second client timeout. Parser errors can contain response excerpts; diagnostics must not disclose them. Keep probes separate from real task execution and show that checks consume small model requests.
- M9: verify updated guidance reaches all roles and survives compaction/restart. Recheck guidance at safe boundaries around in-flight replies/prepared actions, including watcher gaps. Protect against symlinks, oversize files, stale guidance, and unsafe instruction contents. The draft only supports root AGENTS.md; nested discovery is not implemented.
- M10: review concurrency and crash boundaries carefully. The draft marks undo as `undoing` before the filesystem mutation and does not replay uncertain outcomes, but does not yet distinguish a safely rejected dirty/stale write from an uncertain mutation. Decide how to report/recover those states. Review deletion races to the same standard as existing file writes.
- M10: undo currently targets individual confirmed `write_file` actions, not arbitrary shell effects or Git history. Later manual edits are rejected rather than merged. Git status includes pre-existing/user changes: the UI must label this honestly and distinguish it from the agent write history. Draft history is capped at 200 records without pagination. Old actions have no retrospective snapshots.
- M11: no implementation yet. Start with an on-demand read-only command/output view unless a separate interactive terminal contract is explicitly agreed. Preserve tests access and failure visibility.

## Handoff workflow

Plan and deliver M8–M11 sequentially so shared UI/runtime files have one implementation owner at a time. Each child uses an isolated `codex/` branch/worktree based on the reviewed main baseline, owns only its assigned paths, writes its milestone report, and reports a commit SHA plus validation and remaining limitations. The coordinator reviews diffs and tests before integrating; draft code is reference material only. Child chats are named exactly `Milestone 8`, `Milestone 9`, `Milestone 10`, and `Milestone 11` when started.
