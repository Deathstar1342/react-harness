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

## Installed follow-up: optional helper error and dark window bars

The user subsequently reported a generic helper failure and light native title/menu bars, and confirmed live provider testing is possible only at work. The helper launcher and `pkexec` were demonstrably absent in the selected distribution. This was an optional system-install prerequisite issue, separate from STARK connectivity.

Reviewed/published child source `8d1fc93fe2171c47c52230b2f7a182dde0f3d2fc` was deployed after the user closed the app. Read-only preflight verifies trusted regular executable helper/pkexec paths and required systemd/D-Bus types before any backend stop. It does not gate repair/removal on a healthy client descriptor or helper service, and does not pretend to verify OS authorization through process-name heuristics. Unavailable actions are disabled with guidance, and direct guarded calls preserve the current connection. Native dark mode, Windows menu auto-hide and guarded Ctrl+Q preserve ordinary window controls.

Independent coordinator checks: typecheck, 39 focused tests, TypeScript/Vite builds, then actual packaged Windows/WSL application checks. Unavailable setup, repair and removal calls each retained the exact session with workspace API HTTP 200; Continue to chats remained usable. Windows `DwmGetWindowAttribute` for immersive dark mode returned HRESULT 0/value 1 on the owned application window, and Electron reported dark theme plus invisible/auto-hidden menu. Captured content was inspected; that capture excludes the native frame, so native-frame evidence is the Windows attribute, not a screenshot pixel claim. The initial verification harness incorrectly supplied an empty `ELECTRON_RUN_AS_NODE`; removing that test variable corrected launch and the checks passed. User profile/project/chat data remained intact.

The child separately reports 640 Windows tests passed / 33 skipped and its real Electron checks. These do not imply new Linux CI, graphical OS-authentication acceptance, or live STARK testing. The privileged helper remains uninstalled; system-wide package installation is still disabled. No model-provider calls or credentials were needed for this correction. The local CJS bootstrap and D:-based storage layout remain unchanged.
