# React Harness

A local chat workspace for models served through STARK's OpenAI-compatible Chat Completions API. You talk to the architect, which delegates implementation to a coder and brings in a critic to review scope, changes, and verification evidence.

React + TypeScript, a Node.js 24 backend, SQLite via `node:sqlite`, and a local Monaco editor. The backend is designed to run inside WSL/Linux; open the interface from your normal browser.

## Run in WSL

For a full walkthrough, including work-network STARK checks, upgrades, backups, and troubleshooting, see the **[Setup guide](docs/setup.md)**.

Prerequisites: Node.js 24 or newer, npm, Git, Bash, and Python 3 for Python tools. If `node-pty` needs to compile on your Linux distribution, install its usual native build prerequisites (Python 3, make, and a C++ compiler). Keep the checkout and working projects in your WSL home directory for filesystem performance.

```bash
git clone https://github.com/Deathstar1342/react-harness.git
cd react-harness
npm ci
cp .env.example .env
```

Edit `.env` locally:

```dotenv
STARK_BASE_URL=https://your-provider.example/v1
STARK_API_KEY=your-local-key
```

Use your provider's real API prefix in the base URL. The backend appends `/models` and `/chat/completions`; it does not use `/responses`, native tool parameters, or `response_format`.

```bash
npm run build
npm start
```

Open http://localhost:3000. For development, `npm run dev` runs the backend on port 3000 and Vite on port 5173. Restart the backend after changing `.env`.

The UI opens without credentials so you can manage projects and files. Sending model messages requires the STARK URL and key. Windows can run the UI and portable tests, but persistent shell/Python/test execution requires the Linux backend; unsupported PTY execution returns an explicit error.

## Work with projects and chats

Create or import local projects, then keep separate conversations for separate tasks. Chats, plans, approvals, tool evidence, and model context are stored in `.harness/state.sqlite` by default. Keep this local data private. You can set `HARNESS_DATA_DIR` to another location.

The dark chat interface includes a folder explorer for imports and Settings for the default workspace. Create a project with just a name under `~/React Harness Projects` (or `HARNESS_WORKSPACE_ROOT`); the backend chooses a unique folder. Change the default workspace in Settings without moving existing projects. See [current validation status](docs/STATUS.md).

Imported directories stay in place; importing does not copy files or rewrite existing Git history. New projects get a local Git repository. Project paths belong to the backend machine: inside WSL, use Linux paths such as `/home/you/projects`, or mounted Windows paths under `/mnt`.

Send `/plan ...` to plan without new mutations. Send `/btw ...` or another message during a run to steer it at the next safe boundary. Pause, resume, and interrupt are available in the chat. Cancelling does not undo changes already applied. After a backend restart, resume explicitly; an uncertain command is reported instead of blindly replayed.

## Approvals and editing

| Mode | Behavior |
| --- | --- |
| Full workspace autonomy | File and command proposals execute without per-action approval |
| Balanced | Routine file edits proceed; all arbitrary shell, Python, and test commands require approval |
| Review every change | Reads proceed; writes and commands require approval |

File approvals show the exact current-to-proposed diff and reference the file version. Stale proposals are rejected. Unsaved editor buffers have renewable ownership leases; changes in another editor or chat trigger refresh/conflict handling. Abandoned leases expire after 45 seconds.

The shell runs with the backend user's operating-system permissions. A working directory is not a sandbox, and a command approval cannot predict every resulting file change. Do not treat coder path scopes as operating-system confinement. File tools enforce project boundaries and exclude credential paths; child shell environments omit model API credentials. Run only on a trusted local machine.

Linux PTY sessions retain `cd` and shell variables across commands and sequential delegations in the same chat while the backend stays alive. Restarting the backend does not restore shell memory or processes.

## Models, context, and test evidence

Default roles are configurable in `.env`:

| Role | Default model |
| --- | --- |
| Architect | `gemini-3.1-pro-preview` |
| Coder | `gemini-3.8-flash` |
| Critic | `gemini-3.6-flash` |

To customize role guidance without editing code, create local UTF-8 text files and set `ARCHITECT_PROMPT_FILE`, `CODER_PROMPT_FILE`, or `CRITIC_PROMPT_FILE` in `.env`. Relative paths resolve from the backend working directory; `.harness/prompts/` is ignored by Git. Each file must be nonempty and at most 32,000 bytes. Restart after edits. Guidance is appended to the fixed JSON instructions; schema validation, approvals and file checks still apply. Prompt contents and filenames are excluded from frontend settings.

The current implementation delegates to one coder at a time. Parallel coders/worktree integration remain a later extension.

Ordinary streamed text carries a strict JSON action proposal. Only a complete, validated proposal can execute. Model-written continuation summaries preserve original transcripts and reattach authoritative state separately. Conservative token estimates and a persistent account ledger coordinate requests across roles and chats; the scheduler reserves headroom for architect/critic work and counts compaction calls. Configure context, output, minute, and daily limits in `.env`. These budgets cover this backend database, not other clients using the same API account.

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
