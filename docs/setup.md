# Run abysSUS

Use Node.js 24 or newer. In a fresh checkout:

```sh
npm ci
npm run build
npm start
```

After that, use `npm start` and open the local address it prints. The browser opens directly on the app. Press Ctrl+C to stop the backend.

Use the checkout’s `.env` for settings. Copy `.env.example` as a starting point or use **Settings** in the browser to save your provider URL, key, and exact role model IDs. Keep `.env` private. Process environment variables still override matching entries.

The app opens its existing local state automatically. It uses `%LOCALAPPDATA%\abysSUS` on Windows or `${XDG_DATA_HOME:-$HOME/.local/share}/abyssus` on Linux by default. If you already use `HARNESS_HOME` or `HARNESS_DATA_DIR`, keep the same paths in the checkout’s `.env` or process environment. Restore a missing established database before starting. Settings from an earlier profile configuration file can be copied into the checkout’s `.env` locally.

Optional `bash setup.sh` and `.\setup.ps1` install dependencies and build the UI. `bash start.sh` and `.\start.ps1` run `npm start` from the checkout. Setup does not start the app.

## Commands and approvals

Commands start in the canonical workspace root or an existing, unlinked directory under it. Use an optional relative working directory for commands that need a subfolder. Enter a single command with literal arguments. Workspace operations such as `ls`, `mkdir`, and `rm` check their paths before acting. Parent-relative escapes such as `rm ../*` and `mkdir ../folder` are refused.

Choose **AI command review** under **Approvals** to send the proposed command, workspace root, and working directory to the configured critic. It rejects commands it sees reaching outside the workspace and asks for human approval when scope is unclear or a review fails. Hard path checks apply in every approval mode.

External executables and project scripts run as your OS account. The app checks their working directory and direct path arguments. The executable’s own reads, writes, network requests, and child processes are governed by your OS permissions. Review unfamiliar code before running it. Optional system installs keep their separate Ask, Auto-approve, or AI review policy and require an available Linux helper.
