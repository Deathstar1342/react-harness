# Milestone 4 — Chat workspace interface

Implementation is ready for coordinator integration on `codex/milestone-4`, based on `c976a6f1e2b91a64fed9e8b907f2e92ad066659a`.

Worktree: `C:\Users\joshu\.codex\worktrees\milestone-4\REACT harness` (the machine resolves this storage to `D:\CodexData\.codex\worktrees\milestone-4\REACT harness`).

## Delivered

- Chat-first React application with navy/charcoal surfaces, restrained teal accents, responsive navigation, semantic controls, accessible labels, focus styling, and reduced-motion support.
- Real create/import project forms using backend filesystem paths; project selection; chat creation, selection, rename, and approval-mode settings. No seeded production projects or messages.
- Durable conversation reads, live SSE with cursor/reconnect behavior, deduplicated event IDs, coalesced state refresh, periodic recovery refresh, and visible connection/API errors. Raw provisional JSON deltas are never rendered as completed chat answers or successful tool execution.
- Message composer with `/plan`, `/btw`, steering delivery receipts, pause/resume/interrupt, and in-memory per-chat drafts retained across navigation. Send failures retain typed drafts.
- Collapsible phase/step plan, exact proposal approval cards, current-to-proposed Monaco diffs, full action arguments/version hashes, and stale-approval rejection UI. Shell approvals explain that execution can modify files without a predictable diff.
- File browser and editable Monaco panel, syntax highlighting, current-buffer diff, local worker bundling, content-hash saves, per-editor owner UUID, serialized dirty lease acquisition/renewal/release, 10-second heartbeat, lease-loss errors, and save/discard controls.
- Conflicts preserve typed text, fetch the current disk snapshot, show disk-to-buffer comparison, and require explicit acknowledgment of the reviewed base before saving. The server still checks the adopted hash on every PUT. Slow reads cannot overwrite a buffer edited while the read was in flight. Project/file navigation cannot silently replace dirty files, and page unload warns about unsaved work.
- Collapsible tool/terminal event output and structured test trees with runner, command, exit code, case status, durations, traceback, captured output, skip/error/cancel distinction, and empty-report explanations.
- Backend-only provider setup banner and public model configuration details. No credentials inputs, localStorage/sessionStorage, CDN workers, external fonts, or external runtime assets.

## Interfaces and integration

No changes to shared types, API contracts, root configuration, package files, lockfiles, server files, or coordinator STATUS. No dependency additions are needed. All application requests use the existing same-origin `/api` contract.

Coordinator-confirmed event payloads used: delta `{role,text}`; tool_output `{agentId,output}`; steering `{content,delivered}`; file_changed `{path,source}`. Durable messages/plans/approvals/status/tests trigger a fresh ChatDetail read. Delta text only drives a composing indicator. Reconnection also refreshes the open file to detect saved changes missed while disconnected.

Monaco 0.57 exports map package subpaths into `esm/vs`; imports therefore use `monaco-editor/editor/editor.worker?worker` and corresponding language worker paths, rather than older `monaco-editor/esm/vs/...` examples. Loader is supplied the bundled Monaco instance. Editor/diff code is lazy loaded.

The current Plan type has no owner, explicit blocker text, or verification fields beyond step status. The UI displays all available phase/step data without inventing extra fields. Runtime remains authoritative for action policy, stale approvals, cancellation, execution outcomes, and provider availability.

## Validation

Executed on native Windows with Node 24.16:

- `npm ci`: passed; 0 audit vulnerabilities at installation.
- `npm run typecheck`: passed on final source.
- `npm test`: 13 passed across 3 test files; the opt-in browser fixture test is skipped in ordinary runs.
- `npm run build`: passed on final source; all five Monaco workers emitted as local assets. Vite reports expected large Monaco/editor/TypeScript-worker chunks; generated output is not committed.
- Tests cover transport errors and 409 preservation, invalid success payloads, exact save/version/owner request payloads, event text extraction, escaped model content, exact proposal details, stale approvals without approval controls, potentially modifying shell labels, blocked plan steps, collapsed evidence, and structured cancellation/error/skip/traceback rendering.
- `git diff --check`: passed before commit.

`tests/ui-fixture.test.ts` is an opt-in, clearly labeled disposable fixture for downstream browser checks. It exercises production UI code against in-memory API/SSE state, including an initial save conflict and a `[fail]` message error. It performs no real provider, shell, project-file, or database operations. Start using `HARNESS_UI_FIXTURE=1 npx vitest run tests/ui-fixture.test.ts` (PowerShell: `$env:HARNESS_UI_FIXTURE='1'; npx vitest run tests/ui-fixture.test.ts`). It listens on loopback port 5174. The fixture server used during this milestone was stopped; no listener remained on port 5174 at handoff.

## Open acceptance and limitations

Browser inspection was attempted using the installed Browser skill and normal in-app connection. Navigation was rejected because browser security could not verify saved permissions: "saved browser permissions could not be verified" for `http://127.0.0.1:5174`. No alternate browser/control mechanism was used to evade this control. Coordinator was notified and explicitly directed delivery with visual acceptance pending.

Consequently rendered desktop/mobile layout, actual browser Monaco worker startup, keyboard interaction, dirty-lease/conflict interaction, and end-to-end SSE/control/approval flows are **not browser-verified here**. Automated rendering checks are server-rendered React markup checks, not a substitute for browser acceptance. The coordinator must verify these against the integrated backend.

No WSL/Linux/PTY checks or live STARK provider checks were performed. The isolated baseline backend only exposes settings/health, so integrated runtime action tests remain coordinator-owned. This report does not claim M4 acceptance or milestone closure; integration and final acceptance remain with the coordinator.
