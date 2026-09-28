# Setup guide

Run the backend inside WSL/Linux and open the interface in your Windows browser. These instructions assume you already have a WSL Linux distribution. Run the shell commands below in that distribution, not in PowerShell.

You can use projects, chats, and the file editor without model access. For this deployment, STARK is available only at work; perform the provider checks there.

## 1. Check prerequisites

Install Node.js **24 or newer** with npm inside WSL, using your organization's approved installation method. A Windows Node installation does not replace the Linux installation. You also need Git, Bash, Python 3, make, and a C++ compiler. Python and the compiler support the native PTY dependency.

On Ubuntu/Debian, install the non-Node prerequisites with:

```bash
sudo apt update
sudo apt install -y git curl python3 python3-venv build-essential
```

Verify the tools in your WSL terminal:

```bash
node --version
npm --version
node -p 'process.platform'
git --version
python3 --version
```

Expect Node `v24.x` or newer and platform `linux`. If Node resolves to a Windows executable, install/use the Linux version before continuing. Persistent shell, Python execution, and test commands require the Linux backend; native Windows is suitable for the UI and portable development checks.

## 2. Clone and install

Keep the app and working projects under your Linux home directory for filesystem performance:

```bash
mkdir -p ~/apps
cd ~/apps
git clone https://github.com/Deathstar1342/react-harness.git
cd react-harness
npm ci
cp .env.example .env
chmod 600 .env
```

Copy `.env.example` only on initial setup; copying it again overwrites your local settings. No separate database service or Python backend is required: Node creates the local SQLite database on startup.

## 3. Configure STARK

Open `.env` in your preferred local editor. Set your work provider's URL and key:

```dotenv
STARK_BASE_URL=https://your-provider.example/v1
STARK_API_KEY=your-local-key

ARCHITECT_MODEL=gemini-3.1-pro-preview
CODER_MODEL=gemini-3.8-flash
CRITIC_MODEL=gemini-3.6-flash
```

Use the API prefix supplied by your provider. If the discovery endpoint is `https://example.internal/api/v1/models`, set the base URL to `https://example.internal/api/v1`. Do not include `/models` or `/chat/completions` in the base URL. The backend appends these paths itself.

Model IDs must match your STARK catalog exactly. The role names above are configurable defaults, not a guarantee that every STARK deployment exposes them. Requests use Chat Completions with ordinary-text JSON instructions; they do not send native tool definitions, `response_format`, or Responses API requests.

Keep real keys in the local `.env`, which Git ignores. Do not put them in chat messages, screenshots, or repository files. Leaving `STARK_API_KEY` empty lets you explore the UI without calling models. Restart the backend after configuration changes.

Useful optional settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local-only listener; the app requires a loopback address |
| `PORT` | `3000` | Backend and built UI port |
| `HARNESS_DATA_DIR` | `.harness` | Chat database, durable runtime state, and local artifacts |
| `HARNESS_WORKSPACE_ROOT` | `~/React Harness Projects` when unset | Initial destination for new projects; use an absolute Linux path if setting it |
| `APPROVAL_MODE` | `balanced` | Default for new chats: `balanced`, `review`, or `autonomous` |
| `MODEL_STREAMING` | `true` | Set `false` if the provider does not support streaming |

Settings in the UI can override the new-project workspace locally. Existing projects stay in place. Relative data and prompt-file paths resolve from the directory where you start the backend, so run the commands from the repository root. Use `.env.example` for token budgets, request limits, and optional per-role prompt files.

## 4. Build and start

```bash
npm run build
npm start
```

Keep that terminal running, then open [http://localhost:3000](http://localhost:3000) in your Windows browser. Use the configured port if you changed it. Stop the server with **Ctrl+C**. On later launches, run `npm start` from the checkout; rebuild after pulling frontend changes.

For development instead:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). This starts both the backend and Vite with automatic reloads. The development proxy currently targets backend port `3000`; keep that port or update `vite.config.ts` to match. Run either development or normal startup, not both on the same port.

## 5. Verify access at work

Open **Settings → Test connection** for the built-in check. It verifies the model catalog and sends up to three small reply-format probes. It uses your normal configured transport and shared account budgets, with a 25-second total deadline. Failed or cancelled requests may consume budget. A timeout or “not checked” result requires a later retry; it is not a successful provider check. No diagnostic reply executes an action, and raw responses and credentials are not shown.

With the app running, use another WSL terminal:

```bash
curl --fail-with-body http://127.0.0.1:3000/api/health
curl --fail-with-body http://127.0.0.1:3000/api/models
```

