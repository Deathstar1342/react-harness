# Desktop development and setup

M20 adds a runnable Electron shell; M21 owns signed/final installers and fresh-device release acceptance. Use the exact evidence and limitations in [the M20 report](reports/milestone-20.md).

## Build and run

With Node 24+, run `npm ci` and `npm run desktop:build`. On Linux x64, `npm run desktop:stage-runtime` downloads the checksum-pinned official Node 24.16.0 distribution into ignored `build/runtime`, installs locked production modules in `build/app`, and verifies the runtime ABI/module load. Then `npm run desktop:start` launches Electron. No system installation occurs in these build commands. Rebuild the UI/application before restaging a release candidate. Source paths and runtime assets must not be mixed with personal profiles or project roots.

Native Linux uses `build/app` and sibling `build/runtime` during development; production layout is `/opt/abyssus/app` and `/opt/abyssus/runtime`. A Windows shell requires those fixed Linux assets already installed inside the explicitly selected Ubuntu/Debian WSL2 distribution. It does not run a backend on Windows or execute a checkout through `/mnt`. It enumerates WSL distributions without starting them, never selects a default/service distro, and never installs or changes WSL. Missing runtime/distribution prerequisites are setup failures with recovery guidance.

Select a persistent **Linux profile home**, then choose **Open existing profile**, **Initialize a new profile**, or **Migrate a legacy installation**. Native confirmation displays the target before any launch. Migration uses M16's existing ownership, backup, receipt and preservation rules. Stop every old backend first. Interrupted migration receipts/staging are retained; follow [M16 recovery instructions](setup.md#durable-profile-migration-and-lifecycle) for an explicit retry. Do not initialize another home to conceal lost data.

After startup, setup shows runtime/SQLite/PTY, Bubblewrap namespace, toolchain/registry bridge and optional helper prerequisites. Missing sandbox support never grants a host-shell fallback. Choose **Continue to chats** for ordinary safe use, then configure the STARK API endpoint and key in Settings. Changing an endpoint with a configured key requires a replacement/clear in the same save. Process environment overrides remain locked. **Test connection** is explicit and uses the existing bounded synthetic probe; saving settings does not contact the provider.

The Desktop control reopens setup. Native directory selection accepts local Linux folders or Windows `\\wsl.localhost\SelectedDistro\...` / `\\wsl$\SelectedDistro\...` folders. Windows drive mounts are unsupported. Cancellation preserves the current project/editor. The backend still applies its normal canonical project/root, credential, link and overlap guards.

## Optional system-install authority

An administrator must install reviewed root-owned helper assets first. `node scripts/helper-stage.mjs` builds a **data-only `.deb` scaffold** on the target Linux distro/apt ABI, without installing anything or adding maintainer scripts. Final distribution/signing belongs to M21. The desktop never elevates a renderer-selected package or a checkout/npm/Python script.

With `/usr/lib/abyssus-helper/launcher` installed through that trusted OS boundary, setup offers Enable/Repair/Remove. A native confirmation precedes `pkexec` and the OS authentication agent owns credentials; passwords never cross the application. A usable graphical polkit agent is required, including in WSL (WSLg alone is not an authentication agent). Missing/cancelled/denied OS authorization leaves an explicit failure, without installing prerequisites or falling back to sudo/password IPC.

Maintenance first drains the backend's local tools/install calls. Save/discard dirty editors first. Setup/repair requires authenticated signed hello; repair compares prior installation identity when a valid descriptor is available. A missing/damaged descriptor can be repaired through OS authentication. Removal verifies expected code/credential/unit/socket absence and preserves packages, audit and all user data. A connection failure alone is never removal success. Reopen the existing profile after maintenance; no uncertain package action is replayed.

## Lifecycle and browser compatibility

The shell permits one application instance, focusing its existing window on a second launch; M16 independently locks actual profile/resources across other launchers. The backend is a separately owned Node process. Private stdio launch material and signed M16 readiness authenticate its instance/profile before API use. Exit awaits local cleanup and actual process termination. Failed cleanup retains ownership. No unrelated process is killed based on a port or PID, and closing does not roll back system changes.

Renderer crash/reload keeps the backend tracked; a crash warning explains possible unsaved buffer loss. Backend crash requires explicit recovery. A restarted/different backend is assigned a new verified session and replaces the prior renderer after its dirty guard; old document requests cannot cross into it. Historical M19 uncertainty remains durable and does not itself hold an endless shutdown loop.

Ordinary `npm start` remains available. It prints one deliberately displayed single-use, five-minute **browser pairing code**. Enter it in the browser to receive an HttpOnly SameSite cookie scoped to this backend instance. Ten invalid attempts exhaust pairing; restart deliberately to obtain a new code. No reusable capability is printed or put in a URL. Desktop launch disables browser pairing for its backend. Existing browser sessions expire on backend restart. Sandbox network isolation protects backend transport from project processes; arbitrary unsandboxed same-user programs are outside this boundary.

## Validation commands and boundaries

Run `npm run typecheck`, `npm test`, `npm run desktop:build`, and `npm run desktop:smoke`. Smoke launches real Electron with a disposable browser profile; Linux CI also uses the dedicated runtime and actual backend. Native confirmation/picker replies in automated connected smoke are synthetic; the shell, backend, API/SSE, SQLite and runtime checks are real. No developer workstation helper provisioning is performed. Disposable helper CI validates root staging, actual `pkexec` OS-policy allow/deny, signed identity, repair and removal; password-entry/cancellation and installed-device acceptance require a real OS agent/device flow.

For Windows/WSL end-to-end acceptance, use a disposable Windows x64 VM with nested virtualization, an explicitly installed Ubuntu/Debian WSL2 distro, fixed backend/runtime staging, non-root user, Bubblewrap/toolchains and systemd/polkit agent. Exercise native UNC picker, lifecycle, network forwarding, auth, PTY, helper OS allow/deny/cancel and restart. Hosted-runner nested virtualization is not a guaranteed supported facility. Windows Electron smoke alone does not satisfy this gate; no local Podman service distro may be repurposed.

Use the committed [Windows/WSL acceptance procedure](desktop-wsl-validation.md) and `scripts/desktop-wsl-validate.ps1` in that provisioned disposable VM. They collect evidence and preserve profiles/projects; they do not provision a distro, install a helper or automatically mark manual checkpoints passed.
