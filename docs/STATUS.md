# Coordinator status

- Coordinator: 01a0dc0a-8866-7182-acd2-da997779962d
- Repository: https://github.com/Deathstar1342/react-harness
- Integration branch: main. User authorization for public commits/pushes persists.
- Active scope: user approved sequential M8–M11 with dedicated milestone chats; coordinator owns decisions, review, fixes requested from children, integration, validation, and pushes.
- Live-provider acceptance remains deferred until work access. Do not repeatedly request credentials or treat that known gate as blocking independently testable features.
- Existing heartbeat `react-harness-milestone-check-in` is ACTIVE, every 15 minutes, targeting this coordinator chat. Pause when user assistance is truly needed or the agreed sequence is delivered. Routine child questions are coordinator-owned decisions.

## Milestones

Current dispatch: M8 settings/connection/debug; M9 project instructions, M10 changes/undo, M11 on-demand terminal follow after reviewed integration. Detailed scope and ownership are in `docs/milestones.md`. Coordinator may resolve routine product/technical decisions without asking the user. Partial coordinator work was saved unvalidated on `codex/feature-preparation-20260927` at `8a87bb2` and removed from main; see `docs/reports/feature-preparation-2026-09-27.md`. Main baseline is `864b7db` plus these coordination documents. Historical blocked audit below is superseded for this authorized feature sequence.

### Active follow-up sequence

| Milestone | Chat / branch | Tracker | State |
| --- | --- | --- | --- |
| M8 | `01a0e617-9cba-7260-a64e-409403164a7b` / `codex/milestone-8` | Issue #9, GitHub milestone 9 | Reviewed delivery `bf62963`, integrated/pushed `6e5605e`; independent local checks and Linux CI passed |
| M9 | `01a0e62a-9ad7-7ac2-a704-46144431309a` / `codex/milestone-9` | Issue #10, GitHub milestone 10 | Reviewed `7137d73`, integrated/pushed `639d981`; independent local checks and exact Linux CI passed |
| M10 | Create `Milestone 10` after reviewed M9 integration | Issue #11, GitHub milestone 11 | Queued |
| M11 | Create `Milestone 11` after reviewed M10 integration | Issue #12, GitHub milestone 12 | Queued |

M8 worktree: `D:/CodexData/.codex/worktrees/1ac4/REACT harness`. Ready thread ID above is confirmed by a compact wait snapshot (active); pending creation ID was `client-new-thread:24b82153-b682-45f6-8909-1e5646bf381c`. Last wait cursor: `e4c85478-d782-4671-b4d0-aa96ffd38185:1`.

M9 ready thread ID is confirmed by its coordinator message and compact wait snapshot. Do not duplicate it. M8 issue/milestone 9 is closed with evidence and its chat instructed to remain idle. Heartbeat ACTIVE was reverified at M9 dispatch. M9 proposes internal run/pending-action guidance fingerprints and watcher-independent freshness checks around request/inspection/execution boundaries; approved in scope. Coordinator emphasized preserving executing/done uncertain-recovery records, invalid guidance failing closed, missing/present transitions, and honest external-filesystem race limitations.

M9 reviewed delivery: `7137d732fbc8930e9aa999f20e84b79fac0d7143`, integrated as `639d981b118618ccfbffd807faf35fcf5776bcce`. Coordinator independently ran typecheck, full suite (314 passed / 11 Windows platform skips), build and diff-check; all passed. Exact integration Linux CI **passed**: https://github.com/Deathstar1342/react-harness/actions/runs/36376683021 . Coverage includes invalid-guidance recovery preserving executing/done evidence, interrupted reads, concurrent approval decisions, missing/present transitions, and summary-time edits. Four existing mocks were corrected to distinguish absent AGENTS.md. No shared tools/dependencies/watchers/UI changes. M10 may proceed. M9 worktree remains `D:/CodexData/.codex/worktrees/48d1/REACT harness`; inspect it with an explicit per-command safe.directory or elevated Git if Windows sandbox ownership differs, without changing global Git trust configuration.

