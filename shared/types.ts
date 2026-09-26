export type AgentRole = 'architect' | 'coder' | 'critic';
export type ApprovalMode = 'autonomous' | 'balanced' | 'review';
export type ChatStatus = 'idle' | 'running' | 'awaiting_approval' | 'paused' | 'interrupted' | 'error';
export interface Project { id: string; name: string; path: string; createdAt: string }
export interface WorkspaceSettings { workspaceRoot: string; defaultWorkspaceRoot: string }
export interface DirectoryListing { path: string; parentPath: string | null; entries: {name:string;path:string}[]; roots: {name:string;path:string}[]; truncated: boolean }
export interface Chat { id: string; projectId: string; title: string; status: ChatStatus; approvalMode: ApprovalMode; createdAt: string; updatedAt: string }
export interface Message { id: string; chatId: string; role: 'user' | AgentRole | 'tool' | 'system'; content: string; createdAt: string; metadata?: Record<string, unknown> }
export interface PlanStep { id: string; title: string; status: 'pending' | 'in_progress' | 'done' | 'blocked' }
export interface PlanPhase { id: string; title: string; steps: PlanStep[] }
export interface Plan { phases: PlanPhase[] }
export interface Action { name: string; args: Record<string, unknown> }
export interface AgentResponse { version: 1; type: 'message' | 'action' | 'final'; message: string; action?: Action }
export interface ModelMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ModelUsage { inputTokens: number; outputTokens: number }
export interface CompletionResult { text: string; usage?: ModelUsage; finishReason?: string }
export interface ModelProvider { complete(input: { model: string; messages: ModelMessage[]; signal?: AbortSignal; onDelta?: (delta: string) => void; maxTokens?: number }): Promise<CompletionResult>; models(signal?: AbortSignal): Promise<string[]> }
export interface FileEntry { path: string; name: string; type: 'file' | 'directory'; size?: number }
export interface FileSnapshot { path: string; content: string; hash: string | null }
export interface ToolContext { projectRoot: string; chatId: string; agentId: string; signal?: AbortSignal; onOutput?: (output: string) => void }
export interface ToolInspection { effect: 'read' | 'write' | 'execute'; risk: 'routine' | 'elevated'; description: string; path?: string; before?: string; after?: string; diff?: string }
export interface ToolResult { ok: boolean; output: string; data?: unknown }
export interface TestCase { name: string; classname?: string; status: 'passed' | 'failed' | 'skipped' | 'error'; duration?: number; error?: string; output?: string }
export interface TestReport { id: string; runner: string; command: string; createdAt: string; status: 'passed' | 'failed' | 'error' | 'cancelled'; tests: TestCase[]; output: string; exitCode?: number }
export interface ToolService {
  inspect(context: ToolContext, action: Action): Promise<ToolInspection>;
  execute(context: ToolContext, action: Action): Promise<ToolResult>;
  read(root: string, path: string): Promise<FileSnapshot>;
  list(root: string, path?: string): Promise<FileEntry[]>;
  save(root: string, path: string, content: string, baseHash: string | null, owner?: string): Promise<FileSnapshot>;
  setDirty(root: string, path: string, owner: string, dirty: boolean): void;
  dispose(): Promise<void>;
}
export interface Approval { id: string; chatId: string; agentId: string; action: Action; inspection: ToolInspection; status: 'pending' | 'approved' | 'denied' | 'stale'; createdAt: string }
export interface RunEvent { id: number; chatId: string; type: string; data: unknown; createdAt: string }
export interface ChatDetail { chat: Chat; messages: Message[]; plan: Plan; approvals: Approval[]; events: RunEvent[]; tests: TestReport[] }
export interface PublicSettings { configured: boolean; models: Record<AgentRole, string>; approvalMode: ApprovalMode; maxParallelCoders: number; platform: string; protocol: string; limits: { requestsPerMinute: number; tokensPerMinute: number; tokensPerDay: number }; contextLimits: Record<AgentRole, number> }
