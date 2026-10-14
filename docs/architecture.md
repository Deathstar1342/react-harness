# Architecture and implementation plan

## Product direction

### M19 system installation decisions

`InstallService` wraps the M18 authenticated helper with independent profile/selected-local-Linux-target policy. Lazy readiness checks never provision or activate the helper. Settings defaults to Ask every time; Auto-approve and AI review remain independent of workspace approvals. The reviewer ID is copied once from the critic default; changing it does not alter saved chat models. An authenticated target change resets policy to Ask and invalidates pending decisions. M20 owns selection/launch of a different backend environment.

Architect/coder `recommend_packages` is a bounded advisor recommendation containing names, optional exact versions and a reason. Planning and critic roles cannot request installation. Strict helper DTO/closure/digest validation precedes any decision. Ask uses the existing approval card with exact target, requested/dependency versions, provenance, expiry and the root maintainer-script/trigger/service-impact exception. Auto approves only supported concrete previews. AI review uses separate fixed guidance and curated evidence, with no chat transcript, extensions, secrets, tools or helper authority. It uses the managed critic account ledger with the snapshotted reviewer ID, 1024 output tokens, a 20-second deadline and per-call transport retries disabled. Strict two-field JSON rejects duplicate keys; errors/refusal/timeout/ambiguity ask a human only while the original preview remains valid.

SQLite install records are independent of chat/project cascading cleanup. Policy/target/reviewer revision, requesting frame/role, generation/mode version, recommendation, exact preview, decision source and actual outcome are durable. A changed or expired preview requires a new UUID and decision via explicit refresh; old pending work is never released by raising autonomy. Following all awaited context/authorization work, the service synchronously rechecks bindings, persists dispatch and immediately invokes execute. Cancellation or steering after that boundary cannot undo apt effects. Lost replies/restart only permit authenticated status/reconcile, never execute replay. Healthy explicit reconciliation can release the recovery gate while retaining the original uncertain outcome. History is available on demand, including after safe scoped deletion.

Shutdown invalidates pre-dispatch work and drains local helper/reviewer calls before releasing lifecycle ownership. Durable historical uncertainty does not prevent ordinary closure; it gates new installs and scoped removal on restart. Missing/unsupported helper leaves ordinary application use available. No privileged shell fallback, automatic setup, provider transport mode change or Electron implementation is introduced.

### M17 execution boundary

`WorkspaceTools` requires non-root Linux Bubblewrap for every persistent PTY/Python/test process and fixed Git subprocess. There is no host-execution fallback, including on Windows. Project creation writes a fixed empty Git layout without invoking ambient host Git/templates. The application wires M16's effective home, state/config/prompt locations and registered project set into trusted sandbox policy. Imported projects stay in place.

The adapter creates user/mount/PID/network/IPC/UTS namespaces, drops capabilities, disables nested user namespaces, and exposes fresh `/proc` and `/dev`. Only the selected project and private per-project home/cache/temp are writable. Distro tool directories, the exact backend Node binary/adjacent npm distribution and public CA certificates are read-only. Personal home, host `/etc`, `/run`, `/sys`, Windows mounts, interop endpoints and backend/helper sockets are absent. System/credential roots, overlapping app/state/toolchain/other-project roots, nested mounts, external symlinks, hardlinks and special files are rejected. Internal dependency symlinks and links to exposed distro binaries/libraries are supported.

Existing credential files are covered by empty read-only regular files; protected directories, including `.git` in arbitrary shells, by empty read-only mounts. Fixed `git_status`/`git_diff` use a separate networkless sandbox with metadata visible only to fixed argv; literal pathspec/filter/fsmonitor/hooks/credential-output safeguards remain. **Shell Git commit/branch operations cannot access the original `.git`.** External worktree metadata is unsupported; no secret-rich parent is mounted to recover access.

**Concurrent host mutation limit:** mounts are the boundary; scanning is not race-proof. Pause execution before introducing secrets, links, mounts or changing protected topology. Between commands, root/protected inode identities are revalidated; changes discard the shell before execution. In-place edits of an already masked file stay masked; atomic replacements require revalidation/reset. A trusted external process can introduce an unmasked secret during a command; this is not prevented. Secrets embedded in ordinary source cannot be identified by filename policy. The project is deliberately writable: malicious code can corrupt/exfiltrate visible contents. Shared-kernel vulnerabilities and CPU/memory/disk exhaustion remain risks; this is not a VM, disk quota or cgroup resource boundary.

