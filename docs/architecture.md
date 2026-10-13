# Architecture and implementation plan

## Product direction

Approved extension (2026-10-13, implementation tracked in M12–M15): contextual chat/project deletion with distinct app-only and explicitly confirmed disk deletion; `.env`-backed provider settings with durable per-chat model assignments; a persisted planning-to-execution transition; an on-demand header-accessible plan panel with evidence-linked progress; and turn-local historical errors separated from unresolved current blockers. M12 error handling, M13 removal and M14 provider settings are implemented; M15 remains planned. Preserve the `init_test` advisor-style wording: models recommend actions and the application separately validates and performs them. Keep ordinary text Chat Completions compatible with streaming disabled. See `milestones.md` for exact boundaries and acceptance.

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

`loadBackendConfig` reads the working directory's UTF-8 `.env` with dotenv parsing and overlays the original process environment. It does not inject dotenv values into `process.env`. Externally supplied model/key variables, including empty values, lock those fields against Settings writes. Unsupported custom dotenv path/encoding/override/parser options fail startup explicitly. `ProviderSettingsFile` confines writes to that configured backend file, bounds it to 1 MiB, rejects links/hardlinks/special files, validates complete input and dotenv round trips, preserves unrelated source bytes, and commits through a flushed exclusive temporary file and atomic rename. Stale external edits reject before replacement. Legacy assignments commit first; a failed replacement leaves active configuration and future defaults unchanged. After rename, active configuration/defaults publish synchronously. A failed identity refresh reports that settings are saved and active but requires restart, and latches out further saves rather than adopting external changes.

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
