# Containerization: deferred design notes

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
