# Milestone 14 — Provider settings and per-chat models

Implemented only M14 from published main `d17822f`, on `codex/milestone-14` in `C:/Users/joshu/.codex/worktrees/b4a4/REACT harness` (physical path `D:/CodexData/.codex/worktrees/b4a4/REACT harness`). Coordinator retains integration, STATUS, milestone sequence and final acceptance. No main merge, successor work, data relocation, containerization or executable packaging.

## Delivered behavior

- Settings exposes architect/coder/critic catalog-backed comboboxes with exact manual ID entry. New defaults apply to new chats only. Existing approval, Debug, workspace and diagnostic controls remain available.
- The key input is empty on load, uses password masking, and clears on submission. Blank leaves the key unchanged; explicit Clear removes it. API responses expose only `apiKeyConfigured`, model defaults and nonsecret `lockedFields`.
- The original process environment overrides `.env`; overridden fields are locked, even for empty values. Unsupported custom dotenv path/encoding/override/parser options reject explicitly. `.env` is parsed without mutating the child-process environment.
- Validated single-line settings persist with a bounded regular-file read, dotenv round-trip verification, exclusive mode-0600 temporary file, flush, revalidation and atomic rename. Unrelated source is preserved; stale edits, links/hardlinks, unsafe quoting and partial patches reject. Temporary filenames match the existing `.env.*` ignore/protection convention, including after a crash.
- Startup and pre-save transactions backfill missing legacy chat model maps from the pre-change effective defaults. New chat creation clones defaults. Every role, resumed frame and compaction/cache identity uses the durable chat map. Credentials stay shared and are never stored in chat records/SQLite.
- Each provider invocation captures its own immutable configuration. Replacement/clear applies at next dispatch, including queued calls after their scheduler wait. Already-dispatched calls/retries keep the captured key. Fixed sanitized provider failures prevent delayed errors from exposing old or rotated keys; no retired-key registry is retained.
- Diagnostic role IDs are captured at check start; per-request credentials follow the same dispatch rule. Provider saves invalidate displayed diagnostic results, including late results from an earlier check, without changing scheduler accounting or interrupting active chat work.

## Contracts and failure ordering

Additive GET/PATCH `/api/provider-settings`, shared `ProviderSettings`, `ProviderSettingsPatch`, `RoleModels` and optional historical-compatible `Chat.models`. PATCH accepts partial role defaults and optional `apiKey`; omitted and empty key are distinct. The existing local-origin/JSON boundary applies. No dependency, schema-table, prompt, action-protocol, native-tool, Responses API or transport-toggle changes.

Production bootstrap now uses `loadBackendConfig`, `ProviderSettingsFile` and `ReloadingProvider`. Programmatic `createApp` embedding supplies optional `providerSettingsFile` to enable writes; omission is read-only. `Store.initializeModels`, `setModelDefaults` and `chatModels` are trusted internal interfaces. The coordinator approved this additive contract early.

Legacy chat backfill commits before settings replacement. A failed replacement leaves current provider state and future defaults unchanged; the safe backfill may already exist. Successful rename publishes live configuration/defaults synchronously. Post-commit file identity/content mismatch reports **saved and active; restart after checking `.env`** and latches out later saves. It never absorbs external edits into a new baseline. Coordinator review identified that narrow race; the correction compares committed bytes/dev/ino and has a deterministic injected-edit regression.

## Validation

Windows, Node **24.16.0**:

- `npm run typecheck`: passed.
- `npm test`: **455 passed, 15 skipped**, 31 suites passed / 2 skipped. New M14 file: **23 passed, 1 Linux-only skip**. The skips include inherited Linux PTY coverage and the new Linux symlink/mode-0600 check.
- `npm run build`: passed; existing large Monaco bundle warning remains. Generated output is ignored and not committed.
- `git diff --check`: passed.
- New regressions cover dotenv duplicate/export/colon/multiline/escaping/BOM cases; unchanged/clear keys; process precedence; full-patch validation; stale/missing/hardlinked targets; deterministic failed atomic replacement/retry; post-commit external edits; restart migration; every role's resumed frame and compaction model; captured credentials through retries; normal chat rotation followed by delayed error, durable error redaction, resume and new-chat dispatch; child environment exclusion; API origin/content-type and nonsecret responses.

Earlier checks are preserved as limitations, not counted as passes: initial sandbox `npm ci` failed with npm's “Exit handler never called”; targeted Vitest initially failed to load a sandbox temporary module-cache file. Both succeeded outside the sandbox. The first full suite found two obsolete pre-M14 SSR assertions prohibiting all Settings/API-key inputs; they were narrowed to preserve workspace-picker and no-transport-toggle intent while asserting the required password/combobox controls. The initial browser check found stale diagnostic success after key clear; fixed and rechecked.

### Actual Chrome interaction

Chrome Hands Free connected to the existing Chrome session. A task-owned background tab at a dedicated loopback port used disposable temporary config/data and a local synthetic provider. No real `.env`, credential, project contents, OS mouse/keyboard control, or live STARK was used.

Observed through actual controls, fresh accessibility snapshots and bounded page/API inspection:

- Catalog IDs populate all role comboboxes; a manual architect ID and a catalog-listed coder ID save successfully.
- Existing chat assignments remain the original map; clicking New chat creates a chat with the changed defaults, confirmed through its API record.
- Replacement key starts empty/masked, clears after save, remains absent from settings/chat responses and browser local/session storage. A second save with blank input preserves configuration. Explicit Clear changes `apiKeyConfigured` to false.
- Invalid surrounding model whitespace produces a visible rejection; correcting the value allows a subsequent save.
- Synthetic connection diagnostics pass; after the fix, clearing the key removes the old success report. With the key cleared, catalog refresh explains that manual entry remains available.
- A separate fixture with external coder/key overrides disables only those controls and explains how to remove the override/restart; architect remains editable and the key stays empty.

These are synthetic browser/API acceptance checks, not live-provider or full player acceptance. No screenshot/visual-polish acceptance is claimed. The temporary fixture servers and task-owned tab were stopped/closed after checking.

## Remaining limits

No Linux execution or live STARK validation was performed here. Coordinator must run exact integrated Linux CI, including PTY and the new symlink/private-mode regression. Work-only live STARK is the known deferred acceptance gate, not a blocker.

One backend instance and a trusted config directory are assumed. Native pathname checks do not eliminate external replacement races after the final check. Linux mode 0600 does not replace Windows ACL management. The file is flushed before rename; directory metadata durability across arbitrary power loss is not guaranteed. Unsupported dotenv representations reject with actionable text instead of claiming saved success. Settings does not move existing data or import projects differently.

No user-assistance blocker. Preserve this worktree/branch and await coordinator review after delivery.
