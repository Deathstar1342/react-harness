# Setup guide

## M17 sandbox prerequisites and limits

Agent execution and fixed Git reads require a **non-root Linux backend**, Bubblewrap with `--disable-userns` support, permitted unprivileged user namespaces, `socat`, distro bash/Python, Python venv support, and the existing Node 24+/node-pty prerequisites. Missing/blocked prerequisites produce an actionable failure; commands never run on the host as a fallback. On Ubuntu/Debian, a trusted administrator can provision `bubblewrap socat python3-venv` through normal package setup. This application does not install those system packages or change kernel/AppArmor settings automatically. The CI workflow's sudo/sysctl commands apply only to its disposable runner; do not copy those host-policy changes blindly onto a workstation. Native Windows file/UI tests are portable checks, not Linux sandbox acceptance. No local Podman service distro is used.

Select a plain Linux project directory separate from app home/state/config/toolchains and other registered projects. Windows mount paths, credential directories, nested mounts, external links/hardlinks/sockets and external Git worktree metadata are unsupported. Existing `.env`, `.npmrc`, credential directories and arbitrary-shell `.git` are hidden. File tools keep their existing path protections. `git_status`/`git_diff` work through fixed sandboxed Git; **shell Git commit/branch operations cannot access the imported repository metadata**. Do not put credentials into ordinary source files expecting filename masks to identify them.

Use `npm install` with the default public npm registry, and `python3 -m venv .venv` followed by `.venv/bin/pip install --index-url https://pypi.org/simple ...`. Only npm/PyPI registry HTTPS destinations are reachable through the private proxy. Alternate/private registries, Git dependencies, arbitrary URLs, localhost/backend/helper/LAN/metadata services and direct Internet sockets are unavailable. TLS verification stays enabled. Install hooks execute in the same sandbox; an allowed registry/package is not a promise that its code is harmless. Public certificate files under protected filename patterns can be masked; use the exposed system trust bundle when a project library requires a CA path.

Project-local dependencies and private caches survive shell restart. A package install that adds protected paths can cause the next command to discard the old mount layout; resubmit explicitly to start a fresh sandbox. POST `/api/projects/:id/sandbox/reset` with `{}` deliberately closes idle shells and clears private cache/home/temp only; it preserves source, `.venv`, `node_modules`, app configuration and state. Running/dirty/background/recovery-blocked projects cannot reset. Uncertain teardown quarantines execution and prevents a successful backend shutdown; investigate and recover the exact backend process rather than replaying commands.

**Pause commands before external topology changes or introducing new secrets.** Existing masks hide in-place edits. Protected inode replacement while idle is detected before the next command. Concurrent host introduction of an unmasked secret/link during an executing command is outside this boundary; imported files remain directly mounted. Shared-kernel bugs, destructive changes within the writable project, registry-directed exfiltration and resource exhaustion remain risks. There is no cgroup or disk-quota guarantee.

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
npm run profile:init
```

`profile:init` prints the private configuration path and creates a new profile only when no known legacy source needs selection. For an existing installation, use the migration instructions below instead. Use `.env.example` as a reference; never copy over saved settings. No separate database service or Python backend is required.

## 3. Configure STARK

Open the path printed by `profile:init`, normally `~/.local/share/abyssus/profile/config/.env` (or `$XDG_DATA_HOME/abyssus/profile/config/.env`), in your local editor. Set your work provider's URL and key:

```dotenv
STARK_BASE_URL=https://your-provider.example/v1
STARK_API_KEY=your-local-key

ARCHITECT_MODEL=gemini-3.1-pro-preview
CODER_MODEL=gemini-3.8-flash
CRITIC_MODEL=gemini-3.6-flash
```

Use the API prefix supplied by your provider. If the discovery endpoint is `https://example.internal/api/v1/models`, set the base URL to `https://example.internal/api/v1`. Do not include `/models` or `/chat/completions` in the base URL. The backend appends these paths itself.

Model IDs must match your STARK catalog exactly. The role names above are configurable defaults, not a guarantee that every STARK deployment exposes them. Requests use Chat Completions with ordinary-text JSON instructions; they do not send native tool definitions, `response_format`, or Responses API requests.

