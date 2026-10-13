# Desktop executable packaging: deferred design notes

Status: **On hold at the user's request, 2026-10-13.** Record of proposed approaches, not an approved implementation milestone or a claim that installers exist. The approved M13–M15 sequence continues. Container deployment is also on hold; see [CONTAINERIZATION.md](CONTAINERIZATION.md).

## Desired experience

Download/install the application, launch it normally, select a project with a native folder picker, configure STARK in Settings, and chat. Users should not need to open a terminal and run `npm install` or `npm start` for ordinary use. Preserve the existing dark, chat-centered interface.

Windows uses an application executable and installer. Linux also has native executables and desktop launchers; candidate distributions include a `.deb` package or AppImage. Exact package formats, CPU architectures and supported distributions remain undecided and require target-device testing.

## Candidate architecture: Electron launcher and existing application

Electron is the leading proposal because the existing UI is React and the backend is Node/TypeScript. Reuse the product interface and server logic rather than rewriting them for a native toolkit. This choice is tentative; no Electron dependency or wrapper has been introduced.

The desktop shell would own native folder selection, opening the application window, backend health/readiness, start/stop coordination, and any approved host-side import helper. The UI should appear when ready and show a useful startup failure if its backend cannot start.

Keep privileged filesystem/process operations in a narrow host interface. Use an isolated renderer with explicit, validated requests; do not give arbitrary page content Node access. Preserve local API access controls and avoid treating a desktop wrapper as an authorization boundary by itself. Opening files or external links needs explicit, constrained behavior.

## Backend deployment choices

| Mode | Desktop responsibilities | Remaining work |
| --- | --- | --- |
| Packaged local backend | Launch bundled compatible backend/runtime and show UI | Native dependency builds, lifecycle, platform shell support |
| WSL backend on Windows | Launch/connect to a supported WSL backend | Distribution selection, path conversion, setup and lifecycle |
| Container backend | Detect Docker, start application containers and show UI | Mounts, persistent state, Docker availability and selected import design |

Containerization and executable packaging are separate choices. A desktop application need not require Docker. If the container approach is chosen, the executable can primarily be a launcher and host integration layer.

Do not assume Electron's embedded Node version satisfies the backend contract. The application requires Node 24+ and `node:sqlite`; PTYs use the optional `node-pty` dependency. Decide whether to ship a separate Node backend process, package compatible native modules for Electron, or use the WSL/container backend. Validate exact runtime/ABI compatibility. A packaged React window alone is not a working backend distribution.

The current supported backend direction is Linux/WSL. A native Windows executable does not automatically make shell commands, PTYs or project toolchains Windows-compatible. Choose and label the execution environment explicitly.

## Docker prerequisite versus bundling

The user said work users can install Docker. The discussed preference was to treat it as an explicit prerequisite if the container mode is selected, with a friendly detection/setup screen and official installation links.

Including a Docker CLI binary would not provide a running Docker engine. Windows installations also need a supported virtualization backend such as WSL 2; host setup and permissions remain relevant. Any future bundled installer flow must evaluate redistribution terms, workplace policy, platform requirements and user consent before shipping. No Docker distribution or automatic installation is planned now.

The launcher could distinguish missing Docker, a stopped engine, missing image, unavailable backend and incompatible configuration. It should offer the relevant action rather than silently retrying forever. It must not stop unrelated containers or install system components without explicit approval.

Decide whether release images are downloaded on first launch or supplied as a separate offline artifact. Work-network/proxy access, image verification and update policy remain open decisions.

## Persistent data and upgrades

Installation files, application state and project folders must be separate. Use the stable configurable application-home proposal in [CONTAINERIZATION.md](CONTAINERIZATION.md), or a decided platform-native equivalent. Today the default database path depends on the backend's launch directory; packaging must address that explicitly without abandoning existing data.

- Locate and migrate existing `.harness` state and `.env` with a consistent backup and an explicit source/destination record.
- Keep model assignments, chats, project registrations and history across upgrades. Respect M14's per-chat model snapshots and backend-only API-key storage.
- Keep secrets out of the renderer's saved state, diagnostics, installers, project shells and bundled assets. A replacement key may be submitted through the protected Settings flow; the stored value must not be echoed back.
- Decide single-instance/backend ownership and avoid two launchers writing the same state database unexpectedly. Handle port conflicts without attaching to an unrelated server.
- An update must not interrupt an executing file mutation or shell command silently. Shutdown/recovery must retain uncertain outcomes rather than claiming success or replaying actions.
- Uninstall should preserve user projects and saved data by default; any data removal needs a distinct explicit choice and exact scope.

## Proposed work if resumed

1. Decide target OS/runtime, installer formats and whether Docker is required.
2. Implement and test stable data-location migration before distributing an installer.
3. Prototype a launcher with backend start/health/shutdown and native folder selection using disposable state.
4. Integrate the selected direct-import or managed-copy flow; do not silently change current project semantics.
5. Produce repeatable platform builds, define signing/update policy, and test installation, upgrade and uninstall on clean target machines.

This is a future investigation sequence, not additional approved numbered milestones. No executable generation, packaging dependency, installer, Docker setup or update service is authorized by this document.

## Acceptance evidence needed

Test actual installation and launch on each claimed platform, including machines without developer dependencies. Verify persistent chats/projects after app and backend restarts, upgrades and changed launch directories. Exercise folder selection, spaces/non-ASCII paths, file permissions, editor synchronization, approvals, Git, PTYs, cancellation and crash recovery. For container mode, also test unavailable Docker and container/image replacement without data loss.

Keep automated build success separate from installed-device, browser/native interaction and work-network STARK acceptance. Record unsupported combinations rather than presenting a single successful Windows or Linux run as universal support.

## References

- [Electron distribution overview](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)
- [Electron Forge distribution](https://www.electronjs.org/docs/latest/tutorial/forge-overview)
- [Docker Desktop installation on Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Docker Desktop WSL backend](https://docs.docker.com/desktop/features/wsl/)
- [Containerization and import options](CONTAINERIZATION.md)
