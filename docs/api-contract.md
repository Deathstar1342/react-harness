# Integration contract

Types in shared/types.ts are the integration boundary. All JSON API failures return `{ error: string }`. IDs are opaque strings. Times are ISO strings. Project paths are backend filesystem paths (Linux paths when running in WSL). API routes use /api. Vite proxies that prefix in development; production serves the built UI from the same origin.

## HTTP interface (coordinator implements)

- GET /api/settings -> PublicSettings (never credentials); approvalMode reflects the persisted future-chat default, falling back to backend APPROVAL_MODE.
- GET /api/preferences -> Preferences { debugMode: boolean, defaultApprovalMode: ApprovalMode }; backend-wide durable preferences, Debug defaults to false.
- PATCH /api/preferences { debugMode?, defaultApprovalMode? } -> Preferences; strict partial update, persists only those preferences. Existing chats, pending proposals and workspace settings remain unchanged.
- POST /api/connection-check {} -> ConnectionReport { ok, completedAt, checks: [{target:'catalog'|'architect'|'coder'|'critic', status:'passed'|'failed'|'skipped', message}] }. Uses the configured provider transport and managed account scheduler for completion probes. Report messages are fixed safe text, without raw replies, catalog contents, URLs, credentials or parser exceptions. A failed check returns HTTP 200 with ok:false; a concurrent check returns 409, shutdown rejects new checks with 503. Requires an empty JSON object and the existing local-origin policy.
- GET /api/models -> { models: string[] }
- GET /api/projects -> Project[]
- POST /api/projects { name, path?, mode: 'create' | 'import' } -> Project; create without path allocates a new unique folder inside the configured workspace. Import requires a selected absolute directory path.
- GET /api/workspace -> WorkspaceSettings { workspaceRoot, defaultWorkspaceRoot }; default is ~/React Harness Projects or HARNESS_WORKSPACE_ROOT.
- PATCH /api/workspace { workspaceRoot } -> WorkspaceSettings; persist the absolute default folder for future projects without moving existing projects.
- GET /api/directories?path= -> DirectoryListing { path, parentPath, entries:[{name,path}], roots:[{name,path}], truncated }; browse backend directories for import or workspace selection. Default path is the backend user's home. Entries are folders, sorted by name, excluding hidden folders; root shortcuts include Home, Workspace, and available drive/filesystem roots.
- GET /api/projects/:id/chats -> Chat[]
- POST /api/projects/:id/chats { title?, approvalMode? } -> Chat; omitted approvalMode uses the persisted future-chat default at creation time.
- GET /api/chats/:id -> ChatDetail
- PATCH /api/chats/:id { title?, approvalMode? } -> Chat; a different approvalMode returns 409 while running, awaiting approval, or holding any pending proposal. Pause/resolve work first. A policy change never starts/resumes a run, decides a proposal, changes another chat, or changes the future-chat default.
- POST /api/chats/:id/messages { content } -> { accepted: true }; running chat messages are steering. /plan plans without tool mutations; /btw steers.
- POST /api/chats/:id/control { action: 'pause' | 'resume' | 'interrupt' } -> { ok: true }
- POST /api/approvals/:id { decision: 'approve' | 'deny' } -> { ok: true }
- GET /api/chats/:id/events?after=0 -> SSE with id, event=type, data=JSON. Events include message, status, delta, plan, approval, tool, tool_output, tests, file_changed, steering, error. Reconnect by Last-Event-ID. UI may refetch chat detail on durable events.
- GET /api/projects/:id/files?path= -> FileEntry[] (one directory)
- GET /api/projects/:id/file?path= -> FileSnapshot
- PUT /api/projects/:id/file { path, content, baseHash, owner } -> FileSnapshot; conflict HTTP 409
- POST /api/projects/:id/editor { path, owner, dirty } -> { ok: true }; heartbeat renews dirty lease while open, explicit false releases

## Provider module (M1)

### Connection diagnostics (M8)

