# Container backend plan — approved 2026-10-16

**Active direction:** native Electron GUI, containerized backend and project execution, persistent managed workspace, and one-time copy-on-import. The user approved implementation and the M28–M32 milestone workflow. This replaces the earlier Docker-free/Bubblewrap desktop target below. It is a plan, not a claim that the current application already runs this way. [Milestones](docs/milestones.md) and [STATUS](docs/STATUS.md) own delivery state.

## User experience

- Install/open the native desktop application. Guided setup checks a supported local Linux container engine and lets the user choose the app's persistent storage location, including a local D: folder on Windows. No manual Ubuntu app-backend setup, Bubblewrap, host Node/npm/build, or privileged host apt helper is required by the target desktop design.
- Import opens a native folder picker and copies selected project contents once into a new managed workspace directory. The source is never modified and is not mounted into an agent container. No automatic synchronization, refresh, conflict baseline, write-back or original-directory deletion is included. Changes outside the app do not affect the imported copy.
- New projects are created inside that same managed workspace. Editor, agent tools and Git operate on the managed copy. An optional explicit Export project saves a copy to a newly selected destination; it does not update or synchronize the source.
- Projects, chats, goals, plans, skills, settings and execution receipts survive app/container restarts and image replacement. Uninstall/rebuild/reset-runtime never silently deletes them. Storage cleanup is a separate explicit operation. Missing/unavailable established storage stops startup rather than creating a misleading empty workspace.
- Agent package installs target the execution container, never the host OS. Keep workspace approval modes and separate Ask / Auto-approve / AI review install policies, with the target clearly labelled. No host sudo/helper provisioning occurs. Container installs are not promises that package code is harmless.

## Components and trust boundaries

```text
Host Electron GUI + trusted launcher/import/export service
  -> local authenticated backend API in controller container
       -> native STARK calls, SQLite, goals, approvals, editor/file services
       -> authenticated, bounded execution requests to host launcher
            -> project execution container: shell, Python, Git, tests, installs
Persistent app storage: private controller state/config + managed project copies
```

The trusted host launcher is the only component with Docker control access. Do not mount the Docker socket, host root, user home, original imports, controller state or provider credentials into project workers. Workers receive only their own project and dependency/cache storage. The controller has no generic Docker socket or host-command API. Native tools never supply host executables, image names, mount roots or daemon options. Keep Electron's context isolation, sandboxed renderer, fixed IPC sender checks, CSP and narrow preload bridge.

Use a supported **local** Docker Engine/Compose deployment initially; Docker Desktop supplies that on Windows. Remote Docker contexts, SSHFS, privileged containers and arbitrary host path mounts are outside this sequence. Keep normal container security defaults and bounded resources. No host-shell or Bubblewrap fallback in container mode. We are replacing the execution boundary, not deleting native validation, approvals, file versions, leases or uncertain-operation protections. Ordinary outbound project networking may replace the old registry-only proxy; worker-to-controller/broker/private service access must remain authenticated/blocked as appropriate, and this changed network scope must be explicit in tests and docs. Container isolation is not an absolute host-security guarantee.

Container supervision must bind requests to an authenticated app/session, managed project ID, exact execution claim and allowlisted image/runtime configuration. Request freshness is rechecked before actual dispatch. Preserve final dispatch callbacks, project mutation reservations, durable command ownership, correlated native results and cleanup uncertainty. Lost controller/broker/worker replies are not proof of no effect. Restart does not replay commands, apt transactions, goals or PID handles. Reconnect can observe exact owned jobs only through an explicit validated protocol; it cannot invent success or adopt arbitrary containers.

## Storage and filesystem contract

The launcher records one stable, user-selected app-storage root outside installation/build directories. Logical layout:

```text
<app-storage>/config/                 private launcher selection and backend config
<app-storage>/state/                  SQLite, goals, chats, journals, skills, receipts
<app-storage>/workspace/<project-id>/  authoritative imported/new working copy
<app-storage>/runtime/                reconstructible images/install recipes/cache metadata
```