Downloads use a per-session backend Unix CONNECT broker and fixed socat bridge at isolated `127.0.0.1:18080`. There is no general route or host DNS. Only exact `registry.npmjs.org:443`, `pypi.org:443`, `files.pythonhosted.org:443` are accepted. Every DNS answer must satisfy conservative global-address policy; mixed/private/special/transition answers fail, and connections pin a checked literal IP. HTTP, alternate registries and redirects to other authorities grant no access. TLS stays end-to-end, verified by npm/pip. The broker does not inspect package content or prevent registry-directed exfiltration. Proxy config edits cannot create a route. Connections, headers, bytes, DNS/idle/lifetime waits are bounded. The private socket directory contains only that session's registry capability.

Cancellation kills Bubblewrap/the PID namespace and awaits PTY exit and broker teardown. Namespace PIDs are never signalled as host PIDs. Unconfirmed cleanup quarantines the scope and causes backend shutdown to fail, retaining M16 ownership. Async scope removal gates workspace operations/dirty leases, drains resources, then revalidates before its synchronous mutation. Private storage survives shell restarts. Explicit reset clears only that subtree after idle/dirty/background checks; source, `.venv`, `node_modules` remain. No uncertain action is replayed.

Desktop extension (2026-10-13): M16 implements stable application data/migration and backend lifecycle in this candidate; coordinator review/integration remains separate. M17–M21 still plan Bubblewrap-confined Linux execution, a narrow privileged package helper provisioned with OS authorization during setup, independent Ask/Auto-approve/AI-review system-install policy, an Electron shell and validated installers. Those future boundaries keep backend/model credentials outside agent sandboxes; helper authorization applies to an exact structured package request, never arbitrary privileged shell text. Windows desktop targets a selected WSL2 Linux backend; native Linux remains supported by the planned matrix. See root `EXE.md` and the current milestone plan for full boundaries and evidence gates. Existing PTY cwd and approval checks are not an OS sandbox. No Docker or SSHFS implementation is planned.

Approved extension (2026-10-13, implementation tracked in M12–M15): contextual chat/project deletion with distinct app-only and explicitly confirmed disk deletion; `.env`-backed provider settings with durable per-chat model assignments; a persisted planning-to-execution transition; an on-demand header-accessible plan panel with evidence-linked progress; and turn-local historical errors separated from unresolved current blockers. M12 error handling, M13 removal, M14 provider settings and M15 planning/progress are implemented; integration and acceptance remain coordinator-owned. Preserve the `init_test` advisor-style wording: models recommend actions and the application separately validates and performs them. Keep ordinary text Chat Completions compatible with streaming disabled. See `milestones.md` for exact boundaries and acceptance.

Build a local browser application with a Node.js/TypeScript backend running in WSL. Chat with the architect is the primary interaction. Files, diffs, plans, terminal output, and test results are optional supporting panels.

The visual direction is a quiet, Codex-inspired dark workspace: charcoal surfaces, flat project/chat navigation, subtle separators, and contextual controls. Avoid a dashboard of boxed buttons or prominent implementation/status cards. Keep the conversation and composer central, with secondary controls in unobtrusive menus and collapsible panels. Preserve visible approval decisions, keyboard focus, and readable contrast.

This is a fresh implementation. There is no dependency on the previous Streamlit/FastAPI application or its tools.

## Provider contract

M12 now preserves the advisor protocol while accepting recovery only for a complete schema-valid response inside a whole-message JSON/plain Markdown fence. Nested fragments, incomplete outer objects and prose examples cannot supply executable actions. Existing bounded formatting retries and policy checks remain in force. Historical errors are attached to durable transcript positions with identity-based deduplication; current connection/request problems remain separate. Command exit evidence and test-report availability are displayed independently, and critic checkpoint verdicts never rewrite a recorded execution result.

- Use only `/models` and `/chat/completions` on a configurable STARK-compatible base URL.
- Keep the API key in backend environment configuration; never return the saved key to the browser or expose it to logs or child shell environments. Settings accepts an explicitly entered replacement key in a protected request and never persists it in browser storage.
- Use streaming ordinary text and a versioned JSON action protocol. Do not require native `tools` or `response_format` support.
- Keep prompts configurable and validate actual provider behavior early. Optional ARCHITECT_PROMPT_FILE, CODER_PROMPT_FILE and CRITIC_PROMPT_FILE settings load bounded local UTF-8 guidance at startup, appended to the fixed JSON instructions. Prompt files never alter runtime permissions or parser validation and are not exposed through frontend settings.
- Buffer complete actions before schema validation and authorization. Partial streamed JSON cannot execute.
- Distinguish malformed output, refusals, truncation, transport errors, and valid actions. Bound retries and avoid duplicate execution.
- Persist execution identifiers and outcomes. Reconcile uncertain side effects after interruption rather than blindly replaying them.

