# Milestone 3: workspace tools and persistent shells

Implemented on `codex/milestone-3` from foundation `c976a6f1e2b91a64fed9e8b907f2e92ad066659a`.

## Delivery and integration

`server/tools/index.ts` exports `WorkspaceTools` with the unchanged `ToolService` contract and an optional limits configuration. No shared contract, package, root configuration, or coordinator status changes.

- UTF-8 file reads return SHA-256 versions; missing files return `{ content: "", hash: null }`, and `execute(read_file)` reports `ok: false` for them.
- Traversal, absolute/ambiguous paths, symlinks/junctions, hard links, special files, Git internals, and common credential paths are rejected. Listings/searches omit protected entries. Files, search scope, directories, output, sessions, queues, and timeouts are bounded.
- Saves serialize across service instances in one backend process, compare the requested base hash again immediately before rename, preserve existing permission bits, and stage writes in same-directory temporary files. Editor dirty leases are shared in process, renewable, owner-specific, and expire after 45 seconds by default. A successful owner save releases its lease. `ToolError.code === "CONFLICT"` is suitable for HTTP 409. Agent writes use `context.agentId`; runtime must authenticate editor owners and prevent model impersonation of them.
- `inspect(write_file)` provides current/proposed content and a unified diff. The runtime owns approvals and binds them to the exact action/version. The service does not independently grant approval. The execution boundary checks the supplied version again.
- Read-only Git status and staged/unstaged diffs preserve work and filter protected paths. Git roots must equal the workspace root. External diff, text conversion, fsmonitor, and repository clean/smudge/process filters are disabled; Git config values are not exposed.
- Arbitrary shell, Python, and test commands always inspect as `effect: execute`, `risk: elevated`; even `pwd` is not classified as a guaranteed harmless shell command. Balanced/review approval remains runtime-owned.
- Linux bash PTYs persist per canonical root/chat/agent while this backend lives. Queues serialize commands, preserve `cd`/environment state, report exit codes and background job PIDs, stream bounded output, and use an allowlisted child environment excluding provider secrets and interpreter hooks. Python uses the same working shell and `python3`.
- Cancellation/timeouts kill the shell process group, explicitly report lost state/possible completed side effects, and invalidate already queued commands. A later explicit request can start a fresh shell. No restart replay or shell-memory restoration is claimed. `dispose()` terminates shells.
- `run_tests` returns `data.testReport`, with cases, durations, captured output, traceback, skips, failures, collection errors, cancellation, and runner errors. Configure the command to write JUnit XML at `reportPath` (default `.react-harness-test-results.xml`). Report freshness is checked at command execution and captured before the next queued command; simultaneous sessions targeting the same active report are rejected. Missing/stale/malformed reports never count as passing. Raw XML remains a workspace artifact; coordinator persistence should store the returned structured report.

## Verification

Windows Node 24.16: `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` passed. At the final implementation candidate, 30 tests passed and nine Linux PTY integration tests skipped honestly. Portable tests cover stale approved writes, save races, dirty leases, hashes/missing files, traversal/credential/link protections, bounds, literal search, Git preservation/filter suppression, environment sanitization, and JUnit outcomes.

Linux GitHub Actions passed on Ubuntu 24.04.5 / Node 24.21.0 for implementation commit `6620dabf4acedb5a3257f6598e793989fbeda83f`: `npm ci`, typecheck, all nine PTY integration cases, 38 tests passed / one platform-inapplicable test skipped overall, and build. Evidence: https://github.com/Deathstar1342/react-harness/actions/runs/36222347378 (job `108349847959`). Linux tests require node-pty and fail rather than skip when it is missing on Linux. Coverage includes persistent cwd/env and isolation, repeated command ordering, Python execution, long commands, actual provider-secret removal, streaming/output limits, background jobs, cancellation/timeout, uncertain shell exit, fresh/stale JUnit artifacts, and conflicts when separate agents request the same active report.

Two initial Linux runs caught a test-command quoting error and an actual asynchronous path-resolution race that could reverse shell submission order. Both were corrected before the passing candidate. Queue admission now precedes asynchronous filesystem work. GitHub npm reported advisory install-script allowlist warnings for esbuild/node-pty; installation and native PTY execution both succeeded. Root dependency/CI policy changes remain coordinator-owned.

## Limits and acceptance boundaries

- Windows PTYs are explicitly unavailable; users must run the backend under Linux/WSL. This host has no ordinary WSL distribution; no unrelated Podman services were modified.
- A working directory is not a sandbox. Authorized arbitrary commands can read/write outside it, read credentials from disk, detach processes, or change shell behavior. Environment sanitization only prevents accidental inherited API secrets. Strong process containment requires a separate runtime/container policy. Process-group termination cannot promise to kill deliberately detached descendants.
- Node path checks and hashes protect ordinary scoped operations and concurrent cooperative saves. They are not kernel-enforced confinement against a hostile external process racing directory replacement or the final hash-check/rename boundary. Multiple backend processes are not supported for shared editor leases/write locking.
- This milestone does not initialize/import projects, mutate Git history, integrate worktrees, implement HTTP/SSE notifications, or decide approvals; those are coordinator/runtime responsibilities. Changes returned by save should be persisted/emitted by that runtime. Shell outcomes must be durably marked running before dispatch and uncertain after backend interruption, never blindly replayed.
- No live provider claim, browser acceptance claim, or production WSL acceptance claim. No secrets, user workspace contents, or generated build files are committed.