One diagnostic can run per backend. Its 25-second total deadline includes catalog retrieval, scheduler queue waits and all three serial role probes; the browser uses a 30-second upper bound and exposes Cancel check. Disconnect, Settings close and backend shutdown cancel outstanding work. Unattempted roles are reported as skipped (shown as "not checked"). No automatic retries are added; the production provider already has internal retries disabled.

The catalog must contain each exact configured model ID. Available roles each receive a small ordinary text request for the version-1 final envelope with the fixed message `Connection OK`, capped at min(1024, configured max output tokens). Diagnostics uses the configured streaming behavior; it does not send native tools or response_format. Normal scheduler estimates/reported usage and conservative uncertain charges apply, including failed/aborted probes. Catalog access is one bounded GET, not a token-bearing completion reservation. Small context/account budgets may reject the test before transport.

Only complete, strict final replies with the expected message pass; actions, refusals, wrong envelopes, malformed/oversized replies and incomplete finishes fail. Completed text is limited to 2048 characters for diagnostic parsing; existing provider byte/stream bounds apply before it. There is no tool/runtime execution path and no project/chat context or durable model transcript for a probe. Budget, authentication, throttling, refusal, timeout, truncation/output limit and invalid-reply failures have sanitized explanations. Passing diagnostics verifies this small probe, not general task quality or full live-provider acceptance.

server/provider.ts exports StarkProvider implementing ModelProvider. Constructor accepts `{ baseUrl: string, apiKey: string, streaming?: boolean, timeoutMs?: number }`. No server config import. server/protocol.ts exports parseAgentResponse(text): AgentResponse; invalid, partial, unknown actions, or malformed arguments throw descriptive errors. Export protocolInstructions(role) with role-specific JSON output instructions. No tools or response_format in provider requests. Use fetch and AbortSignal. Tests use local fake HTTP servers.

Response envelope: `{ version: 1, type: 'action', message: 'Reading the file.', action: { name: 'read_file', args: { path: 'README.md' } } }`. A final/message envelope has no action. Schemas must be bounded and strict. Tool response data is supplied as ordinary user messages clearly identified as tool results.

Tool action argument contracts:

- list_files: { path?: string }
- read_file: { path: string }
- search: { query: string, path?: string }
- write_file: { path: string, content: string, baseHash: string | null } (null only for new files)
- run_shell: { command: string, timeoutMs?: number }
- execute_python: { code: string, timeoutMs?: number }
- git_status: {}
- git_diff: { path?: string }
- run_tests: { command: string, reportPath?: string, timeoutMs?: number }
- set_plan: { phases: PlanPhase[] }
- delegate: { objective: string, acceptanceCriteria: string[], paths?: string[] }
- review: { focus: string }
- ask_user: { question: string }
- review_result: { verdict: 'pass' | 'changes_requested', findings: string[] }

set_plan/delegate/review/ask_user/review_result are runtime actions, not workspace tool actions. Restrict delegate to architect, avoid recursive delegation. Critic only gets read tools and concludes with review_result; runtime enforces it. Bound repair cycles.

SSE payloads: delta {role, text} signals provisional model activity; text may be empty and is never an executable or completed action; tool_output {agentId, output}; steering {content, delivered}; file_changed {path, source:'agent'|'editor'|'external'}. Message/status/plan/approval/tests carry their shared type directly. tool carries {agentId,action,result?}; error carries {message}. Editor owner is a stable per-tab random UUID.

## Workspace module (M3)

### Root project instructions (M9)

`server/project-instructions.ts` exports `readProjectInstructions(tools, root)`, `ProjectInstructionsError`, `PROJECT_INSTRUCTIONS_LIMIT` (32,000 UTF-8 bytes), and a fixed instruction-priority statement. Reads use `ToolService.read(root, 'AGENTS.md')`, preserving existing confined-path, link/type, encoding and bounded-read checks. The loader additionally checks the returned path, content bound, UTF-8 round trip, NUL exclusion, and SHA-256 consistency. Missing is `{content:'',hash:null}`; empty present files have a SHA-256 hash. All invalid/read-error cases fail closed with fixed actionable text rather than exposing underlying errors or file contents. No nested discovery or truncation.

