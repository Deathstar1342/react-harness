# Coordinator status

- Coordinator: 01a0dc0a-8866-7182-acd2-da997779962d
- Repository: https://github.com/Deathstar1342/react-harness
- Integration branch: main. User authorization for public commits/pushes persists.
- ACTIVE: M7 integrated; Linux validation passed for the UI; user visual feedback and live provider acceptance pending.
- Heartbeat react-harness-milestone-check-in remains PAUSED while browser permission assistance is unresolved; independent implementation continues.

## Milestones

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
