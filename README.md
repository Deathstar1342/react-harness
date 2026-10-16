# React Harness

**Deployment redesign in progress:** the approved [container backend plan](CONTAINERIZATION.md) and [M28–M32](docs/milestones.md) target a native GUI, persistent managed workspace and one-time copy-on-import (no sync/write-back). Updated container setup/Windows launchers will land in that sequence. The source commands below still describe the existing Linux/Bubblewrap implementation; container deployment and customer installers are not yet delivered. See [current status](docs/STATUS.md).

A local chat workspace for models served through STARK's OpenAI-compatible Chat Completions API. You talk to the architect, which delegates implementation to a coder and brings in a critic to review scope, changes, and verification evidence.

React + TypeScript, a Node.js 24 backend, SQLite via `node:sqlite`, and a local Monaco editor. The backend is designed to run inside WSL/Linux; open the interface from your normal browser.

## Run in WSL

**Quick setup:** in a fresh checkout inside your Ubuntu/WSL Linux home, run `bash setup.sh`. It checks sandbox prerequisites, offers missing Ubuntu packages with an explicit sudo prompt, offers a pinned checksum-verified user-local Node runtime if needed, installs locked npm dependencies, initializes/selects a private native profile, prompts for API settings with a hidden key, and builds the UI. No provider calls, privileged helper provisioning, kernel-policy changes or profile migration occur. Later run **`bash start.sh`** from that checkout; it remembers the profile without putting credentials in the launcher. See [guided setup](docs/setup.md#guided-source-setup).

For a full walkthrough, including work-network STARK checks, upgrades, backups, and troubleshooting, see the **[Setup guide](docs/setup.md)**.

Prerequisites: Node.js 24 or newer, npm, Git, Bash, and Python 3 for Python tools. If `node-pty` needs to compile on your Linux distribution, install its usual native build prerequisites (Python 3, make, and a C++ compiler). Keep the checkout and working projects in your WSL home directory for filesystem performance.

```bash
git clone https://github.com/Deathstar1342/react-harness.git
cd react-harness
npm ci
export HARNESS_HOME="$HOME/.local/share/abyssus-native"
npm run profile:init
```

Edit the configuration path printed by `profile:init` (`$HARNESS_HOME/profile/config/.env`). Use `.env.example` as a reference; never overwrite an existing profile's settings:

```dotenv
STARK_BASE_URL=https://your-provider.example/v1
STARK_API_KEY=your-local-key
```

Use your provider's real API prefix in the base URL. The backend appends `/models` and `/chat/completions`; it sends native `tools`, assistant `tool_calls` and matching `role:tool` results. It does not depend on `/responses` or `response_format`.

```bash
npm run build
npm start
```

Open http://localhost:3000. For development, `npm run dev` runs the backend on port 3000 and Vite on port 5173. Restart the backend after changing its profile `.env`. Configuration, state and built UI lookup no longer depend on the backend launch directory.

M22 requires a fresh native prototype profile. Keep the same explicit `HARNESS_HOME` for initialization and every launch. Old profiles are rejected without deletion or conversion; preserve the installed preview and its project folders. Do not point this prototype at the installed preview's home. Same-format profile relocation retains the existing lifecycle protections; it does not migrate the old action protocol.

The UI opens without credentials so you can manage projects and files. Sending model messages requires the STARK URL and key. Windows can run the UI and portable tests, but persistent shell/Python/test execution requires the Linux backend; unsupported PTY execution returns an explicit error.

## Work with projects and chats

Create or import local projects, then keep separate conversations for separate tasks. Chats, plans, approvals, tool evidence, and model context are stored in the selected home's `profile/state/state.sqlite`. Keep this local data private. `HARNESS_DATA_DIR` overrides the state directory; its effective identity is remembered to detect lost overrides. Imported projects remain outside the profile and are never moved by migration.

The dark chat interface includes a folder explorer for imports and Settings for the default workspace. Create a project with just a name under `~/React Harness Projects` (or `HARNESS_WORKSPACE_ROOT`); the backend chooses a unique folder. Change the default workspace in Settings without moving existing projects. See [current validation status](docs/STATUS.md).

Imported directories stay in place; importing does not copy files or rewrite existing Git history. New projects get a local Git repository. Project paths belong to the backend machine: inside WSL, use Linux paths such as `/home/you/projects`, or mounted Windows paths under `/mnt`.

Send `/plan ...` to plan without new mutations. Send `/btw ...` or another message during a run to steer it at the next safe boundary. Pause, resume, and interrupt are available in the chat. Cancelling does not undo changes already applied. After a backend restart, resume explicitly; an uncertain command is reported instead of blindly replayed.

Put project conventions in a root `AGENTS.md` (see [example](docs/examples/AGENTS.md.example)). The architect, coder, and critic receive fresh guidance automatically, separately from conversation summaries. Explicit user requests take precedence; runtime permissions, approval rules, and the response protocol still apply. Only the root file is loaded; nested files are not discovered.

Use a regular UTF-8 text file of at most 32,000 bytes. Missing or empty files are supported; invalid, oversized, symbolic-linked, or hard-linked files stop the run until repaired or removed. Changes are checked around requests and before execution, including after approval waits and on resume, without relying on file-watcher notifications. Changed guidance discards prepared proposals for reconsideration and invalidates their approvals. It does not undo completed work or stop an already running command. See [project guidance details](docs/setup.md#project-guidance) for recovery and freshness limits.

## Approvals and editing

Open **Settings** to select an approval level for the current chat or set the default for future chats. These are separate controls and save immediately. Pause active work and resolve pending proposals before changing the current chat's mode; changing a default does not alter existing chats or approve a proposal.

| Mode | Behavior |
| --- | --- |
| Full workspace autonomy | File and command proposals execute without per-action approval |
| Balanced | Routine file edits proceed; all arbitrary shell, Python, and test commands require approval |
| Review every change | Reads proceed; writes and commands require approval |

File approvals show the exact current-to-proposed diff and reference the file version. Stale proposals are rejected. Unsaved editor buffers have renewable ownership leases; changes in another editor or chat trigger refresh/conflict handling. Abandoned leases expire after 45 seconds.

The shell runs with the backend user's operating-system permissions. A working directory is not a sandbox, and a command approval cannot predict every resulting file change. Do not treat coder path scopes as operating-system confinement. File tools enforce project boundaries and exclude credential paths; child shell environments omit model API credentials. Run only on a trusted local machine.

Linux PTY sessions retain `cd` and shell variables across commands and sequential delegations in the same chat while the backend stays alive. Restarting the backend does not restore shell memory or processes.

Open **Changes** beside Files to review current Git changes or separate recorded agent writes. Git changes include pre-existing work, manual edits, and shell effects. Select a recorded write to see its original diff and an explicit undo preview, then choose **Undo this write**. Pause active chats in that project first. Undo requires the file to still match the recorded result and have no dirty editor lease; it preserves Git staging and unrelated files. It restores one file's previous content or removes that one newly created file. Shell effects, old actions without snapshots, and uncertain operations have no automatic undo. See [changes and undo](docs/setup.md#changes-and-undo) for limits and recovery.

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

GitHub CI runs these checks on Linux, including real PTY tests. Local tests use synthetic providers and temporary projects; they do not establish live STARK compatibility. Live-provider acceptance requires your credentials. Automated visual verification remains pending the Codex browser-permission issue documented in [STATUS](docs/STATUS.md).

See [architecture](docs/architecture.md), [milestones](docs/milestones.md), and [API contract](docs/api-contract.md). Do not commit `.env`, `.harness`, generated builds, or user project contents.