Keep real keys in the local `.env`, which Git ignores. Do not put them in chat messages, screenshots, or repository files. Leaving `STARK_API_KEY` empty lets you explore the UI without calling models. Restart after manual `.env` edits. Model defaults and the shared API key can also be saved through Settings without restarting, as described below.

### Provider Settings

Open Settings to select architect/coder/critic defaults from the discovered catalog or type exact model IDs manually when discovery is unavailable or incomplete. Choose **Save provider settings**. These defaults apply to **new chats only**; existing chats retain their saved role assignments through resume, compaction and restart. On the first M14 startup, older chats are assigned the effective models from the startup configuration before settings changes are accepted.

The password field always starts empty. Leaving it blank keeps the saved key. Enter a replacement or explicitly select **Clear saved API key**, then save. The input is cleared after submission and the saved key is never sent back to the browser. A replacement/clear affects the next dispatched provider request in every chat; in-flight requests retain their captured credentials. Test connection remains a separate operation, and saving provider settings clears results that describe an older configuration. Approval, Debug and workspace controls retain their existing behavior.

Settings updates the selected profile's `config/.env`, preserving unrelated configuration. Original process environment variables take precedence and lock the corresponding model/key controls, including externally supplied empty values. Remove such overrides from the launching shell/service and restart before editing those fields in Settings. A launcher that preloads dotenv also creates process overrides. Custom `DOTENV_PATH`, `DOTENV_ENCODING`, `DOTENV_OVERRIDE`, `DOTENV_FAST` and their `DOTENV_CONFIG_*` variants are unsupported; use the UTF-8 `profile/config/.env` in the selected application home. Provider URL and transport remain backend-only configuration requiring restart.

Use a regular private `.env`, not a symlink or hardlink, in a trusted writable backend folder. Values entered in Settings must be single-line; unsupported quote combinations/syntax reject explicitly. External edits while the backend is running cause saves to reject; restart to load those edits. A rare error saying **settings saved and active** means replacement completed but a subsequent file check failed: inspect the local file and restart before saving again. Do not run multiple backend instances against the same configuration/data directory. Windows file privacy depends on the directory ACL; Linux replacements use mode 0600.

Useful optional settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local-only listener; the app requires a loopback address |
| `PORT` | `3000` | Backend and built UI port |
| `HARNESS_HOME` | `$XDG_DATA_HOME/abyssus` or `~/.local/share/abyssus` on Linux | Absolute private application home; set in the launching environment |
| `HARNESS_DATA_DIR` | `HARNESS_HOME/profile/state` | Explicit state-directory override; prefer an absolute path |
| `HARNESS_WORKSPACE_ROOT` | `~/React Harness Projects` when unset | Initial destination for new projects; use an absolute Linux path if setting it |
| `APPROVAL_MODE` | `balanced` | Default for new chats: `balanced`, `review`, or `autonomous` |
| `MODEL_STREAMING` | `true` | Set `false` if the provider does not support streaming |

Settings in the UI can override the new-project workspace locally. Existing projects stay in place. Relative paths saved in the profile `.env` resolve from `profile/config`; relative paths explicitly supplied in the process environment retain launch-directory semantics. Migration normalizes legacy paths against their source root. Use absolute override paths for stable launches. Use `.env.example` for token budgets, request limits, and optional per-role prompt files.

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


Stop the backend before making a consistent backup. Back up the selected application home, any external data override, and your separate project folders to private storage. `profile/state` (or the explicit override) contains conversations and runtime records; Git alone does not back up that data or projects outside this checkout. Project records contain local paths, so moving to another machine may require restoring the same paths or importing the folders again. For the first M16 upgrade from a legacy checkout, follow the migration section before ordinary startup.

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
| UI reports missing STARK configuration | Set both URL and key in the selected home's `profile/config/.env`, then restart the backend. |
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

## Terminal command evidence

Select a chat and open **Terminal** beside Files to inspect real command/output evidence. It starts closed each time you switch chats. Opening or closing it only changes the local panel; chat drafts, editor buffers, and running backend work stay intact. **Tests** remains available beneath it, including its failure indicator, with Debug either on or off. Internal critic/coder conversation remains controlled by Debug.