Default model assignments are architect `gemini-3.1-pro-preview`, coder `gemini-3.8-flash`, and critic `gemini-3.6-flash`.

M14 Settings discovers model IDs through `/models` and permits manual exact IDs. Defaults apply only to new chats. Startup transactionally fills missing legacy `Chat.models` from the effective startup configuration before recovery; creation clones the current defaults into each durable chat. A settings save repeats the backfill before changing defaults. Runtime, resumed frames, every role and compaction resolve the saved chat map, including summary cache identities. Assignments never include credentials. Existing saved assignments survive manual `.env` edits and backend restarts.

`loadBackendConfig` reads the selected stable profile's UTF-8 `config/.env` with dotenv parsing and overlays the original process environment. It does not inject dotenv values into `process.env`. Externally supplied model/key variables, including empty values, lock those fields against Settings writes. Unsupported custom dotenv path/encoding/override/parser options fail startup explicitly. `ProviderSettingsFile` confines writes to that configured backend file, bounds it to 1 MiB, rejects links/hardlinks/special files, validates complete input and dotenv round trips, preserves unrelated source bytes, and commits through a flushed exclusive temporary file and atomic rename. Stale external edits reject before replacement. Legacy assignments commit first; a failed replacement leaves active configuration and future defaults unchanged. After rename, active configuration/defaults publish synchronously. A failed identity refresh reports that settings are saved and active but requires restart, and latches out further saves rather than adopting external changes.

The shared key applies when the next provider invocation begins, after any scheduler queue wait. `ReloadingProvider` creates an immutable `StarkProvider` for each invocation; that instance retains the captured base URL, transport and key throughout the request and its internal retries. Production retries remain disabled as before, and scheduling/accounting is unchanged. Rotation/clear does not interrupt in-flight work. Provider errors remain fixed sanitized messages, so delayed failures do not need an unbounded retired-key registry. Connection checks capture role IDs at check start; each individual request captures its credential on dispatch. The UI discards diagnostic results superseded by a provider save, including late results from an older check.

Persistence coordinates one backend instance in a trusted directory. Native pathname checks cannot eliminate external substitution after the final check, and this is not a filesystem sandbox or a multi-process configuration service. Unix replacement files use mode 0600; Windows inherits directory ACLs. The file is flushed before rename, but no cross-platform power-loss guarantee is made for directory metadata. See the API contract and setup guide for unsupported syntax/override recovery.

Google publishes input limits of 1,048,576 and output limits of 65,536 tokens for each model. These are configurable capacity limits, not target request sizes:

- [Gemini 3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Gemini 3.6 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash)

## Agent coordination

The architect owns user interaction, requirements, plan revisions, delegation, steering, and final reporting. `/plan` requests planning without execution. Small tasks do not require elaborate phases.

Coders receive bounded objectives, relevant context, file scope, and acceptance criteria. Begin with one coder. Add parallel execution once workspace isolation and integration are reliable.

The critic inspects actual diffs and verification evidence against user intent and acceptance criteria. Trigger reviews at phase completion, before final delivery, after repeated failures, and when scope expands. Bound repair/review cycles.

The runtime owns task status and permissions. Model prose cannot authorize an action or mark an unverified test as passed.

## Workspace and tools

Provide file read, list, search, patch/write, local Git operations, shell execution, and Python execution through the local tool service. Create a Git repository for a new project. Preserve existing repositories and uncommitted work when importing projects.

Project creation asks for a name and allocates a unique folder inside the configured default workspace. Default to `~/React Harness Projects`, with an initial `HARNESS_WORKSPACE_ROOT` environment override. A Settings panel lets the user choose another drive/folder; persist that preference in SQLite. A preference change affects future projects and never silently moves existing ones. Avoid overwriting a same-named project; allocate a suffixed directory atomically.

