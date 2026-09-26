# Integration contract

Types in shared/types.ts are the integration boundary. All JSON API failures return `{ error: string }`. IDs are opaque strings. Times are ISO strings. Project paths are backend filesystem paths (Linux paths when running in WSL). API routes use /api. Vite proxies that prefix in development; production serves the built UI from the same origin.

## HTTP interface (coordinator implements)

- GET /api/settings -> PublicSettings (never credentials)
- GET /api/models -> { models: string[] }
- GET /api/projects -> Project[]
- POST /api/projects { name, path?, mode: 'create' | 'import' } -> Project; create without path allocates a new unique folder inside the configured workspace. Import requires a selected absolute directory path.
- GET /api/workspace -> WorkspaceSettings { workspaceRoot, defaultWorkspaceRoot }; default is ~/React Harness Projects or HARNESS_WORKSPACE_ROOT.
- PATCH /api/workspace { workspaceRoot } -> WorkspaceSettings; persist the absolute default folder for future projects without moving existing projects.
- GET /api/directories?path= -> DirectoryListing { path, parentPath, entries:[{name,path}], roots:[{name,path}], truncated }; browse backend directories for import or workspace selection. Default path is the backend user's home. Entries are folders, sorted by name, excluding hidden folders; root shortcuts include Home, Workspace, and available drive/filesystem roots.
- GET /api/projects/:id/chats -> Chat[]
- POST /api/projects/:id/chats { title?, approvalMode? } -> Chat
- GET /api/chats/:id -> ChatDetail
- PATCH /api/chats/:id { title?, approvalMode? } -> Chat
- POST /api/chats/:id/messages { content } -> { accepted: true }; running chat messages are steering. /plan plans without tool mutations; /btw steers.
- POST /api/chats/:id/control { action: 'pause' | 'resume' | 'interrupt' } -> { ok: true }
- POST /api/approvals/:id { decision: 'approve' | 'deny' } -> { ok: true }
- GET /api/chats/:id/events?after=0 -> SSE with id, event=type, data=JSON. Events include message, status, delta, plan, approval, tool, tool_output, tests, file_changed, steering, error. Reconnect by Last-Event-ID. UI may refetch chat detail on durable events.
- GET /api/projects/:id/files?path= -> FileEntry[] (one directory)
- GET /api/projects/:id/file?path= -> FileSnapshot
- PUT /api/projects/:id/file { path, content, baseHash, owner } -> FileSnapshot; conflict HTTP 409
- POST /api/projects/:id/editor { path, owner, dirty } -> { ok: true }; heartbeat renews dirty lease while open, explicit false releases

## Provider module (M1)

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

server/tools/index.ts exports WorkspaceTools implementing ToolService; constructor may accept optional configuration but must support no args. Dirty leases expire if the browser disappears and are renewed by editor heartbeats. Save from an owner can commit its own dirty buffer; agent writes cannot bypass another owner's lease. All writes compare content hashes, revalidate paths and prevent symlink/path traversal and .git/.env credential access by model tools. Read-only Git operations preserve existing repos. For shell actions, label effect execute and risk elevated unless genuinely enforced otherwise. Do not pretend cwd is a sandbox. Persistent PTY per chat/agent; only sanitized child environment. Optional node-pty dependency, return an actionable explicit unavailable error if unsupported; do not fake shell persistence. Parse JUnit reports into TestReport and return as ToolResult.data.testReport. Bound file/output sizes, timeouts, and command queues.

## UI module (M4)

Own client/** and index.html. Use actual HTTP API, no static fake chat data. Refetch durable state after SSE events; stream deltas separately so incomplete JSON is never shown as successful execution. Chat is central. Monaco editor/diff and test trees are collapsible. Make desktop and narrow layouts usable. Use lucide-react icons. API credentials stay backend-only. Report dependency additions to coordinator rather than altering root package files concurrently.
