# Acceptance audit

This is an evidence map for the requested application, not a declaration of completed live acceptance. Main includes the integrated M0-M8 work. Synthetic provider tests cannot establish STARK prompt compatibility, and component markup tests cannot establish rendered UI or keyboard behavior.

| Requirement | Current implementation and evidence | Remaining gate |
| --- | --- | --- |
| Public GitHub repository | Deathstar1342/react-harness; origin/main SHA verified after each push | None for hosting |
| Custom STARK URL/key, Chat Completions and model discovery only | server/config.ts, provider.ts; provider tests assert request shape, secret exclusion, SSE framing, refusals, truncation, cancellation and bounded retry behavior | Actual provider credentials and live run |
| Configurable JSON instructions | Optional local role prompt files loaded at startup; tests/prompts.test.ts covers role selection, hidden settings, invalid data/size and credential exclusion; strict parser remains enforced | Tune against actual STARK behavior if necessary |
| Architect conversation and delegated coder/critic | Runtime role enforcement, assignment scopes, critic completion/phase/failure checkpoints, bounded repairs; runtime/integration/release tests | Live agent quality and task acceptance |
| Create/select/import projects | Local Git initialization; default unique project folders; import preserves files; directory explorer and workspace Settings; workspace/API/UI contract tests | Rendered folder selection and keyboard walkthrough |
| Persistent chats and context | SQLite store, messages/events/run frames, approval restart, model summaries and archives; store/context/integration/release tests | Manual close/reopen UI walkthrough |
| Syntax-highlighted viewer/editor | Local Monaco and workers, language mapping, edited-buffer state | Rendered Monaco interaction walkthrough |
| Bidirectional edits preserving manual changes | SHA-256 versions, dirty leases retained across saves, external/peer-chat notifications; tools/runtime/release tests including rapid external save | Interactive edit conflict walkthrough |
| Three approval modes with file diffs | Runtime classifies reads/writes/execution; exact inspected action/diff rechecked on approve; stale/denied actions do not execute; runtime/release tests | Rendered approval-card walkthrough |
| Persistent shell, Python, local Git | Linux PTY commands, cwd/env persistence, serialized execution, cancellation, sanitized child env; actual Linux PTY CI and tools tests; literal Git paths prevent protected-file expansion | No local WSL claim; Windows shell intentionally unavailable |
| Test report tree | Fresh JUnit evidence parsed into outcomes, output and tracebacks; pytest runner detection; runner/run/case disclosures and check/X icons; tools/PTY/UI tests | Rendered expand/collapse walkthrough |
| Plan phases and progress | Plan/step schema, runtime review before newly completed steps, collapsible UI; protocol/runtime/UI tests | Visual acceptance |
| Steering and interruption | /btw and ordinary active-run input, generation checks, stale-approval invalidation, /plan switches active run to mutation prohibition; runtime/release tests | Live-model responsiveness |
| Finite context and account limits | Model-written summaries, protected instructions, original archives, active approvals only; durable request reservations and headroom; context/scheduler/release tests | Actual provider token reporting/limits |
| Dark seamless interface and workspace preference | M7 integrated; user approved visual direction; editor drag/expand controls, name-only creation, Settings and backend folder explorer | Interactive/keyboard walkthrough remains unverified |
| Connection diagnostics and focused chat | M8 integrated; fixed sanitized catalog/role results, cancellation/deadline/ledger checks; separate current-chat/default approval settings; persistent Debug off by default; 39 added tests | Real STARK checks at work and rendered Settings walkthrough |
| No uncertain action replay | Persisted action stages; resumed uncertain shell reported without execution; late model completions ignored after interruption; release tests | None beyond live recovery acceptance |
| Check-ins and milestone ownership | Named milestone chats/worktrees and reports retained; 15-minute heartbeat active for approved sequential M8–M11 delivery; routine decisions handled by coordinator | Pause if user assistance is truly required or sequence is delivered |

## Validation

- Local Node 24.16 on Windows: independent coordinator typecheck, full suite **284 passed / 10 skipped**, production build and diff-check passed after M8 integration at `6e5605e2872e73a1fbf7a3c3bb754b1e20f755d7`.
- Exact M8 integration Linux CI passed: https://github.com/Deathstar1342/react-harness/actions/runs/36375663077 . Scoped M8 implementation issue/milestone closed with live/browser limitations explicit; M9 is next.
- Exact earlier integrated Linux candidate 02342fe1ce87552c10486305eaa56bed0cc4e7b9 passed [CI run 36225306950](https://github.com/Deathstar1342/react-harness/actions/runs/36225306950), including real PTY tests. The final prompt-file candidate 11b1b2caeb2b60b5bb0438d63c855856cbe9d8b8 also passed [CI run 36225704259](https://github.com/Deathstar1342/react-harness/actions/runs/36225704259).
- Ten independent M6 regressions pass. Two code reviews led to fixes for Git pathspec handling, active /plan enforcement, cross-chat notifications, historical context growth and rapid external saves.
- Browser automation remains unavailable following saved-localhost-permission verification failure; do not bypass it with another automation path. User has viewed the earlier UI and requested the implemented M7 changes; revised visual feedback is pending.
- Running preview reports configured=false. Set STARK_BASE_URL and STARK_API_KEY in local .env, never in chat or Git. Restart before live checks. No live STARK success is claimed.

## Scope limits

The current application runs one delegated coder at a time. Parallel coder worktrees/integration are an extension after verified baseline, not implemented behavior. Arbitrary shell commands run with OS-user permissions; cwd and agent file scopes are not a sandbox. A backend restart preserves task state but not shell memory. Large output/context is bounded, and summaries do not replace the original durable records.

The overall goal remains open until the outstanding acceptance gates are resolved or explicitly adjusted by the user.