Import uses a folder explorer with breadcrumbs, parent navigation, drive/root shortcuts, folder rows, and explicit folder selection. This is a view of the backend filesystem, not a browser file upload. In WSL, show Linux paths and available mounted drives. The browser only receives directory metadata; model file tools retain their separate project-boundary checks. Support existing absolute-path API clients, but do not require ordinary users to type paths.

Use independent persistent PTY sessions for active coders so `cd`, activated environments, and shell state persist between their commands. Serialize access within a shell; track command boundaries, exit status, cancellation, and background processes. Browser reconnects attach to existing backend sessions.

Backend restart recovery may recreate shells and working directories, but must not claim to restore arbitrary shell memory or dead processes.

Parallel coders may use Git worktrees. Validate changes against the current integration destination before applying them. Chats sharing a workspace receive change notifications and obey common write coordination.

## File editing and approvals

Every read returns a file version. Every edit references the version it was based on. Recheck immediately before applying; reject stale proposals and require a refreshed edit. Protect unsaved editor buffers and observe external saved changes. Propagate relevant manual-change diffs to affected agents.

Approval modes:

| Mode | Behavior |
| --- | --- |
| Full workspace autonomy | Permit actions within configured workspace and execution permissions |
| Balanced | Permit routine edits and configured checks; request approval for installs, expanded access, and designated actions |
| Review every change | Permit reads; request approval for writes and potentially modifying commands |

File approvals display the current-to-proposed diff and are bound to the exact proposal and file version. Changes invalidate stale approvals.

An editor save keeps its dirty-buffer lease until the editor explicitly reports that its current buffer is clean, covering keystrokes arriving during an in-flight save. Agent edits notify every chat sharing the project and invalidate affected pending proposals; historical execution approvals remain audit records. Publish durable events after database commit, return recent activity for long chats, and support event replay on reconnect.

Shell execution must obey the same policy. Arbitrary commands cannot have a guaranteed predicted file diff. When a pre-application diff is required, execute in an isolated workspace and review the resulting changes before integration. A working directory alone does not enforce filesystem confinement.

Changes opens on demand beside Files while keeping the editor mounted. It separates current Git modifications, whose ownership is unknown, from recorded agent write attempts. Each write captures private before/after snapshots under its unique action ID before dispatch; only a matching successful result confirms the record. Interrupted recording or undo claims become unknown on restart and cannot replay.

Selective undo requires a server-issued five-minute preview token bound to the project, write, and expected file hash. With every project run stopped, a runtime guard excludes launches while the shared file lock rechecks paths, content and dirty editor leases. A synchronous durable claim immediately precedes restoring the previous content or removing a newly created file. Undo preserves the Git index and unrelated files, notifies sibling chats, and invalidates prepared approvals. Late lease acquisition is checked again after asynchronous validation. Shell changes and legacy actions without snapshots have no automatic undo. One backend instance is assumed; external filesystem races and changes reverted to identical bytes cannot be excluded atomically.

History lists the latest 100 records with a truncation notice. Diffs have a 200 KB review bound, and at most 200 preview tokens are retained. Larger snapshots remain private in SQLite but are unavailable for UI undo; history is not automatically pruned.

## Persistence and context

### Chat and project removal (M13)

Sidebar overflow disclosures expose chat deletion and project removal without selecting a different chat. Keyboard focus and Escape work through the shared modal. Removing a project offers app-only removal, disk deletion, or Cancel. Disk deletion opens a second confirmation with the exact backend canonical directory; the user must type it exactly. Imported registrations use the same flow. App-only removal leaves the folder and its contents in place; importing that folder later creates a fresh registration without the deleted conversations.

Removal holds the runtime project guard. Actual runtime promises (including stopping work), approval/control operations, pending approvals, executing frames, tool calls, API requests that could still register or access the project, dirty editor leases, queued shell commands and known live background jobs prevent removal. Chat deletion conservatively uses the same project-wide exclusion. Paused frames can be discarded only after their pending actions are resolved or invalidated. No delete endpoint implicitly interrupts active work. Runtime cached frames and durable run/plan/context state are discarded with the chat, along with messages, approvals, tests, events and chat-owned write history. Global preferences and scheduler accounting remain.

