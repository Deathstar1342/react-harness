# Run abysSUS

Use Node.js 24 or newer. In a fresh checkout:

```sh
npm ci
npm start
```

After that, use `npm start` and open the local address it prints. Startup builds missing or stale web assets and reuses an up-to-date build. Press Ctrl+C to stop the backend.

Use the checkout’s `.env` for settings. Copy `.env.example` as a starting point or use **Settings** in the browser to save your provider URL, key, and exact role model IDs. Keep `.env` private. Process environment variables still override matching entries.

The checkout's private `.harness/` directory holds the database, personal skills and other runtime state. Back up this directory to retain your chats and settings. Provider configuration lives in the checkout's `.env`.

When upgrading, stop the old backend before running `npm start`. If the checkout has no state yet, startup copies existing data from the former default location or the old `HARNESS_HOME` and `HARNESS_DATA_DIR` settings. Keep custom storage values in place for the first successful start, then remove them. The copy preserves the old files and leaves your project folders where they are. An existing `.harness/state.sqlite` takes precedence. Copy any provider values you still need from old configuration into the checkout's `.env` yourself.

Optional `bash setup.sh` and `.\setup.ps1` install dependencies. `bash start.sh` and `.\start.ps1` run `npm start` from the checkout.

## Commands and approvals

Commands start in the canonical workspace root or an existing, unlinked directory under it. Use an optional relative working directory for commands that need a subfolder. Enter a single command with literal arguments. Workspace operations such as `ls`, `mkdir`, and `rm` check their paths before acting. Parent-relative escapes such as `rm ../*` and `mkdir ../folder` are refused.

Choose **AI command review** under **Approvals** to send the proposed command, workspace root, and working directory to the configured critic. It rejects commands it sees reaching outside the workspace and asks for human approval when scope is unclear or a review fails. Hard path checks apply in every approval mode.

External executables and project scripts run as your OS account. The app checks their working directory and direct path arguments. The executable’s own reads, writes, network requests, and child processes are governed by your OS permissions. Review unfamiliar code before running it. Optional system installs keep their separate Ask, Auto-approve, or AI review policy and require an available Linux helper.
