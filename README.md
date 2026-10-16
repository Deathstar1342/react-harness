# React Harness

The approved [container backend plan](CONTAINERIZATION.md) uses a native Electron GUI, containerized controller/project workers, persistent selected storage and one-time copy-on-import. See [current status](docs/STATUS.md) and [M32 evidence gates](docs/m32-acceptance.md); customer packaging remains paused.

A local chat workspace for models served through STARK's native OpenAI-compatible Chat Completions API. The architect delegates implementation to a coder and brings in a critic to review scope, changes and verification evidence. React/TypeScript, Node24 inside the controller, node:sqlite and a local Monaco editor preserve conversations and editing state.

## Guided source launch

With an approved preexisting local Linux Docker engine, run `bash setup.sh` on an Ubuntu22.04/24.04 x64 desktop, or `.\setup.ps1` in Windows PowerShell. Choose an explicit external runtime/build/cache directory, then choose separate persistent app storage in the native desktop. Later use `bash start.sh` or `.\start.ps1`. No global host Node/Python, Bubblewrap, host apt/helper or manual Ubuntu backend setup is required. The scripts do not provision Docker/WSL or change host policy.

Source setup builds pinned runtime/image payloads; it is not a customer installer. Windows entrypoints and payload validation remain distinct from the open actual Docker Desktop/D-drive/SQLite/dependency-link device gate. Docker's own backing/cache drive is separate from the selected runtime and app folders. See the **[Setup guide](docs/setup.md)** for exact prerequisites, read-only checks, reruns, retained failed builds and storage behavior.

Enter provider address/key and exact role models through private Settings. Existing settings are preserved. The provider receives native `tools`, assistant `tool_calls` and matching tool results; prose never executes. No work credentials are needed to validate independent source/runtime behavior. Work-only STARK acceptance remains deferred.

## Work with projects and chats

New projects live in selected managed storage. Import copies a reviewed selection once into a new authoritative managed project; it leaves the original untouched. There is no automatic synchronization, refresh or write-back. Explicit Export saves to a new unrelated destination. Removing a managed project cannot delete its original source.

Chats, goals, plans, approvals, skills, settings and execution receipts persist across owned container restarts/recreation. Missing established storage refuses startup rather than silently resetting. Old native-prototype/profile migration remains out of scope; preserve unrelated profiles and installed previews.

Send `/plan ...` to plan without new mutations. Send `/btw ...` or another message during a run to steer it at the next safe boundary. Pause, resume, and interrupt are available in the chat. Cancelling does not undo changes already applied. After a backend restart, resume explicitly; an uncertain command is reported instead of blindly replayed.

Put project conventions in a root `AGENTS.md` (see [example](docs/examples/AGENTS.md.example)). The architect, coder, and critic receive fresh guidance automatically, separately from conversation summaries. Explicit user requests take precedence; runtime permissions, approval rules, and the response protocol still apply. Scoped project guidance follows the current revision-aware discovery rules; see the [API contract](docs/api-contract.md).

Use a regular UTF-8 text file of at most 32,000 bytes. Missing or empty files are supported; invalid, oversized, symbolic-linked, or hard-linked files stop the run until repaired or removed. Changes are checked around requests and before execution, including after approval waits and on resume, without relying on file-watcher notifications. Changed guidance discards prepared proposals for reconsideration and invalidates their approvals. It does not undo completed work or stop an already running command. See the [API contract](docs/api-contract.md) for current guidance recovery and freshness limits.

## Approvals and editing

Open **Settings** to select an approval level for the current chat or set the default for future chats. These are separate controls and save immediately. Pause active work and resolve pending proposals before changing the current chat's mode; changing a default does not alter existing chats or approve a proposal.

| Mode | Behavior |
| --- | --- |
| Full workspace autonomy | File and command proposals execute without per-action approval |
| Balanced | Routine file edits proceed; all arbitrary shell, Python, and test commands require approval |
| Review every change | Reads proceed; writes and commands require approval |

File approvals show the exact current-to-proposed diff and reference the file version. Stale proposals are rejected. Unsaved editor buffers have renewable ownership leases; changes in another editor or chat trigger refresh/conflict handling. Abandoned leases expire after 45 seconds.