Disk confirmation tokens are one-use, in-memory, bounded to 200 and expire after five minutes. They bind registration ID, exact canonical path and directory/ancestor device, inode and birth-time identity. Validation occurs under the guard before scoped idle PTY cleanup or file mutation. The synchronous final lease check and filesystem mutation prevent another request in this backend from slipping through an asynchronous gap. A bounded preflight (100,000 entries, depth 128) rejects links, junctions, special entries and nested mounts; Linux also inspects mount points to reject same-device bind mounts. A directory is removed only after its validated children; unexpected new entries cause failure. Filesystem/home/workspace roots and their ancestors, application/config/database trees, and overlapping project registrations cannot be deleted from disk. App-only removal remains available for these registrations.

An intent/error marker (`Project.removalError`) is durable before the first filesystem mutation. Disk and SQLite are not a shared transaction. Partial disk failure or a crash leaves the registration and marker visible, blocks new work, and never replays deletion on startup. The user can inspect remaining files and explicitly request a new confirmation, or remove only the app registration. If the folder was already removed but database cleanup failed, app-only recovery is available. Successful database removal closes scoped SSE streams with a terminal `chat_removed` event, closes watchers, cancels debounce timers, clears write/preview caches, and prevents callbacks already awaiting reads from publishing orphan events. The client stops reconnection and polling on this terminal event or an authoritative chat 404, while ordinary transport failures retain reconnect behavior.

These checks coordinate one backend instance, not arbitrary external programs. Pathname checks cannot atomically prevent an external process from swapping a directory between validation and unlink/rmdir. External or detached processes outside tracked PTYs are not a filesystem sandbox. Stop external writers before disk deletion. Links/mounts, uncertain executing records, oversized trees and unavailable lifecycle capabilities fail closed; app-only recovery or external file management remains explicit. Large synchronous scans/deletions can temporarily delay other backend requests. Files are permanently removed, not sent to a recycle bin.

Use SQLite plus artifact storage for projects, chats, messages, plans, tasks, tool calls, approvals, file versions, summaries, and test reports. Preserve original transcripts and large output artifacts for retrieval.

Use model-written continuation summaries independently for architect and coder contexts. Preserve goals, decisions, constraints, outstanding work, and evidence references. Reattach authoritative task state, recent steering, pending approvals, and file versions separately from the model summary.

Root `AGENTS.md` is fresh project guidance for every role, attached outside compacted history with a 32,000-byte UTF-8 bound. Runtime and prepared-action fingerprints distinguish absent, present, and legacy/unvalidated guidance. Recheck around provider/inspection awaits, approval decisions and tool dispatch; changed or invalid guidance invalidates prepared proposals while preserving recorded or uncertain executing outcomes. Explicit user requests take precedence over project conventions, and runtime permissions remain enforced independently. Nested discovery is not implemented. These checks do not atomically lock out external editors or guarantee model compliance.

Compact before exhausting input capacity, with room for instructions, output, and tool results. Use conservative estimates when provider token counting is unavailable. Do not infer infinite memory from a large context window.

## Steering and scheduling

- `/btw` delivers additional guidance at a safe boundary, with a visible delivery acknowledgement.
- Interrupt cancels generation where possible and blocks new tool actions before returning control to the architect.
- Pause/resume persists task state. Cancellation does not undo completed side effects.
- Propagate steering to affected coders and invalidate obsolete pending actions.
- Ordinary Chat Completions requests cannot receive newly inserted messages mid-generation; cancel and restart or wait for completion.

Coordinate all roles through a shared scheduler. Initial configurable account budgets are 120 requests/minute, 1,500,000 tokens/minute, and 150,000,000 tokens/day. Reserve capacity for user interaction, steering, and compaction. Handle provider throttling and track estimates versus reported usage.

## Interface and test reports

Left sidebar: projects and chats. Center: architect conversation with collapsible activity and approval cards. Optional right panel: files, editor, and diffs. Collapsible plan panel: phases, steps, owners, blockers, and verification. Bottom drawer: shells and tests.

Terminal opens from a button beside Files and starts closed for each selected chat. It is a read-only command/output panel; toggling it neither executes commands nor resets the shell, editor or conversation. Tests and Debug Activity remain separately accessible. Command events carry exact action, agent and logical shell-session identities. Start evidence commits with execution intent, and outcomes commit with completed runtime state. Recovery records uncertain executing commands once without replaying them; a requested stop alone is not proof that execution ended.

Only an actual command exit establishes completed/failed status. A successful test command can still have an unavailable test report, displayed as a separate tool problem. Missing exit evidence and lost command boundaries remain uncertain. Final output snapshots replace overlapping streamed chunks, while absent snapshots preserve partial output. The latest 1,000 events are shown with explicit history omission; chunks retain 16,000 characters and each command/snapshot at most 64,000. Legacy unmatched events remain unassociated. Shell-session IDs identify logical slots, not persistent OS processes. Output is escaped text, without interactive command entry or terminal emulation.

