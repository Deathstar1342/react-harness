# Coordinator status

- Coordinator task: 01a0dc0a-8866-7182-acd2-da997779962d
- Repository: https://github.com/Deathstar1342/react-harness
- Integration branch: main
- PAUSED at user request on 2026-09-26 for a Codex update. Resume only when requested.
- Heartbeat: react-harness-milestone-check-in, PAUSED.
- M1/M3/M4/M5 are idle. M6 instructed to checkpoint and stop. Coordinator preview server stopped.
- Public GitHub commit/push authorization persists for coordinator and children.

## Milestone ownership and saved deliveries

| Milestone | Owner/task | State |
| --- | --- | --- |
| M0 | Coordinator | Complete; local and Linux CI passed; tracker closed |
| M1 | Milestone 1: 01a0dc3a-6bca-7cb0-91a7-343b393d3bec | Reviewed and integrated at ec95965; Linux CI passed |
| M2 | Coordinator | Durable runtime, API, approval/review checkpoints and real tool/provider wiring implemented; integrated review remains open |
| M3 | Milestone 3: 01a0dc3a-79c2-71a3-b90b-455fc518c8c7 | Tools integrated at 68411b9; follow-up d04e0804fea39b13daf661ec650f3ce20e9e4569 awaits integration |
| M4 | Milestone 4: 01a0dc3a-91de-73e3-8b8c-82cc0cb375a8 | Delivered 864eb168f8c0c7588f8509289151395c4a86b127; review/integration pending |
| M5 | Milestone 5: 01a0dc46-426d-72d3-8dd4-461800aee720 | Delivered 177c7d7cf6456f01797c4e28a3b3205060a8a202; review/integration pending |
| M6 | Milestone 6: 01a0dc69-ca84-72d3-803b-c46f14ffc6a2 | Review checkpoint requested; three reproducible findings, fixes on main awaiting regression integration |

Child branches are codex/milestone-1, codex/milestone-3, codex/milestone-4 and codex/milestone-5. Deliveries are committed and pushed, and worktrees are preserved. M3/M4/M5 have since been integrated into main at 0e47ea4, 9814bbf and 96c9df8; managed hooks/editor lease fix at a185cc0.

## Checkpoint validation

Coordinator checkpoint: Node 24.16 on Windows; npm run typecheck, npm test (159 passed, nine Linux skips), and npm run build passed. Integration test uses a local HTTP STARK fixture with the real provider, runtime, tools and SQLite across backend restart; it is not live-provider acceptance.

M3 follow-up Linux CI run 36222528237 passed all nine real PTY cases (49 tests passed, one platform skip), typecheck and build. M4 reports typecheck, 13 UI tests and build passed. M5 reports typecheck, 154 tests and build passed on its branch. Recheck child results after integration.

Ordinary WSL is unavailable locally; the detected distribution belongs to Podman. Do not alter unrelated container services. STARK credentials are absent; live-provider validation remains pending.

## Resume sequence and open review items

1. Review and integrate M3 follow-up, M4 and M5; inspect milestone reports. M5 exports createManagedHooks(provider, store, config, options?) from server/context.ts. Production StarkProvider must retain maxRetries: 0 so each scheduler reservation corresponds to one request. Account for Store ownership on shutdown when wiring hooks.
2. Inspect editor lease lifetime after a save while the user continues typing: saving must not leave an unsaved buffer briefly unprotected. Review long-chat event pagination and historical approval invalidation.
3. Run integrated checks and Linux CI; create an independent Milestone 6 review chat. Update README to actual WSL setup and limitations. Parallel coder execution is not implemented yet; the current baseline serializes delegation.
4. Browser validation is blocked: coordinator and M4 Browser tools could not verify saved localhost permissions. User assistance to restore access is pending. Do not bypass browser security controls or use another browser as an indirect workaround. Visual acceptance remains pending; keep the heartbeat paused if user assistance is still required after resuming.
5. Finish release validation and tracker updates before claiming completion. No live STARK, complete integrated UI, or local Linux acceptance has been claimed.


## Second pause checkpoint (user requested)

- Latest combined checks before the final Git literal-path fix: 210 tests passed, ten skipped; typecheck and production build passed. After that one-line fix: typecheck and all 40 tool tests passed.
- Main now includes managed context/budgets; editor lease persists until explicit release; latest activity pagination; transaction events publish after commit; historical approvals retain their original status; open SSE streams close during shutdown; cross-chat agent edits notify peers; /plan during a run enables mutation blocking.
- M6 found a Git pathspec issue where a legal filename [.]env could expand to protected .env content. Main now uses --literal-pathspecs. The M6 reproduction must be integrated and verified when resuming. Test content is synthetic; no credential exposure was observed outside that reproduction.
- M6 branch codex/milestone-6 is checkpointing tests/release.test.ts and docs/reports/milestone-6.md. Retrieve its final report and SHA before resuming review.
- User explicitly requested M7: darker, quieter Codex-style UI, fewer boxed buttons, integrated controls; import via folder explorer; new projects automatically under a default workspace; Settings to change workspace drive/folder. M7 is recorded in milestones but its chat has NOT been created. Shared DirectoryListing/WorkspaceSettings types and planned routes are drafted only; backend routes and optional create path are NOT implemented.
- Proposed M7 ownership: new Milestone 7 chat handles client UI and UI tests on isolated codex/milestone-7 branch; coordinator owns backend directory browser, saved workspace settings, default project allocation and API tests. Keep shared contracts compatible. Browser explorer shows backend filesystem (Linux/WSL when deployed); do not promise a native Windows chooser from a WSL backend.
- Browser tool permission verification still needs resolution for automated visual acceptance. User manually viewed localhost preview and supplied the M7 feedback. Preview was stopped for this requested pause. Heartbeat remains PAUSED; do not resume work until requested.
- M6 is now idle with a clean local checkpoint b5acfd4d65a53131e5e8a6b1ff1fdedc8c168311 on codex/milestone-6 (not pushed). Five targeted tests: three expected failures against its older a185cc0 base, two passes. No remaining processes. Integrate and run these against fixed main after resume.
