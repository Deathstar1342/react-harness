# Milestone 10 — Changes review and conservative undo

Delivered on `codex/milestone-10`, based on reviewed main documentation commit `7ed127e9a6797408520dac986cb937585c56497a`. The coordinator owns integration, exact Linux CI, tracker closure and M11 dispatch.

## Delivered behavior

Changes opens on demand beside Files, including projects without an active chat. It leaves the editor mounted and preserves dirty-buffer protection. File navigation separates current project Git changes (including pre-existing/manual/shell work) from recorded agent write attempts. Readable escaped forward and reverse diffs precede the explicit human Undo this write action. Renamed, deleted, staged/unstaged, and individual nested untracked files are supported with literal Git pathspecs. Protected paths are excluded.

A durable unique action-ID record retains before/after snapshots before execution. Successful matching write results and runtime done state commit together. Safely rejected target mutations have rejected status; unconfirmed results and interrupted recording/undoing states remain unknown and cannot replay. Completed legacy actions acquire no invented history. Restart consumption of done actions does not duplicate the record.

Undo is one recorded write only. The backend requires a server-issued project/change/hash-bound preview token and an exact expected current hash. It restores recorded previous content or removes only the newly created file. The shared file lock, path/link checks and dirty leases apply. The durable confirmed-to-undoing claim runs synchronously after final validation and immediately before rename/unlink. Safe dirty/stale rejection does not consume the record/token. An editor lease acquired during the final asynchronous read is checked again immediately before the claim; deterministic restore/removal tests verify rejection and successful retry after release. Post-claim uncertainty never replays.

The runtime project guard rejects undo until every active promise has stopped, including work still stopping after Pause, and rejects project starts/resumes/approval decisions during undo. Automatic launches respect the guard. Completion/uncertainty broadcasts file_changed to sibling chats and invalidates unexecuted approvals while preserving paused state and executing/done recovery evidence. M9 guidance is rechecked after snapshot reads. Git index, siblings and unrelated manual files remain intact.

## Interfaces and persistence

- GET `/api/projects/:id/changes`: current Git entries plus latest 100 recorded summaries and explicit historyTruncated; optional gitError.
- GET `/api/projects/:id/diff?path=...`: bounded current file Git/untracked diff; rename review includes both paths.
- GET `/api/projects/:id/change/:changeId`: recorded/reverse diffs, expectedHash, previewToken or blocking reason.
- POST `/api/projects/:id/change/:changeId/undo`: strict `{expectedHash,previewToken}` only; replacement content cannot be supplied.
- Shared `FileChangeStatus`, `FileChange`, `FileChangeSummary`, `ProjectChanges`, `ChangePreview`; optional trusted ToolService.restore callback primitive, never a model action.
- Additive node:sqlite file_changes table; states recording/confirmed/rejected/unknown/undoing/undone. Runtime exclusiveProjectEdit guard; file_changed source gains undo. Tool write rejection data marks target mutation not_started versus uncertain.
- No new dependencies. API contract and README/setup usage documentation updated. STATUS, milestones and architecture were not edited.

## Validation

Windows, Node 24.16.0:

- `npm run typecheck`: passed.
- `npm test -- --reporter=dot`: **336 passed, 12 skipped, 348 total**; 22 test files passed and two platform-only files skipped.
- `npm run build`: passed; existing large Monaco bundle warning remains.
- `git diff --check`: passed.

The 23 new tests cover real files, persistent SQLite, API and server-rendered UI contracts: staged/unrelated preservation, removal boundaries, dirty rejection/retry, late lease acquisition, saved manual changes, duplicate/concurrent undo, durable claim before effect, post-mutation uncertain failure, crash recovery, bounded history/diffs, token ownership/expiry, hard links/protected paths, runtime stopping/launch exclusion, renamed/deleted/literal/untracked Git paths, strict/cross-origin API requests, exactly-once write recording/done replay, uncertain executing writes, safe write rejection, M9 freshness after snapshot read, and escaped/explicit UI previews. Linux-only symlink replacement adds one Windows skip. An existing runtime test mock was corrected to return absence for the new file it proposes, instead of an unrelated existing file snapshot.

## Remaining acceptance limits

Automated browser interaction/visual acceptance and live STARK remain unverified. No browser permission bypass, WSL/Podman changes, or live provider claims. The coordinator must validate the exact integrated commit on Linux CI, including PTY and the new symlink test, before M11.

One backend instance per data directory/project is assumed. In-process guards and content hashes do not atomically exclude external filesystem writers or detect same-bytes changes reverted between checks. No arbitrary shell rollback, directory cleanup, filesystem metadata restoration, whole-task undo, or retroactive snapshots. Previews expire after five minutes/restart; at most 200 are retained. Latest 100 records are shown with truncation notice; history is not pruned. Review diffs use a 200 KB bound and snapshot diff computation timeout; oversized records retain snapshots but have no UI undo. Snapshots are private local database content within the existing default file-size bound. Human acceptance is separate from passing portable tests.

No user-dependent blocker. Branch/worktree will remain idle after delivery for coordinator review.