Settings owns approval level selection: current-chat mode and a persistent default for future chats are distinct. Policy changes are rejected while the current chat is running, awaiting approval, or has pending proposals. Debug is persisted backend-wide and off by default; ordinary chat hides internal coder/critic/successful-tool detail while retaining actionable errors, approvals, diffs, and tests. Test connection is an isolated, cancellable catalog/reply check with fixed sanitized results, a total deadline, and managed completion budget accounting. Diagnostic replies cannot execute actions; JSON protocol and streaming transport remain internal configuration details rather than UI switches.

The desktop editor pane supports a draggable, keyboard-accessible left divider and an expand/restore control. Expansion fills the main workspace while keeping the conversation and editor mounted, preserving drafts, unsaved file buffers, and live activity subscriptions. Restoring keeps the chosen split width; narrow screens use the existing overlay layout.

Milestone 7 refines this layout into a seamless dark theme and adds the folder explorer/default-workspace settings. Flat selectable rows and small icon or overflow actions replace repeated button outlines. New-project creation defaults to the workspace, while import and workspace Settings reuse the same folder explorer. Maintain manual-edit guards when changing project/chat or closing supporting panels.

Use structured test reports, beginning with pytest JUnit XML, rather than model interpretation of console text. Group the drawer into collapsible runner, run, and individual test levels, with green checks/red crosses plus readable status labels. Display runner, individual runs, test cases, status, traceback, and captured output. Distinguish skipped cases, failures, collection errors, cancellation, and runner crashes.

## Delivery sequence

1. **Provider and protocol:** model discovery, text streaming, schema validation, bounded error handling, and configuration. Verify malformed or partial actions never execute.
2. **Durable agent loop:** architect delegates to one coder and reports evidence; reopening restores conversation and task state without duplicate actions.
3. **Workspace correctness:** file tools, version checks, approvals, persistent shells, execution controls, and manual-edit protection. Verify stale edits and approvals are rejected.
4. **Complete chat UI:** projects, chat selection, editing/diffs, plans, steering, cancellation, and reconnection.
5. **Critic and verification:** evidence-based reviews, bounded repair, structured test results, and accurate completion reporting.
6. **Parallelism and delivery:** isolated coder workspaces, integration checks, concurrency tuning, startup documentation, and recovery tests.

The first end-to-end milestone is a persistent architect conversation that delegates to one coder, proposes an approved file change, applies it, returns the result, and survives reopening.

Implemented baseline: one delegated coder at a time, persistent conversations and action records, approval/version checks, Linux PTYs, structured JUnit reports, critic checkpoints, model-written context summaries, and durable request budgets. Parallel coder workspaces remain a later extension; do not present serial delegation as parallel execution. The M7 redesign and workspace selection APIs are integrated. Live STARK acceptance, integrated visual verification, and final Linux release checks remain explicit gates in `docs/STATUS.md`.

Root project instructions, selective per-write undo and the on-demand command/output view are implemented. Parallel coders and broader activity navigation remain possible later extensions.

## Planning and execution bridge (M15)

`Chat.mode` (`plan` or `execute`) and monotonically increasing `modeVersion` are durable application state. New chats retain the existing execution-enabled default. Existing chats are backfilled from saved `RunState.planOnly`; no mode is inferred from model messages. A completed planning turn remains restricted on later turns and after restart. `/plan` at the beginning of an actual user message enters planning; generated or quoted occurrences cannot change mode.

The header **Plan** control opens a bounded, scrollable panel outside the transcript. **Start building** submits a real user instruction in the same chat, preserving its history, plan, model assignments, approval mode and file-version protections. The server checks the exact plan identity/revision and mode epoch. An identical accepted button request is idempotent, including after restart; requests from an earlier planning session fail after `/plan`. The only text shortcuts out of planning are the entire trimmed messages `go ahead` or `start building`, case-insensitive, optionally followed by a single period or exclamation mark. They require a current nonempty plan. Other prose stays in planning. No model action can authorize a transition.