Commands show their originating agent, logical shell session, command ID, status, output, and recorded exit code when available. Python actions show the submitted source. **Completed / Exit 0** means the command boundary reported zero; a separate tool/report error can still require attention in Tests. **Failed** means a recorded nonzero command exit. **Interrupted** reflects an actual cancellation/timeout result, not merely clicking Pause or Interrupt. **Uncertain** means no reliable command outcome exists, including execution interrupted by backend restart. The app never automatically reruns an uncertain action. Review workspace changes before deciding how to proceed.

This is a read-only view; use the chat to request work. Running is explicitly the last recorded state, and disconnected views show a reconnecting notice. Shell state can be lost or recreated after interruption/restart; session labels identify the logical agent shell slot, not a promise of restored processes or variables.

The view uses the latest 1,000 activity events and indicates omitted history or missing lifecycle evidence. Each command keeps up to the last 64,000 characters of available output; individual live chunks are capped at 16,000 characters and tool output has its existing byte limit. Final recorded output replaces overlapping live chunks. Truncation notices distinguish partial evidence from empty captured output. Old events without command IDs appear under **Unassociated / legacy evidence** and never establish a command's completion. Open Debug Activity to inspect other tool traces.

## Changes and undo

Open **Changes** beside Files when you want to inspect work. The panel starts closed and leaves the editor and its unsaved buffer mounted. **Current project Git changes** includes staged, unstaged, renamed, deleted, and untracked files, including manual or pre-existing changes. It does not attribute every dirty file to an agent. Select a file for a readable diff; rename review includes the original and destination paths. Protected credential paths are excluded. Git-unavailable projects can still show recorded-write history.

**Recorded agent writes** lists individual `write_file` attempts with their status and originating chat. Select one to inspect the recorded forward diff and **Undo preview**, then explicitly click **Undo this write**. The backend restores only the stored previous content; a newly created file is removed without removing its directory or siblings. The Git index is never changed, so a staged version can remain different from the restored working file. No Git reset or whole-task rollback is performed. Review arbitrary shell effects through Git; they have no automatic undo. Actions completed before snapshot recording was introduced have no retroactive snapshots.

Pause all active chats in the project and wait for their actions to stop before undoing. The backend checks actual running work, including actions still stopping after Pause, and blocks starts/resumes/approvals during an undo. A rejected active-work check does not interrupt a chat for you. Close Changes to use the chat's Pause control, then reopen the preview. Other chats receive file-change notifications and their unexecuted proposals are invalidated; paused chats stay paused.

Undo compares the current content hash with the recorded result and checks all dirty editor leases. A later saved manual edit blocks undo. Save or deliberately discard unsaved edits before trying again; a dirty-buffer rejection does not consume the undo. Previews expire after five minutes or a backend restart; Refresh and select the record again. Only confirmed writes are eligible. `recording` is an execution intent, `rejected` means the file mutation did not start, and `unknown` means no reliable outcome was recorded. `undoing` is a durable claim; interrupted writes/undos recover as `unknown` and cannot be retried automatically. Inspect actual files and the recorded before/after diff to decide what remains.

The panel displays the latest 100 history records and explicitly indicates omitted older entries. Git output is bounded to 1 MB; individual review diffs are limited to 200 KB with a one-second computation budget for snapshot diffs. Oversized review returns an explicit message and no undo button. Stored snapshots retain full file content within the existing 2 MB file-tool limit and are private data in the backend SQLite database. Keep backups private; history is not currently pruned automatically.

These content checks and in-process file locks do not atomically exclude external programs. A change after the last filesystem check, or a change reverted to identical bytes between checks, may escape detection. Use one backend instance per data directory/project and avoid external writers during undo. File permissions are retained by the existing save primitive, but undo is content restoration, not restoration of original filesystem metadata, directory creation, or arbitrary shell state.

## Remove chats and projects

Use the sidebar's **…** button beside a chat or selected project. It appears on hover or keyboard focus (and for the selected chat). Tab reaches the button and its action; Escape closes the disclosure or confirmation. Cancel returns focus to the overflow button.

**Delete chat** removes its conversation and associated app history, leaving project files and other chats intact. **Remove from app only** removes the project registration and all its chats while preserving the folder, Git history, hidden files and other contents. Importing that folder later starts fresh app history.