Internal additive persisted JSON fields: `RunState.instructionsHash?: string|null` and `PendingAction.instructionsHash?: string|null`. `undefined` means not validated (including older stored runs); `null` means observed absent; a string identifies the observed content. A prepared action is stamped with the snapshot that produced its request. Changed guidance or unvalidated legacy prepared actions invalidate pending/approved-but-unexecuted approvals and discard prepared actions across the run's frames. Invalid guidance also clears the run fingerprint so repairing to previous bytes still requires reconsideration. Existing executing/done actions retain their uncertain/recorded results, even when guidance is invalid. Completed approval history is preserved. No SQLite schema, public shared type, tool permission, or dependency change.

Every normal architect/coder/critic request gets a separate fresh guidance prefix; it is not appended to durable frame history or compacted into a summary. The fixed system policy explains that enforced runtime controls/protocol and explicit human requests outrank repository guidance, while the fresh snapshot supersedes conflicting historical project guidance. Project text cannot change parser/permissions/approvals. Context preparation accounts for this prefix and preserves it; original transcripts remain archived by the existing context hooks. Summary-only control calls summarize untrusted historical data and have no action execution path.

Freshness reads occur at loop/request boundaries (also after context preparation and before formatting retries), after provider completions, after tool inspection, during approval decisions, and at final dispatch after approval reinspection. Content changes increment the run generation; in-flight responses from the old generation are discarded before acceptance. Watcher events remain supplemental. POST `/api/approvals/:id` can return 409 when project guidance supersedes the proposal or cannot be safely read; changed awaiting runs refresh their proposals, while invalid files put the run in error until repaired and explicitly resumed. Paused tasks remain paused until resumed.

There is no atomic lock against external editors: changes after the final filesystem read or changes reverted between reads cannot be guaranteed detectable before dispatch. Running tool actions retain their outcomes and are not rolled back. Prompt hierarchy is model guidance, not proof of semantic compliance; runtime authorization and tool safety checks remain independent.

server/tools/index.ts exports WorkspaceTools implementing ToolService; constructor may accept optional configuration but must support no args. Dirty leases expire if the browser disappears and are renewed by editor heartbeats. Save from an owner can commit its own dirty buffer; agent writes cannot bypass another owner's lease. All writes compare content hashes, revalidate paths and prevent symlink/path traversal and .git/.env credential access by model tools. Read-only Git operations preserve existing repos. For shell actions, label effect execute and risk elevated unless genuinely enforced otherwise. Do not pretend cwd is a sandbox. Persistent PTY per chat/agent; only sanitized child environment. Optional node-pty dependency, return an actionable explicit unavailable error if unsupported; do not fake shell persistence. Parse JUnit reports into TestReport and return as ToolResult.data.testReport. Bound file/output sizes, timeouts, and command queues.

## UI module (M4)