M8 preliminary interface proposal approved: GET/PATCH `/api/preferences` with persistent `debugMode` and `defaultApprovalMode`; POST `/api/connection-check` with catalog and per-role sanitized results; current-chat approval changes conservatively rejected while active work/proposals could be released. Child will use managed scheduler accounting and bounded cancellation-aware probes. Coordinator advised enough output headroom for reasoning providers (up to 1024/configured cap), clear timeout versus format failures, and not-checked results for unattempted roles. Exact final contract remains subject to delivery review.

M8 delivery review resolved duplicate error rendering, role-specific provisional wording, and immediate-save Settings clarity. Coordinator authorized a narrow update to the M6 /plan regression: first assert pending policy change returns 409, then pause, change policy, and retain the mutation-prohibition assertions. Independent checks on integrated `6e5605e2872e73a1fbf7a3c3bb754b1e20f755d7`: typecheck, 284 tests passed / 10 Windows platform skips, build and diff-check passed. Exact integration Linux CI **passed**: https://github.com/Deathstar1342/react-harness/actions/runs/36375663077. M9 may proceed. Browser interaction and live STARK remain unverified; no user-assistance blocker. The mixed preparation branch remains unmerged. The earlier preview process handle is no longer available and the preferences route did not respond during this check; do not claim the preview is currently running without a fresh start/health check.

Latest user follow-up (2026-09-26): implemented a draggable editor divider and expand/restore control, preserving mounted editor buffers and conversation state. Divider supports arrow keys, Home/End, and double-click reset; expansion restores the chosen split width. Typecheck, production build, and all 245 portable tests passed (10 platform skips); localhost preview returned HTTP 200 after rebuilding. Browser interaction remains unverified because the prior browser permission block is unresolved. The heartbeat stays paused; do not poll for work-only credentials. This update supersedes the historical blocked audit below: visual direction is accepted and live STARK testing will happen at work.

| Milestone | Chat | Current evidence |
| --- | --- | --- |
| M0 | Coordinator | Complete; local/Linux CI passed; tracker closed |
| M1 | 01a0dc3a-6bca-7cb0-91a7-343b393d3bec | Integrated ec95965; provider/protocol tests and Linux CI passed |
| M2 | Coordinator | Durable runtime, API, approvals, restart recovery, steering and review checkpoints implemented; release review ongoing |
| M3 | 01a0dc3a-79c2-71a3-b90b-455fc518c8c7 | Integrated 68411b9 and 0e47ea4; nine Linux PTY cases passed in prior CI run 36222528237 |
| M4 | 01a0dc3a-91de-73e3-8b8c-82cc0cb375a8 | Integrated 9814bbf; superseded visually by M7 work in progress |
| M5 | 01a0dc46-426d-72d3-8dd4-461800aee720 | Integrated 96c9df8; managed hooks wired at a185cc0; context/scheduler and HTTP restart tests pass |
| M6 | 01a0dc69-ca84-72d3-803b-c46f14ffc6a2 | Review delivered c0fc99a; all ten independent regressions pass with coordinator fixes |
| M7 | 01a0dc72-a118-7931-898e-d3e4cb0c83bb | UI integrated f96049c with backend 7b94cd3; final validation and visual feedback pending |