The health check should return `{"ok":true}`. The models route calls STARK through the backend using your local configuration; you do not need to put the API key in a shell command. Check that the returned catalog includes your three configured role IDs. Discovery success alone does not prove Chat Completions or JSON protocol compatibility.

Try this first workflow in a disposable project:

1. Create a project by name. The app creates a unique folder in the default workspace and initializes a local Git repository. Use **Import** and the folder explorer for an existing project.
2. Create a chat, open **Settings**, and choose **Review every change** under **Current chat** so you can inspect proposed writes and commands. The separate future-chat default does not change this chat. Approval and Debug changes save immediately; workspace selection has its own Save workspace button.
3. Send: `Create a hello.txt file containing Hello from Harness. Ask the critic to review the result. Do not install packages or run shell commands.`
4. Inspect the proposed file diff, approve it, and confirm the file and critic result appear. A refusal, parsing error, or unfinished run is a failed compatibility check, not a successful execution.
5. Open the file in the editor, change its text, and save. Ask the architect to read the current contents and confirm it sees the manual edit. Drag the editor's left divider or use its expand/restore button for more space.
6. Restart the app, reopen the project/chat, and confirm the conversation and saved file remain. Interrupted runs require explicit resumption; live PTY state does not survive a backend restart.

Live STARK behavior has not yet been validated by the repository's synthetic-provider tests. Record failures without sharing credentials or confidential project contents.

## 6. Python projects and test reports

The app does not bundle your project's Python packages. Prepare them in the target project, for example:

```bash
cd /absolute/path/to/your/project
python3 -m venv .venv
.venv/bin/python -m pip install pytest
.venv/bin/python -m pytest --junitxml=.react-harness-test-results.xml
```

Use your project's requirements or package manager when applicable. Ask the coder to use `run_tests` with that command and the report path `.react-harness-test-results.xml`. Running a shell command alone does not populate structured results. The test tool requires a fresh JUnit report, which appears as runner → run → individual tests in the UI.

## Project guidance

Create `AGENTS.md` in the root of each imported or created project to describe conventions, relevant commands, file ownership, and verification expectations. Start from the [example](examples/AGENTS.md.example), replacing its suggestions with your project's requirements. All three roles receive the current file outside their compacted history. The file is included in project model requests, so keep credentials and other secrets out of it.

The hierarchy is enforced runtime controls and the fixed response protocol, then explicit user requests/corrections, then fresh project guidance, then conflicting historical project guidance in old messages, assignments, tool output, or summaries. This hierarchy guides model behavior; independent code still validates actions and enforces role permissions, approval policy, path/version checks, and editor leases. It cannot guarantee that a model follows every semantic convention.

Only the exact root `AGENTS.md` is automatically loaded. Nested discovery is not supported. The file must be regular, non-linked UTF-8 text without NUL bytes, at most 32,000 UTF-8 bytes. Missing means no project guidance; an empty file is a valid distinct version. Content is never silently truncated. Unreadable, invalid, oversized, directory, symbolic-link/junction, or hard-link entries produce an actionable error and discard prepared proposals. Repair or remove the file, then **Resume**. Any discarded write/command needs a fresh proposal and, where policy requires, a new approval—even if the repaired file has its old content again.

The runtime reads and compares the file before requests, after completed replies, after action inspection, when handling approval decisions, and immediately before dispatching a prepared tool action. Compaction is followed by another check. Paused/restarted runs refresh on explicit resume; stale approvals return a conflict and awaiting chats reconsider the proposal. No watcher notification is needed to catch a change at these boundaries. Changes do not rewrite historical transcripts or invalidate approvals belonging to completed work.

These are content-snapshot checks, not an atomic lock against external filesystem writers. An edit after the last successful read, or a temporary change restored between reads, may be observed only at a later boundary. An already running command is not stopped or rolled back by an instructions edit; pause/interrupt handles cancellation separately. Interrupted executions retain uncertain-outcome evidence and are never replayed automatically. Frequent concurrent edits can use up the normal 100-step run budget; stabilize the file before resuming.

## Updating and keeping your data


Stop the backend before making a consistent backup. Back up the complete configured data directory, your separate project folders, and local configuration to private storage. `.harness` contains conversations and runtime records; Git alone does not back up that data or projects outside this checkout. Project records contain local paths, so moving to another machine may require restoring the same paths or importing the folders again.

From the repository root, update with:

```bash
git pull --ff-only
npm ci
npm run build
npm start
```