M28 must propose and test the concrete bind-mount/volume layout and host/container path mapping before substantial interfaces. Host-selected paths and container-internal paths are different types, not interchangeable strings. Workspace identity is independent of project display name. Only trusted host import/export operations access external selected folders. Container APIs cannot request arbitrary host reads. SQLite must have proven local filesystem locking/WAL behavior; Windows/Docker bind support must be measured, not inferred from Linux tests. If an engine-managed Linux volume is required for a storage class, make its actual location/engine ownership and D-drive implications visible; do not silently put bulk data on C: or move global Docker storage. No automatic workstation/engine reconfiguration is authorized.

Persist data independently of disposable containers. Dependency directories/cache have explicit persistence; apt changes in a worker's writable layer are not durable merely because project files are mounted. Record reviewed installation recipes/receipts and support deliberate rebuild/reinstall. Never automatically replay a pending/uncertain package transaction during restoration. Updating the app/worker image is distinct from updating project dependencies. Do not back up an active SQLite database with an unsafe raw copy; use existing ownership/backup mechanisms.

Imports stage into a fresh bounded destination, validate paths/bytes/counts, then publish a project registration only after copy success. Cancellation/failure leaves the original intact and reports any staged residue. Reject traversal, external/unsafe symlinks, special files, external Git worktree/submodule metadata and Windows case/path collisions. Show excluded files and actionable reasons; never call an incomplete import a complete copy. Default exclusions cover dependency/build caches and secret/config files; the user can explicitly include ordinary sensitive project files with a clear consequence, but never app/provider credentials. Do not follow links to expand the user's selected source. Git working tree import and history handling need an explicit M30 contract; do not copy unsafe .git indirections or silently lose dirty working-tree edits. Export uses the same bounded/path-safe rules and refuses silent overwrites/merges into existing destinations. Project removal may delete only its managed copy under an explicit confirmation, never the original import source.

## Runtime and packaging

Pin/build the controller and worker images reproducibly with Linux Node 24+, node:sqlite, native PTY support and appropriate trusted tools. Keep source, production dependencies, image provenance, architecture, notices and corresponding-source obligations explicit. No API key in Docker build args, layers, Compose files, CLI arguments, logs or Git. Private config and session secrets reach only the controller; shell environments remain scrubbed. Project install privilege, if needed for apt, is narrow and confined to a disposable worker with no controller/host mounts or Docker control. Workers must not be able to read controller credentials through shared process namespaces, networks or files.

Windows x64 desktop and Linux x64 are the first targets. A Linux container runtime remains a prerequisite; Docker Desktop may use WSL2/virtualization underneath. The app does not bundle Docker, install a distro, change kernel/AppArmor policy, edit Docker settings or request host admin rights silently. Guided detection offers instructions and honest unsupported/offline/proxy errors. Corporate licensing/runtime permission is deployment-specific, not implicitly granted by this plan.

`setup.sh` remains useful for source users, but M28 adds an explicit container path and M32 makes the supported guided container flow the default. Add a Windows PowerShell source entrypoint so Windows users need not enter Ubuntu or install host Node. Source setup may build local images; packaged users get the prebuilt/versioned payload and guided onboarding, not Git/npm/build tasks. Until delivered, existing scripts retain their documented Linux/Bubblewrap behavior and are not a workaround for Ubuntu 22.04's missing --disable-userns option. The cancelled Bubblewrap-specific worktree has no product changes.

M21 stays paused. These milestones own container integration, guided source setup and validation, not final installer publication. Preserve its unreviewed worktree/source-notices edits and original portability/manifest/signing/native-human gates. After M32 the coordinator reports the new packaging delta and asks for/uses subsequent explicit packaging authorization; never merge the old branch wholesale or publish a release automatically.

## Delivery and evidence

Run M28 persistence/controller foundation, M29 execution/install replacement, M30 managed import/export, M31 native desktop lifecycle, and M32 guided setup/integration validation sequentially. Each dedicated Milestone x chat works on an isolated codex/ branch from reviewed GitHub main. Coordinator reviews the report/source, requests corrections, validates meaningful portable/Linux/container/UI cases, pushes main and verifies every applicable exact CI job/step before starting the successor. Reuse the existing 15-minute check-in; stay quiet on unchanged status and pause for a genuine user-assistance blocker.

