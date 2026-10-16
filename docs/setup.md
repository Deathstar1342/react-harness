# Setup guide

## Guided container source setup (M32)

The source entrypoints build and open the native Electron desktop. They require an existing local Linux container engine and never install Docker, WSL, host Node, Python, Bubblewrap, apt packages or a privileged helper. Source setup can build images; the future customer package must ship its reviewed payload without Git/npm/build instructions. M21 packaging remains paused.

Target platforms are non-root Ubuntu 22.04/24.04 x64 desktops and Windows x64. The Windows source implementation retains a separate actual Docker Desktop/device acceptance gate: native tests and a relocated Windows payload do not prove NTFS bind permissions, cross-platform SQLite behavior, transport or dependency-link compatibility. Workers still refuse every Windows reparse point. See [M32 acceptance](m32-acceptance.md) for current evidence and gates.

Use an approved local Docker Engine on Linux or Docker Desktop with its Linux engine on Windows. Select its normal local context before setup. TCP, SSH and remote contexts, rootless/user-namespace remapping and custom/remote Buildx drivers are refused. Docker's local context build driver must be available. The scripts do not configure or start an engine, modify Docker settings, adjust execution policy, change AppArmor, install a distro or acquire host administrator rights.

Linux needs Bash, Git, tar, standard coreutils and the normal desktop libraries used by Electron and private Python. Windows needs Git for source snapshots, its system tar executable and an approved PowerShell script policy. Native GUI/library checks belong to the actual supported OS; missing libraries or blocked user namespaces require the machine administrator's approved setup. Disposable CI may install its own prerequisites; that does not authorize workstation changes. WSLg and other distributions remain separate environment acceptance.

From a clean source checkout, run one command:

```bash
bash setup.sh
```

On Windows, use PowerShell from the checkout:

```powershell
.\setup.ps1
```

Setup asks for a **new external runtime/build/cache folder**. On Windows, choose an explicit local NTFS path such as `D:\abysSUS-source-runtime`. There is no default C: runtime location. The selected root contains the exact tracked source snapshot, build intent and logs, exported application/Electron/private Python payload, temporary files and desktop selection/cache. A small ignored `.container-desktop-source/selection` pointer is stored in the source checkout. Docker keeps its own image layers and build cache separately: its reported Linux data root does not establish the Windows VM backing drive. Inspect that location through your approved Docker administration; setup never moves it.

The native desktop then asks separately for persistent **app storage**. Choose an empty local folder, or deliberately reopen established storage. Projects, chats, provider configuration, goals, skills and receipts stay there. Missing established storage stops startup; it does not create an empty profile elsewhere. Enter provider address/key and exact model IDs only through the existing private Settings flow. Setup does not read, prompt for, log or pass provider credentials to a build. Work-only STARK validation remains deferred; there is no reason to enter work credentials on an unrelated machine.

For unattended build preparation with an explicit destination:

```bash
bash setup.sh --no-start --runtime-root /absolute/external/abyssus-runtime
```

```powershell
.\setup.ps1 -NoStart -RuntimeRoot D:\abysSUS-source-runtime
```

These commands build the application; they do not initialize app storage or configure a provider. `bash setup.sh --check` / `.\setup.ps1 -Check` perform read-only engine/build capability checks. They do not prove the full application or filesystem/device acceptance matrix.

Later launches use the same saved runtime:

```bash
bash start.sh
```

```powershell
.\start.ps1
```

`start.sh --check` / `start.ps1 -Check` validate the selected runtime, complete file inventory, source/platform/image bindings and exact local engine without launching the desktop. Start never builds, downloads, pulls, resets, replaces credentials or replays uncertain actions. Close the native window normally to use its existing dirty-editor/install/owned-supervisor drain safeguards. The old `--container` Bash spelling selects the same native source default; it is not a browser or host-execution fallback. Old `--stop` browser-source semantics are not part of the supported native entrypoint.

## Reruns, interrupted setup and updates

A completed setup rerun validates and reuses its saved payload and desktop selection. It preserves app storage and provider settings. Changing `--runtime-root`/`-RuntimeRoot` does not move an established selection. An incomplete selection, missing payload, changed inventory, changed engine identity or missing immutable image refuses; no implicit rebuild or replacement follows.

Build intent is written before each image build and export. Failed logs and partially exported files remain for inspection. A failed or timed-out Docker client may leave an engine build running; the script does not infer rollback or replay it. Preserve the selected root and its selection pointer. Investigate the exact retained attempt before any explicit new build; do not delete app storage, run broad Docker prune, change engine identity or remove unrelated containers to make a rerun pass.

Source updates are deliberate new build generations. The existing selection stays pinned to its source commit. Until a reviewed update/drain UI is provided, use a separate clean checkout and a new external runtime root after closing the prior native desktop; deliberately choose the same established app storage in the new desktop. Keep the prior payload and receipts for recovery. The launcher refuses tracked edits rather than calling a dirty tree the recorded commit. It sends an allowlisted Git archive of the exact commit to the builder; untracked files, local configuration, private PDFs and user projects are not build inputs. Git hooks/fsmonitor and inherited `GIT_*` execution configuration are disabled for bootstrap operations.

## Project and execution behavior

Import copies selected contents once into a managed project. The managed copy becomes authoritative. The source is not mounted into workers, synchronized, refreshed, written back or deleted. Import review shows exclusions and refuses unsafe links/special files/collisions. Explicit Export writes a copy to a new unrelated destination and never silently merges into the original. Removing a managed project cannot delete its original source.

Workspace approval modes remain separate from system-install Ask / Auto-approve / AI review policies. Package transactions target only the exact project container. Provider secrets, controller state, the Docker socket, host root/home and original import locations are not worker mounts. Container replacement does not authorize replay of uncertain installs, commands or goals. Approved recipes and dependency persistence remain distinct from a worker's disposable writable layer.

## Evidence and package boundary

The new source workflow requires actual source setup on Ubuntu 22.04 and 24.04 and an actual relocated Windows payload with its own dependency closure. Existing Container, Validate, Desktop, support-runtime and helper regression workflows remain required. Linux engine checks, native Windows handle tests, cross-staging, human native dialogs, actual Windows Docker, live-provider and clean-machine installation are different evidence classes. See the [milestone report](reports/milestone-32.md) for exact source/run identities and retained failures.

The repository currently contains no root project license; source setup grants no new license. Upstream runtime/dependency notices remain in their payload locations. Redistribution decisions, complete image/software notices and corresponding source, final manifests, signing, installers and clean-machine acceptance belong to the [M21 resumption delta](m32-packaging-handoff.md). No installer/release is published by this milestone.

The old direct-backend and browser-source scripts remain internal regression fixtures. They are not a supported workaround for missing container runtime or an implicit fallback to host shells. Model/native argument validation, approvals, versions, leases, guidance/skill revisions and uncertain-effect protections are unchanged.