Preserve your `.env` and data directory. Compare `.env.example` for new options instead of copying over your settings. If Git reports local changes or a divergent branch, resolve those changes before continuing; do not reset away your work.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| UI reports missing STARK configuration | Set both URL and key in the checkout's `.env`, then restart the backend from that directory. |
| Model discovery fails | Confirm you are on the work network/VPN, the URL includes the correct API prefix, and the key is valid. WSL must have its own working network and certificate trust; Windows browser access alone is not sufficient. |
| Certificate validation fails | Use your organization's approved CA configuration for Node/WSL; do not disable TLS verification. |
| Model is missing or completions fail | Compare exact model IDs with `/api/models`. Confirm the provider supports Chat Completions and the requested streaming/output limits. |
| Model returns prose/refuses the JSON instructions | Capture a sanitized error/example for protocol investigation. The runtime rejects invalid actions; model discovery does not test this behavior. |
| PTY unavailable or `node-pty` failed to install | Confirm `process.platform` is `linux`, install Python/make/C++ prerequisites, and rerun `npm ci`. Check installation output; do not reuse Windows `node_modules` in WSL. |
| Page cannot connect | Confirm the startup terminal is still running and the WSL health check succeeds. Check the port and Windows-to-WSL localhost forwarding. Keep the listener local. |
| Port already in use | Stop the earlier app instance or choose a different `PORT`; update the dev proxy too if using Vite. |
| New UI change is missing | Run `npm run build` for normal startup and refresh the browser. |
| File change requires review or reports a conflict | Inspect the approval or refresh the file. Save/discard unsaved edits and let the model re-read before trying a revised proposal. |
| Shell directory or variables disappeared after restart | Expected: chats and tool evidence persist, but live shell sessions do not. |

For contributor checks, run `npm run typecheck`, `npm test`, and `npm run build`. Linux CI includes real PTY tests; Windows skips platform-specific cases. See [architecture](architecture.md), [API contract](api-contract.md), and [current status](STATUS.md) for implementation details and remaining acceptance work.

## Changes and undo

Open **Changes** beside Files when you want to inspect work. The panel starts closed and leaves the editor and its unsaved buffer mounted. **Current project Git changes** includes staged, unstaged, renamed, deleted, and untracked files, including manual or pre-existing changes. It does not attribute every dirty file to an agent. Select a file for a readable diff; rename review includes the original and destination paths. Protected credential paths are excluded. Git-unavailable projects can still show recorded-write history.

**Recorded agent writes** lists individual `write_file` attempts with their status and originating chat. Select one to inspect the recorded forward diff and **Undo preview**, then explicitly click **Undo this write**. The backend restores only the stored previous content; a newly created file is removed without removing its directory or siblings. The Git index is never changed, so a staged version can remain different from the restored working file. No Git reset or whole-task rollback is performed. Review arbitrary shell effects through Git; they have no automatic undo. Actions completed before snapshot recording was introduced have no retroactive snapshots.

Pause all active chats in the project and wait for their actions to stop before undoing. The backend checks actual running work, including actions still stopping after Pause, and blocks starts/resumes/approvals during an undo. A rejected active-work check does not interrupt a chat for you. Close Changes to use the chat's Pause control, then reopen the preview. Other chats receive file-change notifications and their unexecuted proposals are invalidated; paused chats stay paused.

Undo compares the current content hash with the recorded result and checks all dirty editor leases. A later saved manual edit blocks undo. Save or deliberately discard unsaved edits before trying again; a dirty-buffer rejection does not consume the undo. Previews expire after five minutes or a backend restart; Refresh and select the record again. Only confirmed writes are eligible. `recording` is an execution intent, `rejected` means the file mutation did not start, and `unknown` means no reliable outcome was recorded. `undoing` is a durable claim; interrupted writes/undos recover as `unknown` and cannot be retried automatically. Inspect actual files and the recorded before/after diff to decide what remains.

The panel displays the latest 100 history records and explicitly indicates omitted older entries. Git output is bounded to 1 MB; individual review diffs are limited to 200 KB with a one-second computation budget for snapshot diffs. Oversized review returns an explicit message and no undo button. Stored snapshots retain full file content within the existing 2 MB file-tool limit and are private data in the backend SQLite database. Keep backups private; history is not currently pruned automatically.

These content checks and in-process file locks do not atomically exclude external programs. A change after the last filesystem check, or a change reverted to identical bytes between checks, may escape detection. Use one backend instance per data directory/project and avoid external writers during undo. File permissions are retained by the existing save primitive, but undo is content restoration, not restoration of original filesystem metadata, directory creation, or arbitrary shell state.