Transitions prepare a separate run draft and commit mode, user message and queued/new run together. Cached permissions/generation/steering and loop launch are published only after commit; a failed build cannot change the state held by an active planning request. Delegation, coder-final/completion-critic creation and accepted-review consumption similarly commit cloned frame snapshots together with their progress/evidence, then publish the live root. Active model responses are invalidated through generation/steering boundaries. In-flight control decisions and executing/uncertain operations reject a build transition until reconciled. `/plan` invalidates prepared approvals; running effects cannot be rolled back and keep their recorded outcomes. Recovered prepared actions are checked against durable mode before dispatch. Existing approvals, guidance freshness, version/lease checks and uncertain-command non-replay still apply.

Plans have a server-owned UUID and revision. `set_plan` preserves its existing schema but cannot author execution progress. New/revised structures normalize statuses to pending (or explicit blocked). Identical ordered phase/step IDs and titles are a no-op regardless of proposed status, preserving revision and evidence. Structural changes increment the revision and conservatively reset current progress; old events and failures remain in the archive and recent progress history. Legacy unassociated completion is not migrated into verified completion.

`delegate.planStep` optionally identifies the exact plan/revision/phase/step. The association belongs to a unique coder frame. Progress records actual delegation start, tool outcomes, approval/user waits, stop/error/budget/restart conditions and coder completion awaiting review. Only that coder's structured completion review can mark the step done, and at least one recorded coder/reviewer tool result must exist. This is recorded critic acceptance, not independent proof of semantic correctness or passing tests. Checkpoint or unrelated reviews and legacy/unassociated work cannot complete a step. Revisions and newer delegation owners reject old progress updates. Steering conservatively blocks and removes an old assignment's progress authority; the architect must issue a fresh associated delegation for acceptance under changed guidance.

Each step retains its latest evidence summary and durable event IDs. `plan_progress` records the exact association and delegation, outcome, status and source event. Review events reference bounded tool-event IDs. The panel exposes step evidence and recent history with source details, retaining the existing 1,000-event HTTP history limit honestly. Toggling it does not remount the composer or editor; Escape/Close returns focus to the header control. This coordinates one backend instance; no parallel coder, packaging or deployment expansion is included.


## M16 profile and process lifecycle

`locations.ts` separates module-anchored installation assets, platform-native `HARNESS_HOME`, profile configuration/state, original project folders and future `cache/sandboxes`. `profile.ts` owns known-source selection, private staging, consistent WAL-inclusive SQLite backup, bounded regular artifact copying and durable migration receipts. It never invokes runtime recovery or changes project registrations during copying. Interrupted pre-publication legacy migrations need an explicit fresh retry; complete published profiles retain their identity across launch directories and upgrades. Explicit legacy data overrides stay in place, and relative legacy paths are normalized against the source root.

`bootstrap.ts` holds canonical home/config/data ownership across configuration loading, store recovery, listen and orderly close. Separate homes sharing a data override cannot both start. Successful startup records the effective data binding; lost overrides and missing established data/config fail closed. Installation-relative static lookup no longer follows cwd. `createApp` remains an embeddable trusted test interface; production uses `startBackend` to enforce ownership and lifecycle. Lower-level Store/createApp constructors alone are not process-ownership boundaries.

`lifecycle.ts` supplies an additive HMAC launcher protocol. A private per-launch key and descriptor bind a challenge to protocol, instance, profile, platform, process and readiness state; shutdown signs a distinct action and rejects replay/expired requests. A port collision is a failure, never evidence of a usable backend. Shutdown rejects new work before awaited app/runtime/tool/store closure. Failed/hanging close retains ownership until explicit process exit; no uncertain shell action is replayed. Source locks cannot identify idle pre-M16 backends, so migration requires stopping those processes first. SQLite locks require reliable local filesystem locking. Existing browser origin controls and unsandboxed same-user shell limits remain; lifecycle authentication does not provide M17's future OS boundary. See setup/API docs for operational controls and exact wire formats.

## M18 privileged helper boundary

The trusted non-root backend has an explicit versioned Unix client to a separately provisioned root service. M18 implements structured apt previews, single-use decisions, exact-state revalidation, durable outcomes and administrator setup/repair/uninstall entrypoints. It introduces no renderer/model install action or policy UI. Runtime/code trust starts at a verified administrator-staged artifact and a static native launcher, never user-writable Node or Python modules. Agent namespaces and file tools cannot reach helper credentials, audit or socket. See [helper architecture and operating limits](helper.md) and [wire contract](api-contract.md#m18-trusted-package-helper). M19 policy and M20 desktop provisioning remain separate milestones.