M6 owns tests/release.test.ts and docs/reports/milestone-6.md only. M7 owns client/**, tests/ui-*.test.ts, docs/reports/milestone-7.md. Coordinator owns integration and other paths. Existing child worktrees/branches are preserved.

## Latest local validation

Node 24.16 on Windows: npm run typecheck; npm test (245 passed, ten skipped); npm run build all passed. Includes M6 Git literal-path credential exclusion, /plan on active runs, sibling-chat notifications, editor conflict protection and scheduler role accounting. Four new M7 API tests cover unique name-only project creation, persisted workspace settings across restart, folder browsing/import preservation, and invalid/cross-origin requests.

Tool implementation fixes include dirty leases surviving a save, historical approval preservation, recent activity pagination, post-commit event publication, SSE shutdown, cross-chat write notifications, active /plan enforcement, and literal Git pathspecs. Revalidate exact integrated SHA on Linux CI.

## M7 current contract

Dark charcoal, flat navigation, fewer outlined controls, contextual actions, chat-first layout. Import via backend folder explorer; new projects need only a name and use a unique default-workspace folder. Settings can change the future-project workspace without moving existing projects. Types/API contract and architecture.md updated. Coordinator backend implements GET/PATCH /api/workspace, GET /api/directories and optional create path. UI and backend are integrated. Default workspace is ~/React Harness Projects or HARNESS_WORKSPACE_ROOT.

## Remaining delivery work

1. M7 UI and M6 review fixes are integrated. UI Linux CI passed at 02342fe (run 36225306950). Validate the prompt-file follow-up on Linux and use docs/acceptance.md for remaining gates.
2. Automated visual acceptance remains pending. Prior Browser tool could not verify saved localhost permissions, and the current tool catalog no longer lists the Browser skill. Do not bypass its security failure with another automation path. User manually viewed old UI and supplied M7 direction. Preview server is running at http://127.0.0.1:3000 in exec session 48392. User visual feedback requested.
3. Ordinary WSL is unavailable locally; detected distribution belongs to Podman. Do not alter unrelated container services. Linux CI covers real PTY behavior.
4. STARK credentials are absent; no live-provider validation claimed. Synthetic HTTP tests cover actual runtime/provider/tools/SQLite with restart, but do not prove provider prompt compatibility.
5. Coder delegation is serial. Parallel worktrees/coders remain a later extension after verified baseline, as stated in milestones. Finish release audit and tracker updates before completion.

Keep the full requested product scope and recent UI feedback. Do not mistake a passing synthetic test or screenshot for live-provider acceptance.

## Latest integration evidence

- Linux CI for b90a093 passed: https://github.com/Deathstar1342/react-harness/actions/runs/36225220402 (npm ci, typecheck, full tests including PTY, production build).
- Runner/run/case grouping was added to the test drawer to match the original requested hierarchy; targeted UI checks and rebuilt preview passed. Follow-up CI passed at 02342fe (run 36225306950).
- All milestone chats are idle. M6 delivered independent regression tests and M7 delivered the integrated dark UI. Human visual/interaction feedback and live STARK validation remain open; goal not complete and heartbeat remains paused.

Prompt customization audit: optional role-specific local files are now configurable in .env and loaded by server/prompts.ts at startup. Full portable suite: 245 passed, ten skipped; typecheck/build passed. The running preview predates this startup-only extension and remains healthy with default prompts. Acceptance evidence is mapped in docs/acceptance.md. STARK configured=false verified without reading or printing a secret. No browser-control capability is currently available in the active tool catalog; existing security block has not been bypassed.

## Blocked audit (2026-09-26)

The same two acceptance blockers remain after three consecutive resumed goal turns. A fresh dotenv presence check returned starkConfigured=false, the active tool catalog contains no browser-control tool, and the heartbeat file confirms PAUSED. User requests for local .env readiness and revised UI feedback remain unanswered. Do not repeatedly poll or invent more feature work to avoid this gate.

Code candidate 11b1b2caeb2b60b5bb0438d63c855856cbe9d8b8 passed Linux CI run 36225704259. Preview health is OK on localhost:3000. GitHub M1/M2/M3/M5 implementation issues/milestones are closed with evidence; M4/M6/M7 remain open for acceptance. All child chats are idle.

Unblock by configuring STARK_BASE_URL and STARK_API_KEY locally in .env (never paste/publish credentials), then confirming readiness; and by supplying UI feedback plus restored browser-control access or explicit acceptance-scope direction. Restart the backend to load configuration before live checks. The goal is blocked, not complete. The 15-minute heartbeat remains paused.
