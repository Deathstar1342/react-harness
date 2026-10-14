# Local Windows preview setup — 2026-10-14

The user requested a desktop executable, then explicitly authorized provisioning its WSL backend on D:. This report covers that local installation, not a final installer release or complete M20 acceptance.

## Installed configuration

- Unsigned Windows x64 Electron 42.11.13 preview with a Desktop launch shortcut. Application files and Windows UI/cache state are on D: in separate directories.
- Separate Ubuntu-24.04 WSL2 environment, non-root `abyssus` user, with its virtual disk at `D:\WSL\abysSUS`. Existing service distributions were not repurposed or started.
- Root-owned backend and pinned Node 24.16.0 runtime at `/opt/abyssus/app` and `/opt/abyssus/runtime`. Linux-native dependencies were built inside this distribution from reviewed source `5b50e3bfa2a2adf84933142389bd6c64698bb2ac`; Windows native modules were not reused.
- Persistent profile `/home/abyssus/.local/share/abyssus`; workspace `/home/abyssus/Projects`. Both are inside the D:-backed Linux disk. Desktop launch arguments select the separate D:-based Windows UI profile.
- WSL swap configured on D: through the previously absent `.wslconfig`, while no distributions were running. This is a shared WSL storage setting. No global networking or namespace relaxation was applied.
- The optional privileged system-install helper is not installed or enabled. Safe ordinary application functionality is available without it. No STARK credentials were copied or requested.

Open the Desktop shortcut, choose **Open profile** using the remembered existing profile, and then **Continue to chats**. Configure the endpoint and API key in Settings before using models. Imported projects currently need to be Linux folders within the selected distribution; mounted Windows drive folders are unsupported by this sandbox. Explorer can access the workspace through `\\wsl.localhost\Ubuntu-24.04\home\abyssus\Projects`.

## Corrections discovered during actual setup

The first packaged ESM entry stalled Electron readiness. A local CommonJS bootstrap that starts `import('./main.js')` without awaiting it corrected the launch. The earlier development smoke already used a CommonJS launcher. This packaging observation is recorded for M21; it is not an unreviewed source merge.

The first WSL connection initialized its profile but failed the Windows readiness fetch. A credential-free test listener independently reproduced `ECONNREFUSED` at 21 ms and 277 ms after Linux startup, then successful forwarding at 561 ms. The failed profile was preserved and reopened.

The dedicated milestone chat implemented `19aa4c1e729cdbb49840d2142ab1c96205f32180` on `codex/milestone-20`. The coordinator reviewed it and deployed its compiled `controller.js` and `readiness.js` to the Windows preview. Readiness retries only recognized transport failures to the same validated loopback destination, with fresh authenticated challenges, a ten-second overall limit and owned-process cancellation. Invalid responses/proofs remain terminal. No tool, initialization, shutdown or package-install action is retried.

## Verified evidence and remaining limits

Coordinator checks passed:

- Typecheck and 15 focused readiness tests.
- Actual packaged executable render, renderer sandbox/context isolation, no renderer Node access, and reload.
- Actual Windows-to-WSL backend startup and API connection.
- Non-root Linux, dedicated Node/SQLite, native PTY, Bubblewrap namespaces and toolchain checks.
- Actual sandbox project writes, Node/npm and Python virtual-environment creation, with Windows drives, backend installation and persistent profile absent inside the sandbox.
- Workspace setting persisted across clean application/backend shutdown and reopening the same profile. Screenshot of the connected chat interface inspected; provider-unconfigured banner was expected.

The child separately reports 629 Windows tests passed / 33 skipped, desktop build, typecheck and 28 focused checks. New exact-source CI is not implied by those local results. Previous source CI remains recorded in the milestone report.

Native confirmations were automated for this user-authorized setup. This does not establish interactive picker/cancel or graphical OS-authentication acceptance. The optional helper, actual desktop close during a privileged install, live work-network STARK, signing, upgrades and complete installer delivery remain unverified. The heartbeat stays paused; M20 remains unmerged and M21 undispatched. Private setup logs, profiles, databases, builds and screenshots remain outside Git.