Own client/** and index.html. Use actual HTTP API, no static fake chat data. Refetch durable state after SSE events; stream deltas separately so incomplete JSON is never shown as successful execution. Chat is central. Monaco editor/diff and test trees are collapsible. Make desktop and narrow layouts usable. Use lucide-react icons. API credentials stay backend-only. Report dependency additions to coordinator rather than altering root package files concurrently.

M8 Settings saves current-chat approval separately from the future-chat default and Debug preference. Preference controls save immediately; workspace folder changes retain their explicit Save workspace button. Debug is backend-persisted, false by default, and does not affect model context or execution. The default conversation shows user/architect/system messages and failed tool results; successful tool messages, coder/critic messages and the Activity trace tab appear with Debug enabled. Runtime/tool errors remain visible independently, and approvals with exact diffs plus structured test results remain usable in both views. Tests with failures/errors/cancellation show a review indicator while the drawer is collapsed. Editor buffers, leases and resize/expand state are not remounted when changing Debug.

## Changes review and undo (M10)

- GET `/api/projects/:id/changes` -> `ProjectChanges`: `git` status entries (`status`, `path`, optional `originalPath`), optional `gitError`, `history` summaries, `historyTruncated`. History is latest 100 entries, without content snapshots; all write attempts are labelled by status. Git status includes all untracked file paths rather than collapsed directories, bounded by the existing 1 MB Git output limit. Errors are explicit; incomplete Git status is not returned as complete.
- GET `/api/projects/:id/diff?path=...` -> `{diff}`: current staged/unstaged Git diff, or an untracked text-file diff against absence. Renames include both original and destination paths. Literal Git pathspecs and protected path/link checks apply. A stale/nonlisted path returns 409; unavailable/oversized diff returns an error. No Git index mutations.
- GET `/api/projects/:id/change/:changeId` -> `ChangePreview`: change summary, recorded `diff`, reverse `undoDiff`, current `expectedHash`, optional `previewToken` or blocking `reason`. Tokens are opaque server-issued values bound to project, change and exact current snapshot, expire after five minutes, and are held only in memory (maximum 200). Restart or eviction requires a fresh preview. Recorded snapshot differences require total input/output <=200,000 UTF-8 bytes, with a one-second diff computation budget; oversized/unsupported previews have no token. A token does not promise runtime/lease availability at execution time.
- POST `/api/projects/:id/change/:changeId/undo` with strictly `{expectedHash: SHA256, previewToken: UUID}` -> `{ok:true}`. No client replacement content is accepted. Requires confirmed state, matching token/hash, no active runtime promise and no running/awaiting-approval chat anywhere in the project. Explicitly pause work first; the endpoint never interrupts it. Missing/wrong-project records return 404, stale tokens/versions and busy/dirty conditions return 409. Existing local-origin/JSON restrictions apply.

Additive SQLite `file_changes` stores unique action ID, project ID, status, bounded summary metadata and full before/after snapshots (each within the file-tool 2 MB limit). `recording` plus execution intent are persisted together before tool execution. A matching successful path/hash result promotes to `confirmed` together with durable action `done`; failures known to precede target mutation are `rejected`, other outcomes `unknown`. Old executing/done actions have no fabricated history. Restart maps `recording`/`undoing` to `unknown` and never replays them. History is not automatically pruned.

Optional trusted `ToolService.restore(root,path,before,expectedHash,beforeMutation)` restores previous content or removes one new file. It is never a model tool. It shares ordinary save locks and performs path, regular-file/link, hash and editor-lease checks. The synchronous callback runs after final safe preconditions and before rename/unlink; it atomically claims `confirmed -> undoing`. Rejected preconditions leave both record and token reusable. Failure after the claim is uncertain and non-replayable even if a mutation cannot be proven; success becomes `undone`. Duplicate requests/tokens cannot claim twice. The runtime holds a project guard across the whole operation and releases it in `finally`; submit/resume/approval and automatic launches respect this guard. Running promises remain authoritative during cancellation.

Successful and uncertain undo outcomes broadcast `file_changed` with `source:'undo'` to all project chats and invalidate prepared approvals through the existing runtime steering path; successful notifications include the restored hash or null for deletion. Executing/done recovery evidence is preserved. M9 guidance is revalidated after the new pre-execution snapshot read. Root AGENTS.md undo also triggers ordinary guidance freshness checks on resume.

Project Git changes have unknown attribution (pre-existing/manual/shell/agent); recorded write history is separate. No Git reset, arbitrary shell undo, whole-task rollback or retroactive snapshots. Exact content checks cannot detect changes reverted to identical bytes or exclude external filesystem races after the final check; the guard and leases coordinate one backend instance, not arbitrary external writers. Preview UI preserves the mounted editor and exposes omitted history or unavailable diffs explicitly.