**Delete project and files** is permanent, including for imported folders. A second dialog shows the canonical backend directory, and requires that exact directory to be typed before enabling the final button. Cancel at either stage leaves files intact. This deletes only the chosen project's directory, never its workspace parent, and does not use a recycle bin.

Save or discard unsaved editor buffers first. Pause active project chats and wait for their actions and background jobs to finish; requesting Pause alone does not prove work stopped. Resolve pending proposals and uncertain execution records before removal. The backend independently rejects dirty leases and pending work even if another browser attempts the request. Finish pending file saves, imports or workspace preference changes before retrying.

Disk deletion refuses unsafe roots, application/config/data folders, overlapping registered projects, symbolic links/junctions, special entries, mounted subtrees and oversized trees. Remove an overlapping registration from the app first, or use app-only removal and manage the files externally. The app does not follow links to remove their destinations. Stop external writers and use only one backend instance; native path checks cannot exclude every external filesystem race.

If deletion is interrupted or partially fails, the project remains listed with **Review incomplete removal**. Inspect the actual remaining folder. Either retry **Delete project and files** with a fresh confirmation, or choose **Remove from app only**. When all files were removed but app-record cleanup failed, use app-only recovery. No retry happens automatically after restart, and new work stays blocked until recovery. Keep independent backups of files and private app data you need.

For disposable browser verification, build the client and run `node --import tsx tests/removal-browser-fixture.ts`. It serves the real app on `http://127.0.0.1:3183` using fresh temporary projects/database and no provider. Press Enter in its terminal to stop and remove only that fixture; it also expires after 15 minutes. Never test deletion against real projects.

## Plan first, then build in the same chat

Send `/plan` followed by your task. Planning stays active across completed replies and backend restarts. Open **Plan** in the chat header to inspect phases/steps; it is reachable even at the bottom of a long conversation. Once the plan is ready, choose **Start building** there, or send exactly `go ahead` or `start building` (a final period/exclamation mark is allowed). This authorizes execution mode using the current plan; normal approval and file-version checks still apply. Send `/plan` again to restore planning. Other prose, examples and conditional requests do not silently lift the restriction.

Progress reflects associated work and review evidence. A coder reporting completion still needs its independent critic review. Unassociated legacy work and model-authored `done` statuses do not establish completion. Expanding a step's evidence or progress history shows the recorded outcomes and source IDs. Structural plan edits reset current progress; unchanged plan structure preserves it. Historical failures remain retained. New guidance conservatively requires a fresh delegation to accept affected work. Backend restart interrupts unfinished progress and never replays uncertain commands. A stale Start building button requires a refresh; reconcile an in-flight/uncertain operation before retrying.

The panel is closed initially, has its own height/scroll bound, and can be closed with Escape while focus is inside it. Composer drafts and mounted file editors remain intact. Narrow layouts wrap the header controls. Recent history can omit older source events; SQLite retains them.

For a credential-free browser smoke test, build the UI, then run `node --import tsx tests/planning-browser-fixture.ts` and open the printed localhost URL. It creates only a disposable temporary project/database and uses explicit synthetic responses. Press Enter in the fixture terminal to stop and remove that fixture, or allow its 30-minute shutdown. It is not a live STARK or Linux PTY acceptance test.


## Durable profile, migration and lifecycle

Installation files stay in the checkout or future installation directory. Linux/WSL owns its database inside the selected Linux environment; no launch-time Windows/WSL database copying occurs. `HARNESS_HOME` is an absolute, persistent launcher override. Its default is `${XDG_DATA_HOME:-~/.local/share}/abyssus` on Linux and `%LOCALAPPDATA%/abysSUS` on Windows (portable development only). The home contains `profile/config/.env`, `profile/state/state.sqlite`, migration receipts and a private runtime descriptor. `cache/sandboxes` is a reserved future location; M16 does not create a sandbox. Projects remain in their original locations, or the separate configured workspace.

For a **new installation**, run `npm run profile:init`, edit the printed `.env`, then `npm run build` and `npm start`. An alternative first launch is `HARNESS_INIT=1 npm start`. Later launches need neither command nor one-time flag. A missing initialized database/configuration fails closed instead of creating an apparently empty account.