Acceptance includes data after stop/start and container recreation; no silent empty-profile reset; one-time import without source mutation; cancelled/unsafe import/export; actual PTY/test/Git behavior; stale editor/approval/goal/skill races; no provider/Docker/host-state access from workers; install decision/rebuild/uncertainty; controller/worker/desktop crash and close; Windows local D: storage and native picker; Linux and Windows runtime onboarding; secret-free images/archives; and source setup on a clean disposable machine. Synthetic/CI, actual desktop, installed-device and work-only STARK evidence stay distinct. Known work-only endpoint access is deferred acceptance, not an implementation blocker. No privileged package/engine installs or global changes on the developer workstation; use disposable CI/VMs.

Primary technical references: [persistent Docker storage](https://docs.docker.com/engine/storage/volumes/), [host bind mounts](https://docs.docker.com/engine/storage/bind-mounts/), [daemon control security](https://docs.docker.com/engine/security/), [Windows WSL backend](https://docs.docker.com/desktop/features/wsl/).

---

## Historical deferred discussion — superseded by the approved plan above

Update (2026-10-13): the selected desktop planning direction is Electron with Linux process sandboxing and a setup-installed package helper, without Docker or SSHFS. See [EXE.md](EXE.md) and M16–M21 in [milestones](docs/milestones.md). The alternatives below remain historical/deferred; they are not the selected import or execution model.

Status: **On hold at the user's request, 2026-10-13.** This document preserves the discussion; it does not authorize implementation, add a milestone, or change current import behavior. The approved M13–M15 sequence continues separately. Desktop packaging is also deferred; see [EXE.md](EXE.md).

## Goals and current baseline

Make deployment reproducible without requiring users to install the application's Node dependencies manually. Preserve chats, configuration and projects across upgrades, container replacement and restarts. Support projects located in multiple unrelated host directories without mounting the entire host filesystem.

The user has **not observed a persistence failure**; persistence was raised as a deployment concern. Today the backend runs locally, normally inside WSL, and imports register existing directories for direct editing. `HARNESS_DATA_DIR` defaults to `.harness` relative to the process working directory, containing `state.sqlite`. New projects default to `~/React Harness Projects`. These are current behaviors, not the proposed stable-home layout below.

The React UI, Node 24+ backend, SQLite, persistent shells, approval policies and STARK Chat Completions contract should remain usable. Containerization is an optional future distribution decision, not a prerequisite for the current milestones.

## Filesystem constraint

A container sees host files through explicitly configured mounts. Creating a symlink inside a mounted directory does not expose an otherwise unmounted host directory: its target is resolved in the container's filesystem namespace.

For example, mounting `~/.harness/projects` and adding `proj1 -> /projects/proj1` does not make the host's `/projects/proj1` readable unless the target is separately exposed at the expected container path. A symlink can alias an already accessible path, but cannot grant new host access.

A single user-selected parent mount is simple, but the user rejected it as the general import solution: projects may live in several unrelated directories, and mounting their common filesystem root is unacceptable.

## Option A: project-worker containers

A trusted host-side launcher/helper selects the real project directory and creates a project worker with that directory bind-mounted. The application backend maintains chats and orchestration; file, Git, test and shell operations are routed to the relevant worker. Workers may start on demand. Importing a project creates a new worker rather than requiring the main application to restart.

Benefits:

- Work directly on existing projects; changes from external editors remain relevant immediately.
- No second project copy or explicit publish-back workflow.
- Project-specific toolchains and a bounded mount for each project.

Costs and unresolved details:

- Introduces worker lifecycle, authenticated/local communication, action identity and restart reconciliation.
- Requires host/container path translation, ownership/UID/GID handling, Windows/WSL permission testing, file watching and PTY lifecycle checks.
- Must preserve file-version and dirty-buffer protections across the worker boundary; uncertain commands must never replay automatically.
- Multiple chats for one project must coordinate through the same workspace locks and worker lifecycle.
- Toolchains must include the compilers/interpreters needed by each project; a container does not automatically provide every dependency.

Keep the Docker control interface in a trusted host component. Do not expose unrestricted Docker access, application state or the STARK API key to agent shell processes. Bind mounts permit real host edits; isolation claims must match actual mount and execution policy.

## Option B: managed working copies with explicit apply-back

The host helper copies the selected project into a workspace visible to the main container. Existing in-container tool calls then operate on that managed copy. The UI offers **Apply changes to original** and **Refresh from original**. The original stays untouched until the user explicitly applies reviewed changes.

This was the latest tentative preference in the discussion because it preserves more of the existing backend. **The user has not selected it as the final import model.** It changes what Import means and must never silently replace today's direct-edit behavior.

A host-side component remains necessary: the container cannot read/write arbitrary original folders merely to perform the copies. However, the helper can be limited to folder selection, import, comparison and apply-back rather than routing every agent action.

Applying changes must not be a blind recursive copy:

- Record a baseline manifest with file identity/content hashes and the original root at import.
- Compare baseline, managed copy and current original. Apply unconflicted working-copy changes; preserve original-only changes; require resolution when both changed differently.
- Preview creations, modifications and deletions. Cover renamed files, binary content, type changes, case collisions and missing/moved originals honestly.
- Revalidate original paths and file versions immediately before writes. Record partial/uncertain apply attempts durably and never replay them automatically after interruption.
- Preserve the original `.git` metadata, index, branches and history. Choose working-copy Git initialization/history separately; do not copy `.git` back wholesale.
- Define inclusion rules for ignored files, dependencies, build output, credentials, symlinks and submodules. Show exclusions rather than silently claiming an exact copy. Avoid following links into unrelated directories.
- Decide which executable bits/permissions and platform metadata can be preserved. Do not promise cross-platform ACL equivalence without evidence.

This approach shifts complexity from container routing to conflict-aware synchronization. It also needs disk space for the working copy and a clear indication of which copy the user is editing. Existing editor/chat synchronization would apply to the managed copy; original-folder edits require refresh/comparison.

## Proposed persistent layout

Use a stable, configurable application home outside the install directory and disposable container layer. An illustrative layout is:

```text
~/.harness/
  config/.env
  state/harness.sqlite
  projects/
  artifacts/
  backups/
```

This is a proposal, not a migration already made. Windows/XDG conventions versus a cross-platform `.harness` home remain a decision. Projects may use a separately configured workspace. With direct imports, original projects remain in place; with managed-copy imports, `projects/` contains their working copies.

Keep durable chat/project relationships in SQLite. A `chats/` or `.chats/` folder may hold exports or artifacts, but renaming a folder alone does not improve persistence. Persist application state/config through dedicated mounts or volumes, separate from project-worker mounts. Do not mount the entire application home into agent workers.

Migration must locate the existing database and configuration, back them up consistently, preserve chat/project IDs and paths, and avoid starting an apparently empty profile because the launch directory changed. Database schema upgrades and rollback expectations need explicit testing. A moved project should support locating its folder without discarding conversation history.

## Deployment and acceptance considerations

- Container listener configuration needs a deliberate adaptation: today's backend permits loopback only. A container may need an internal non-loopback listener with host publication restricted to loopback, retaining host/origin validation and local-client protections.
- Retain real PTY behavior, signal handling, cancellation, file watching and version checks; validate on Linux and Windows/WSL separately.
- Preserve removal semantics. App-only removal must retain files; disk deletion must identify exactly which host/managed directory is affected. Never weaken M13 root/mount guards merely to make container paths pass.
- Test replacing containers/images while retaining chats, configuration and projects, failed migrations, interrupted commands, and import/apply conflicts where applicable.
- No live STARK acceptance is implied by image builds or offline tests.

If resumed, first choose the import model and data-location/migration contract, then prototype host-folder access and persistence in disposable fixtures before packaging the full application. Dockerfile/Compose files, worker protocols and synchronization code are intentionally not added by this document.

## Open decisions

1. Direct project workers, managed working copies, or explicitly separate modes?
2. Is explicit apply-back acceptable as the normal workflow for existing projects?
3. Stable application-home convention and compatibility/migration policy?
4. Supported Windows/WSL/Linux combinations and project toolchain images?
5. Host-helper installation, permissions and lifecycle ownership?

## References

- [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)
- [Docker storage and persistence](https://docs.docker.com/engine/storage/)
- [Docker volumes](https://docs.docker.com/engine/storage/volumes/)
- [Desktop packaging proposal](EXE.md)
