# Milestone 16 — Durable application home and backend lifecycle

Candidate source commit: `e43f03af52d8f1c19579505a0fd5a4b68c1c77b7` on `codex/milestone-16`.
Base: `794aebca8362ffa6d29b4528e6ef020aff0bc63e` (published approved M16–M21 kickoff). This report is a follow-up documentation commit; the final delivery SHA is sent to the coordinator. No main merge, successor implementation, STATUS or milestones edits.

## Delivered contracts

- Platform-native stable home (`HARNESS_HOME` absolute override): Linux/WSL `$XDG_DATA_HOME/abyssus` or `~/.local/share/abyssus`; Windows `%LOCALAPPDATA%/abysSUS` for portable development. Installation assets are module-relative. Configuration, SQLite/artifacts, original projects and reserved future sandbox caches are separate.
- Fresh setup uses `npm run profile:init`; legacy upgrade uses `npm run profile:migrate -- /absolute/legacy/root`. README, setup and `.env.example` document both. First empty startup requires explicit `HARNESS_INIT=1`; initialized profiles ignore ambient cwd `.env`. M20 can translate these controls into setup choices.
- Known-source selection only: cwd, installation root and explicitly selected legacy root. Empty `.harness` and `.env.example` are not profiles. Ambiguous/missing sources fail closed. Explicit legacy data overrides remain in place; legacy relative data/workspace/prompt paths become source-based absolute paths. Process environment retains precedence and imported project paths remain unchanged.
- Migration uses Node SQLite backup, including committed WAL pages, integrity/table validation, bounded regular artifact copying, flushed private staging, whole-profile rename and preparing/ready/committed receipts. Original sources and failed staging/receipts remain. Interrupted pre-publication source migration requires a fresh explicit retry; it does not publish an old snapshot after source writes. Published matching metadata completes its receipt without rerunning migration. Missing/tampered profiles fail closed.
- Canonical home and effective config/data identities are locked with persistent SQLite exclusive-lock files. OS exit/crash releases the lock; files are never unlinked to steal ownership. Different homes with shared data collide. Active source owners and write transactions reject migration. Failed startup releases resources; failed/hanging shutdown retains ownership.
- Successful startup remembers the effective data directory. Lost/changed overrides or missing established SQLite/config fail instead of presenting an empty profile. Intentional target selection requires `HARNESS_SELECT_DATA=1`; it does not merge/copy chats. Failed listen leaves the previous working binding unchanged.
- Additive shared `BackendIdentity`, `BackendProofRequest`, `BackendProof`; optional trusted `createApp` lifecycle hook; production `startBackend`. POST `/api/backend/readiness` and `/api/backend/shutdown` use action/instance/protocol-bound HMAC, expiring nonces and replay rejection. Readiness proof binds profile/PID/platform/state. Private per-launch descriptor and key never enter API settings, response DTOs, logs or child shell environments. Existing loopback/origin/JSON restrictions remain.
- Shutdown is awaited/idempotent, rejects new work before draining, closes SSE and existing runtime/tools/store, then releases ownership. A signed stopping response acknowledges acceptance, not completion. Port conflicts never attach to or kill the other listener. Existing uncertain-action recovery remains unchanged; migration itself does not replay/recover actions.

The small `removal.ts` addition protects the stable application home against project disk deletion. No changes to prompts, advisor JSON wording, planStep, Chat Completions transport, runtime approvals, stale-file validation or model tool execution. No dependencies added. No Electron UI, sandbox, system-install policy or privileged helper implemented.

## Validation

Windows, Node `v24.16.0`, synthetic fixtures only:

- `npm run typecheck`: passed.
- `npm test`: **515 passed, 15 platform skips**, 35 test files passed / 2 skipped; 34.54 seconds. The 20 new tests cover WAL row preservation (including actual change snapshots), artifacts/secrets/config paths, source ownership/write-lock denial, interruption at preparing/ready/published, tamper/missing-state rejection, real process contention/crash release, shared data across two homes, cwd-independent end-to-end restart, migration then ordinary restart, selected-profile Settings save, lost-override then explicit selection, port conflict/retry/binding preservation, HMAC identity/action/expiry/replay/origin checks, authenticated shutdown and ownership during hanging drain. Failed-drain state is tested on the lifecycle object; hanging ownership is tested on a real started backend.
- `npm run build`: passed, existing large Monaco chunk warning. Build output is ignored/uncommitted.
- Real child Node processes prove lock contention and OS release after `SIGKILL`; these are Windows process/SQLite checks, not simulated POSIX/PTY evidence.
- Initial sandboxed targeted tests failed on Windows temporary-file rename `EPERM`; ordinary-permission reruns passed. Sandboxed Vite build failed on Monaco `realpath EPERM`; ordinary-permission build passed. Initial sandboxed `npm ci` returned “Exit handler never called”; ordinary-permission `npm ci` completed. These failed attempts are not counted as passes.
- WSL enumeration found only `podman-machine-default`; it was not launched or modified. No local real Linux/WSL/PTy acceptance is claimed. Exact GitHub Linux CI is recorded separately when available.

Fixtures use temporary directories and synthetic keys, never real profile migration or real user projects. Browser/installed desktop/native picker/live STARK acceptance was not performed. Work-only STARK is an acceptance limit, not a blocker.

## Limits and review notes

- Pre-M16 backends do not hold the new ownership lock while idle. SQLite backup and an active-write lock cannot prove an idle old backend is stopped. Setup explicitly requires stopping all old backends; continuing to use the retained legacy profile after cutover creates independent histories. External artifact editors must also be stopped.
- SQLite locking requires a trusted local filesystem. Native pathname checks do not defeat arbitrary concurrent same-user directory substitution. Unix home/config privacy is enforced with owner/0700; newly written config/descriptor files use 0600. Windows inherits user-directory ACLs. Windows metadata rename has no universal power-loss durability guarantee.
- Artifact copying is bounded to 10,000 entries, depth 64 and 1 GiB, and rejects links/special files. Existing logical archives/summaries and change snapshots live in SQLite and are preserved verbatim. External project/absolute references remain at their original locations; no project moves or cross-environment path conversion.
- `Store` and `createApp` remain trusted embeddable primitives without automatic profile locks; production must use `startBackend`. A failed/hanging drain retains locks until the owning process exits. No timeout can truthfully convert uncertain work into a successful shutdown.
- The lifecycle key is omitted from shell environment, but today's unsandboxed same-user shell can read its private descriptor on disk. M16 authenticates backend identity; M17 must supply the OS process boundary. Existing browser APIs retain their prior local-origin policy.
- Installation-specific Node/native-module bundling, Electron transport, WSL selection, sandbox/helper provisioning and release artifacts remain later milestones. No real user data or credentials are in this commit.

SQLite backup reference: [Node.js SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsourceDb-path-options). Independent coordinator review, integration, exact main CI and acceptance remain coordinator-owned.