Shell/Python/tests execute in exact owned project containers. Only trusted host supervision controls Docker. Workers do not receive provider secrets, controller state, Docker sockets, host root/home or original imports. Workspace approvals and container system-install policies remain independent; approval cannot predict every package/command effect. Versions, editor leases, mutation reservations and uncertain-effect no-replay protections remain enforced.

Linux PTY sessions retain `cd` and shell variables across commands and sequential delegations in the same chat while the backend stays alive. Restarting the backend does not restore shell memory or processes.

Open **Changes** beside Files to review current Git changes or separate recorded agent writes. Git changes include pre-existing work, manual edits, and shell effects. Select a recorded write to see its original diff and an explicit undo preview, then choose **Undo this write**. Pause active chats in that project first. Undo requires the file to still match the recorded result and have no dirty editor lease; it preserves Git staging and unrelated files. It restores one file's previous content or removes that one newly created file. Shell effects, old actions without snapshots, and uncertain operations have no automatic undo. See [changes and undo contracts](docs/api-contract.md) for limits and recovery.

## Models, context, and test evidence

**Settings → Test connection** checks the provider catalog and each configured role using small, bounded model requests. Results distinguish successful, failed, and unattempted checks. It uses your configured transport and account budgets without executing actions or exposing raw replies. A passing check establishes basic connectivity and reply-format compatibility, not task completion quality.

**Debug mode** in Settings is off by default. Normal chat shows the user and architect conversation, actionable errors, approvals, and tests. Enable Debug to inspect internal coder/critic messages and tool traces. This preference is saved for the backend; already-open tabs refresh it when initialized or Settings is opened.

Default roles are configurable in `.env`:

| Role | Default model |
| --- | --- |
| Architect | `gemini-3.5-pro` |
| Coder | `gemini-3.5-flash-withtools` |
| Critic | `gemini-3.5-pro` |

These are provisional model candidates, not live-verified IDs. Provider capabilities and limits remain unknown until checked. Connection tests independently probe ordinary replies, native round trips and streaming. Application token/rate budgets are conservative local settings, not claims about provider limits.

To customize role guidance without editing code, create local UTF-8 text files and set `ARCHITECT_PROMPT_FILE`, `CODER_PROMPT_FILE`, or `CRITIC_PROMPT_FILE` in the profile `.env`. Relative file values resolve from `profile/config`; explicit process environment paths retain launch-directory semantics. Each file must be nonempty and at most 32,000 bytes. Restart after edits. Guidance is appended to the native role instructions; schema validation, approvals and file checks still apply. Prompt contents and filenames are excluded from frontend settings.

The current implementation delegates to one coder at a time. Parallel coders/worktree integration remain a later extension.

Native Chat Completions carries typed tool calls. Only complete validated calls can execute; ordinary prose never executes. Model-written continuation summaries preserve original transcripts and reattach authoritative state separately. Conservative token estimates and a persistent account ledger coordinate requests across roles and chats; the scheduler reserves headroom for architect/critic work and counts compaction calls. Configure context, output, minute, and daily limits in `.env`. These budgets cover this backend database, not other clients using the same API account.

Structured tests use fresh JUnit XML. For example, ask the coder to run:

```bash
python3 -m pytest --junitxml=.react-harness-test-results.xml
```

The `run_tests` action reads that project-relative report path and supplies individual pass/fail/skip/error results and tracebacks. A zero exit code alone is not treated as a passing structured test report.

## Validation and project status

```bash
npm run typecheck
npm test
npm run build
```

GitHub CI runs these checks on Linux, including real PTY tests. Local tests use synthetic providers and temporary projects; they do not establish live STARK compatibility. Live-provider acceptance requires your credentials. Actual desktop/engine, native-human, device, live-provider and installer evidence remain separate in [STATUS](docs/STATUS.md).

See [architecture](docs/architecture.md), [milestones](docs/milestones.md), and [API contract](docs/api-contract.md). Do not commit `.env`, `.harness`, generated builds, or user project contents.