For an **upgrade from a legacy checkout**:

1. Stop every old backend using that checkout/config/data. Preserve a backup. The legacy version does not hold the new ownership lock while idle, so automatic detection cannot prove that an idle legacy backend is stopped.
2. From the updated installation, run `npm run profile:migrate -- /absolute/path/to/legacy/checkout`. Alternatively use `HARNESS_LEGACY_ROOT=/absolute/path/to/legacy/checkout npm start`. Only the selected root's known `.env` and `.harness` are inspected. Discovery checks launch cwd and installation root; it does not search your home or disk. Multiple detected sources require selecting exactly one, never merging.
3. Start normally with `npm start`. Keep any intentional `HARNESS_HOME`, process provider overrides and external data override in the launcher environment. Do not persist initialization/migration flags in `.env`.

Migration uses SQLite's backup API to include committed WAL contents, checks database integrity/tables, copies bounded regular artifacts, and atomically publishes configuration, database and profile identity together. IDs, project registrations, models, approvals, plans, change snapshots and uncertain action evidence stay intact. SQLite stores existing summary artifacts in its state table. Legacy relative data/workspace/prompt paths become absolute source-based paths. An explicit legacy `HARNESS_DATA_DIR` stays in place rather than being copied; its missing database is an error. Source files and imported projects are never deleted. Stop legacy processes before migration: a source ownership lock and active SQLite write transaction are detected, but older idle processes and external artifact editors cannot be conclusively detected.

`migration.json` records preparing/ready/committed state without credentials. Interrupted staging is retained. Before publication, retry with `HARNESS_MIGRATION_RETRY=1 npm run profile:migrate -- /same/source`; a fresh snapshot avoids accepting writes lost after a prior backup. Previous receipts and staging directories remain for inspection. After publication, matching metadata completes the receipt on restart. Damaged/missing metadata, modified staging, missing sources and unsupported versions fail for explicit recovery. Never manually merge databases. Regular artifact copying is bounded to 10,000 entries, depth 64 and 1 GiB; oversized or linked trees require explicit external recovery. Unix files are flushed and directory metadata is synced; Windows file contents are flushed, without a universal power-loss guarantee for directory metadata.

The backend locks the canonical home and effective data/config directories with persistent SQLite ownership files. Different homes sharing data collide; process exit releases locks without stale PID cleanup. Never remove ownership files to bypass a running instance. A port collision fails and releases startup resources without attaching to or killing that listener. A successful launch remembers its effective data directory. Losing/changing an override fails; restore the old value or deliberately select the new location with `HARNESS_SELECT_DATA=1 HARNESS_DATA_DIR=/absolute/selected/state npm start`. This selects a profile target and does not copy or merge old chats. A failed listen does not replace a previously working data binding.

Ctrl+C/SIGTERM and the authenticated shutdown contract stop new work, close event streams and await runtime/tool/store cleanup before releasing ownership. A hanging/failed drain retains ownership; it is never reported as successful shutdown and uncertain operations are not replayed. If the process must be terminated externally, inspect uncertain records after restart. The private `backend.json` descriptor is for a trusted launcher; a plain `/api/health` response or matching port does not authenticate a backend. See the API contract for nonce/HMAC readiness and shutdown. Never include the descriptor in diagnostics, browser payloads or published files.

Unix home/config directories must be owned by the current user with mode 0700; config and descriptors use 0600. Windows inherits the user's directory ACLs. Trusted local directory/OS locking semantics are required; network filesystems and arbitrary external path substitution are not supported security boundaries. The current same-user unsandboxed shell can read private files despite environment filtering. M17 owns process isolation; M20 will translate the one-time bootstrap controls into setup choices. No Electron, privileged helper, sandbox, or installed-desktop acceptance is claimed here.
# Optional privileged system installs (M18)

System installs stay disabled until explicit administrator provisioning in the selected Linux/WSL environment. Backend launch does not provision/start the helper. M18 provides trusted backend interfaces and fixed administrator setup/repair/uninstall entrypoints; it does not add the later Settings or guided desktop setup. See [helper prerequisites, trusted staging and recovery](helper.md). Do not run the privileged CI probes on a workstation. No WSL service distro, kernel settings, helper or system packages were changed locally for M18.

