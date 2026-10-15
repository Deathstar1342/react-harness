# Desktop application and sandboxing plan

Current source convenience: `bash setup.sh` guides Linux/WSL prerequisites, private configuration and build; `bash start.sh` reopens its selected profile. This is for prototype/source users, not the customer installation contract. Packaged customers should not clone Git, install Node/npm, build the UI or initialize profiles in a terminal: the bundled runtime/backend/UI and guided onboarding own those steps. Windows still needs an explicitly provisioned supported Linux/WSL environment and OS-authorized prerequisites. M22–M27 is delivered, while M21 remains paused with the documented portability, manifest, source/notices and native/manual release gates. This source setup follow-up does not resume packaging or claim a customer-ready installer.

Status: **M16–M19 delivered; M20 implementation integrated and M21 installers explicitly requested, 2026-10-14.** User selected Electron, Docker-free process sandboxing and a privileged package-install helper provisioned during setup. System installs have separate Ask every time / Auto-approve / AI review policies. [M16–M21](docs/milestones.md#planned-m16m21-desktop-sequence-2026-10-13) defines the sequential implementation and review gates; [STATUS](docs/STATUS.md) records current publication, dispatch and check-in state. Installed Windows/WSL core checks passed; remaining native picker, graphical authentication, privileged-close and release acceptance remain explicit M21 gates. Live STARK testing is deferred to work. Container deployment stays deferred; see [CONTAINERIZATION.md](CONTAINERIZATION.md).

## Selected direction

```text
Electron window (existing React UI)
  -> trusted non-root backend (chats, provider key, approval policy)
       -> sandboxed Linux PTY / Python / test processes
          selected project + private dependencies/cache; no app secrets
       -> authenticated package-install helper (elevated)
          one exact authorized package transaction in selected Linux environment
```

The privileged helper is installed with OS authorization during guided setup. Ordinary agent shells never gain its identity, token, socket or root privileges. The reviewer model can return a recommendation; the backend validates it against policy, and the helper independently validates its narrow request. Package-manager scripts belonging to approved packages can run with system privileges, so approved system installation is a deliberate exception to sandbox confinement, not a promise of harmless package contents.

The first release planning baseline is Windows x64 Electron with a selected Ubuntu/Debian WSL2 backend plus native Linux x64 on a supported Ubuntu/Debian release. Start with `apt`; future package managers use explicit adapters. Native Windows command execution/host installers, macOS, ARM and SSHFS are outside this sequence. Exact supported versions are frozen from release evidence. The setup UI must distinguish Windows installation from the Linux/WSL environment modified by a package request.

Bubblewrap is the proposed Linux process-boundary implementation. No Docker daemon, image-per-project lifecycle or project copying is planned. It still uses Linux namespace mechanisms, and policy configuration determines isolation. Sandbox support must be verified on target WSL/distributions; failure must never silently fall back to unrestricted host execution. Existing file-tool guards remain useful, but today's ordinary PTY is not already a sandbox.

Expose only selected project paths and private writable caches/home/temp; mount necessary system tools read-only. Keep app data/keys, personal files, privileged sockets, WSL interoperability and other project paths outside the boundary. Network access for dependencies needs its own constrained policy, especially to prevent access to the local backend/helper. Project-local venv/node_modules avoids global installs but is not a substitute for the OS boundary. No shell-string filtering or environment-variable convention counts as isolation proof.

## System-install policy

Settings places **System installs** directly below workspace approval controls. It is independent, including when workspace mode is Approve all:

| Setting | Decision path |
| --- | --- |
| Ask every time (default) | Human reviews concrete target, packages/dependencies, impact and reason |
| Auto-approve | Backend automatically approves only supported requests passing deterministic helper policy |
| AI review | Fresh bounded STARK call evaluates curated evidence; valid approve/reject/ask decision, otherwise ask the user |

The separate install-reviewer model is selectable and initially defaults to the critic model. Snapshot its ID with policy/target/preview for each request; never silently re-review or execute a stale request after settings change. Package requests remain advisor-style structured recommendations, compatible with ordinary Chat Completions. The reviewer receives neither tools nor administrator credentials. Planning mode cannot install packages under any of these policies.

The helper accepts structured package identities and validated versions for a specific target, not executable paths, shell text or arbitrary package-manager flags. Repository changes, downloaded scripts, removals, downgrades and whole-system upgrades require separately scoped future actions. Preview and authorization must account for dependency changes; installed state, actual outcome and uncertainty are recorded. A used/expired/stale authorization cannot be replayed. Package-manager interruption may leave partial system changes and must be reconciled explicitly.

Setup requests normal OS authentication to register a root-owned, narrow helper and authorized application principal. Passwords never pass through model/UI state or ordinary logs. Declining/cancelling setup disables system installs while retaining ordinary safe functionality. Upgrades and uninstall must verify helper identity, permissions and protocol compatibility; the agent never receives unrestricted passwordless sudo. Root helper code and every runtime/library it loads must be protected from normal-user and project writes.

## Desired experience

Download/install the application, launch it normally, select a project with a native folder picker, configure STARK in Settings, and chat. Users should not need to open a terminal and run `npm install` or `npm start` for ordinary use. Preserve the existing dark, chat-centered interface.

Windows uses an application executable and installer. The first Linux distribution format is a `.deb` package with a desktop launcher. x64 is the initial architecture; exact supported OS/distribution versions require target-device testing. AppImage and additional architectures are deferred.

## Candidate architecture: Electron launcher and existing application

Electron is the selected planning direction because the existing UI is React and the backend is Node/TypeScript. Reuse the product interface and server logic rather than rewriting them for a native toolkit. No Electron dependency or wrapper has been introduced yet.

The desktop shell would own native folder selection, opening the application window, backend health/readiness, start/stop coordination, and any approved host-side import helper. The UI should appear when ready and show a useful startup failure if its backend cannot start.

Keep privileged filesystem/process operations in a narrow host interface. Use an isolated renderer with explicit, validated requests; do not give arbitrary page content Node access. Preserve local API access controls and avoid treating a desktop wrapper as an authorization boundary by itself. Opening files or external links needs explicit, constrained behavior.

## Backend deployment choices

| Mode | Desktop responsibilities | Remaining work |
| --- | --- | --- |
| Native Linux backend | Launch bundled compatible backend/runtime and show UI | Native dependency builds, sandbox/helper setup, lifecycle |
| WSL backend on Windows | Launch/connect to selected supported WSL2 backend | Distribution selection, path conversion, authenticated transport and lifecycle |
| Container backend (deferred) | Not part of M16–M21 | Earlier alternatives retained only in CONTAINERIZATION.md |

Containerization and executable packaging are separate choices. A desktop application need not require Docker. If the container approach is chosen, the executable can primarily be a launcher and host integration layer.

Do not assume Electron's embedded Node version satisfies the backend contract. The application requires Node 24+ and `node:sqlite`; PTYs use the optional `node-pty` dependency. Plan a separate compatible packaged backend runtime with native modules built for that runtime/platform; WSL uses Linux artifacts. Validate exact runtime/ABI compatibility. A packaged React window alone is not a working backend distribution.

The current supported backend direction is Linux/WSL. A native Windows executable does not automatically make shell commands, PTYs or project toolchains Windows-compatible. Choose and label the execution environment explicitly.

## Earlier Docker discussion (not selected)

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

## Milestone sequence

1. **M16:** Stable app data, legacy migration and backend ownership/lifecycle.
2. **M17:** Sandboxed Linux execution and project-local dependencies.
3. **M18:** Structured, authenticated privileged package helper and setup entrypoints.
4. **M19:** Independent system-install policies, Settings, AI reviewer and install history.
5. **M20:** Electron shell, native imports, guided setup and helper provisioning.
6. **M21:** Windows/Linux installers, upgrades/uninstall and clean-machine acceptance.

This is the requested milestone plan, not a report of implementation. No worker is dispatched and no helper/system component is installed during planning. Detailed path ownership, contracts, dependency order, acceptance and coordinator handoff are in docs/milestones.md. Native folder imports continue editing originals in place; managed copies remain a deferred alternative.

## Acceptance evidence needed

Test actual installation and launch on each claimed platform, including machines without developer dependencies. Verify persistent chats/projects after app and backend restarts, upgrades and changed launch directories. Exercise folder selection, spaces/non-ASCII paths, file permissions, editor synchronization, approvals, Git, PTYs, cancellation and crash recovery. For container mode, also test unavailable Docker and container/image replacement without data loss.

Keep automated build success separate from installed-device, browser/native interaction and work-network STARK acceptance. Record unsupported combinations rather than presenting a single successful Windows or Linux run as universal support.

## References

- [Electron security and IPC guidance](https://www.electronjs.org/docs/latest/tutorial/security)
- [Bubblewrap policy and limitations](https://github.com/containers/bubblewrap)
- [WSL systemd support](https://learn.microsoft.com/en-us/windows/wsl/systemd)
- [Electron distribution overview](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)
- [Electron Forge distribution](https://www.electronjs.org/docs/latest/tutorial/forge-overview)
- [Docker Desktop installation on Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Docker Desktop WSL backend](https://docs.docker.com/desktop/features/wsl/)
- [Containerization and import options](CONTAINERIZATION.md)
