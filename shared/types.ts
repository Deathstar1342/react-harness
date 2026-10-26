export type AgentRole = 'architect' | 'coder' | 'critic';
export type ApprovalMode = 'autonomous' | 'balanced' | 'review';
export type ChatStatus = 'idle' | 'running' | 'awaiting_approval' | 'paused' | 'interrupted' | 'error';
export interface Project { id: string; name: string; path: string; createdAt: string; removalError?: string }
export interface DeletionPreview { canonicalPath: string; confirmationToken: string; expiresAt: string }
export type ProjectRemoval = { mode: 'app-only' } | { mode: 'disk'; canonicalPath: string; confirmationToken: string };
export interface WorkspaceSettings { transferMode?:'source-code'; workspaceRoot: string; defaultWorkspaceRoot: string }
export interface Preferences { debugMode: boolean; defaultApprovalMode: ApprovalMode }
export interface ConnectionCheck { evidence?: 'ordinary'|'native'|'streaming'; model?:string; requestId?:string; target: 'catalog' | AgentRole; status: 'passed' | 'failed' | 'skipped'; message: string }
export interface ConnectionReport { catalog?:ModelCatalogEntry[]; ok: boolean; checks: ConnectionCheck[]; completedAt: string }
export interface DirectoryListing { path: string; parentPath: string | null; entries: {name:string;path:string}[]; roots: {name:string;path:string}[]; truncated: boolean }
export type RoleModels = Record<AgentRole, string>;
export interface ProviderSettings { models: RoleModels; apiKeyConfigured: boolean; lockedFields: string[]; baseUrl?:string }
export interface ProviderSettingsPatch { models?: Partial<RoleModels>; apiKey?: string; baseUrl?:string }
export type ChatMode = 'plan' | 'execute';
export interface Chat { mode?: ChatMode; modeVersion?: number; id: string; projectId: string; title: string; status: ChatStatus; approvalMode: ApprovalMode; createdAt: string; updatedAt: string; models?: RoleModels }
export interface Message { id: string; chatId: string; role: 'user' | AgentRole | 'tool' | 'system'; content: string; createdAt: string; metadata?: Record<string, unknown> }
export interface PlanStepRef { planId: string; planVersion: number; phaseId: string; stepId: string }
export interface PlanEvidence { eventId: number; delegationId: string; outcome: string; summary: string; sourceEventId?: number }
export interface PlanStep { evidence?: PlanEvidence; id: string; title: string; status: 'pending' | 'in_progress' | 'done' | 'blocked' }
export interface PlanPhase { id: string; title: string; steps: PlanStep[] }
export interface Plan { id?: string; version?: number; phases: PlanPhase[] }
export type GoalStatus = 'running' | 'waiting_for_approval' | 'waiting_for_user' | 'paused' | 'blocked' | 'completed';
export interface GoalRef { goalId: string; goalRevision: number; criterionIds: string[] }
export interface GoalCriterion { id: string; text: string; evidenceKind: 'workspace' | 'observation' }
export interface GoalStep { phaseId: string; phaseTitle: string; stepId: string; title: string }
export interface GoalRevision { revision: number; objective: string; criteria: GoalCriterion[]; requiredSteps: GoalStep[]; humanMessageId: string; reason: string; verificationBlockers?: string[] }
export interface GoalReview { eventId: number; delegationId: string; criterionIds: string[]; planStep: PlanStepRef; evidenceEventIds: number[] }
export interface Goal extends GoalRevision {
  id: string; status: GoalStatus; reason: string; generation: number; createdAt: string; updatedAt: string;
  superseded: GoalRevision[]; reviews: GoalReview[]; uncertainEventIds: number[]; uncertaintyOverflow?: boolean; evidenceOverflow?: boolean; verificationBlockers: string[];
  resolvedUncertainties?: {eventId:number;installId:string;reconciliationEventId:number}[];
  budget: { turns: number; transitions: number; unchangedTurns: number; maxTurns: number; maxTransitions: number; maxUnchangedTurns: number };
  completion?: { eventId: number; planId: string; planVersion: number; reviewEventIds: number[] };
}
export interface Action { name: string; args: Record<string, unknown> }
export interface SkillEntry {scope:'project'|'personal';name:string;description:string;references:string[];shadowed?:boolean;revision?:string;hash?:string}
export interface SkillCatalog {entries:SkillEntry[];diagnostics:{scope:'project'|'personal';entry:string;message:string}[]}
export interface SkillDocument extends SkillEntry {content:string;hash:string;revision:string;resources:{path:string;content:string;hash:string}[]}
export interface SkillSelectionView {revision:number;stale?:string;entries:SkillEntry[]}
export interface SkillDraft {name:string;content:string;revision:number;source:'human'|'model';taskId?:string;createdAt:string}
export interface SkillWritePreview {id:string;scope:'project'|'personal';name:string;destination:string;diff:string;expiresAt:number}
export interface NativeToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface NativeToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type ModelMessage = { role: 'system' | 'user'; content: string } |
  { role: 'assistant'; content: string; tool_calls?: NativeToolCall[] } |
  { role: 'tool'; tool_call_id: string; content: string };
export interface ModelCatalogEntry { id: string; metadata: Record<string, unknown>; capabilities: { ordinary: 'unknown'; native: 'unknown'; streaming: 'unknown' } }
export interface ModelUsage { inputTokens: number; outputTokens: number }
export interface CompletionResult { text: string; toolCalls?: NativeToolCall[]; usage?: ModelUsage; finishReason?: string; requestId?: string }
export interface ModelProvider { complete(input: { model: string; messages: ModelMessage[]; tools?: NativeToolDefinition[]; toolChoice?: 'auto' | 'required' | 'none'; streaming?: boolean; signal?: AbortSignal; onDelta?: (delta: string) => void; maxTokens?: number; noRetry?: boolean }): Promise<CompletionResult>; models(signal?: AbortSignal): Promise<string[]>; catalog?(signal?: AbortSignal): Promise<ModelCatalogEntry[]> }
export interface FileEntry { path: string; name: string; type: 'file' | 'directory'; size?: number }
export interface FileSnapshot { path: string; content: string; hash: string | null }
export type FileChangeStatus = 'recording' | 'confirmed' | 'rejected' | 'unknown' | 'undoing' | 'undone';
export interface FileChange { source?:'agent'|'checkpoint';restoreId?:string; id: string; projectId: string; chatId: string; path: string; createdAt: string; status: FileChangeStatus; before: FileSnapshot; after: FileSnapshot; destination?: {before: FileSnapshot; after: FileSnapshot} }
export type FileChangeSummary = Omit<FileChange, 'before' | 'after' | 'destination'> & {destinationPath?: string};
export interface ProjectChanges { git: { status: string; path: string; originalPath?: string }[]; gitError?: string; history: FileChangeSummary[]; historyTruncated: boolean }
export interface ChangePreview { change: FileChangeSummary; diff: string; undoDiff: string; expectedHash: string | null; previewToken?: string; reason?: string }
export interface WorkerDispatchBinding {claimId:string;binding:string;sessionId:string;identity:{storageId:string;projectId:string;imageId:string;layout:string};expiresAt:number}
export interface ToolContext {
  projectRoot: string; chatId: string; agentId: string; signal?: AbortSignal; onOutput?: (output: string) => void;
  /** Trusted in-memory capabilities; never serialized or accepted as native arguments. */
  previewPort?:number;
  mutationOwner?: symbol; prepareCommand?: () => Promise<void>; beforeCommand?: (binding?:WorkerDispatchBinding) => void;
}
export interface ProcessJob {
  id:string; projectId:string; chatId:string; frameId:string; callId:string; commandId:string;
  status:'starting'|'running'|'completed'|'failed'|'not_started'|'interrupted'|'uncertain';
  createdAt:string; updatedAt:string; output:string; baseOffset:number; endOffset:number; truncated:boolean;
  exitCode?:number; message?:string;
}
/** Preview observations cannot authorize execution, acceptance or reconciliation. */
export interface PreviewEntry {processId:string;projectId:string;chatId:string;generation:number;port:number;status:'starting'|'ready'|'stopped'|'failed'|'interrupted'|'uncertain'|'stale';reason:string}
export interface PreviewSession {id:string;projectId:string;processId:string;chatId:string;generation:number;expiresAt:number}
export interface ToolInspection { effect: 'read' | 'write' | 'execute'; risk: 'routine' | 'elevated'; description: string; path?: string; before?: string; after?: string; diff?: string; changes?: {before: FileSnapshot; after: FileSnapshot}[] }
export interface ToolResult { ok: boolean; output: string; data?: unknown }
export interface TestCase { name: string; classname?: string; status: 'passed' | 'failed' | 'skipped' | 'error'; duration?: number; error?: string; output?: string }
export interface TestReport { id: string; runner: string; command: string; createdAt: string; status: 'passed' | 'failed' | 'error' | 'cancelled'; tests: TestCase[]; output: string; exitCode?: number }
export interface ToolService {
  readonly processLifecycle?: 'sandbox-dispatch-v1';
  configureMutationGuard?(guard:(root:string, owner?:symbol)=>void):void;
  closeCommandContext?(context:ToolContext):Promise<void>;
  /** Trusted backend-only policy, never accepted from model/browser input. */
  configureSandbox?(policy:{home:string;protectedPaths:string[];projects:()=>string[]}):void;
  resetSandbox?(root:string):Promise<void>;
  inspect(context: ToolContext, action: Action): Promise<ToolInspection>;
  execute(context: ToolContext, action: Action): Promise<ToolResult>;
  read(root: string, path: string): Promise<FileSnapshot>;
  list(root: string, path?: string): Promise<FileEntry[]>;
  save(root: string, path: string, content: string, baseHash: string | null, owner?: string): Promise<FileSnapshot>;
  setDirty(root: string, path: string, owner: string, dirty: boolean): void;
  checkpointScope?<T>(root:string,operation:(access:CheckpointAccess)=>Promise<T>):Promise<T>;
  restore?(root: string, path: string, before: FileSnapshot, expectedHash: string | null, beforeMutation: () => void): Promise<FileSnapshot>;
  restoreMove?(root: string, change: FileChange, beforeMutation: () => void): Promise<void>;
  // Trusted lifecycle boundary; reject active operations/leases, await resource
  // teardown, then revalidate and invoke the mutation synchronously under a gate.
  removeScope?<T>(root: string, chatId: string | undefined, mutation: () => T): T | Promise<T>;
  dispose(): Promise<void>;
}
export interface Approval { id: string; chatId: string; agentId: string; action: Action; inspection: ToolInspection; status: 'pending' | 'approved' | 'denied' | 'stale'; createdAt: string; install?: InstallRecord }
export interface RunEvent { id: number; chatId: string; type: string; data: unknown; createdAt: string }
export interface CommandEvent {
  processId?:string;
  commandId: string; agentId: string; sessionId: string; role: AgentRole; action: Action;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'uncertain' | 'not_started';
  output?: string; exitCode?: number; cancelled?: boolean; timedOut?: boolean;
  shellReset?: boolean; truncated?: boolean; message?: string;
}
export interface CommandOutput { agentId: string; commandId?: string; sessionId?: string; output: string; truncated?: boolean }
export interface ChatDetail { chat: Chat; messages: Message[]; plan: Plan; goal?: Goal; approvals: Approval[]; events: RunEvent[]; eventsTruncated?: boolean; tests: TestReport[] }
/** Observations only. Neither revision nor destinations authorize execution. */
export type RecoveryStatus = 'completed'|'failed'|'not_started'|'running'|'uncertain'|'interrupted'|'unknown';
export type RecoveryDestination = 'controls'|'approvals'|'terminal'|'installs'|'plan';
export interface RecoveryEntry {
  id:string; kind:'command'|'tool'|'process'|'install'|'plan'|'unknown'; label:string; status:RecoveryStatus;
  reason:string; updatedAt:string|null; frameId?:string; commandId?:string; callId?:string; processId?:string; installId?:string;
  generation?:number; planStep?:PlanStepRef; destination:RecoveryDestination;
  evidence:{eventId:number;at:string|null}[]; evidenceTruncated:boolean;
  outputTruncated?:boolean;
}
export interface RecoveryView {
  schema:'recovery-v1'; chatId:string; projectId:string; observedAt:string; revision:string; latestEventId:number;
  chat:{status:ChatStatus|'unknown';mode:ChatMode|'unknown';modeVersion:number|null;updatedAt:string|null};
  goal?:{id:string;revision:number;status:GoalStatus;humanMessageId:string|null;updatedAt:string|null;uncertainEventIds:number[];truncated:boolean;eventId:number|null};
  plan?:{id:string;version:number}; humanMessageIds:string[];
  entries:RecoveryEntry[];
  coverage:{source:string;limit:number;truncated:boolean;unavailable:number}[];
}
export interface PublicSettings { executionMode?:'direct'|'container'; executionAvailable?:boolean; limitSource?:'application-budget'; providerLimits?:'unknown'; configured: boolean; models: Record<AgentRole, string>; approvalMode: ApprovalMode; maxParallelCoders: number; platform: string; protocol: string; limits: { requestsPerMinute: number; tokensPerMinute: number; tokensPerDay: number }; contextLimits: Record<AgentRole, number> }
/** Private launcher protocol; keys and provider secrets are never included. */
export interface BackendIdentity { protocol:'abyssus-backend-v1'; instanceId:string; profileId:string; pid:number; platform:string; state:'starting'|'ready'|'stopping'|'stopped'|'failed' }
export interface BackendProofRequest { instanceId:string; nonce:string; expiresAt:number; mac:string }
export interface BackendProof { action:'readiness'|'shutdown'; identity:BackendIdentity; nonce:string; mac:string }
// M18 trusted backend/helper DTOs. These are not model actions or HTTP routes.
export interface LocalPackageTarget {scope?:undefined; id:string; installationId:string; machineId:string; distribution:'ubuntu'|'debian'; release:string; architecture:'amd64'; manager:'apt'; adapterVersion:1 }
export interface ContainerPackageTarget {scope:'project-container';id:string;storageId:string;projectId:string;baseImageId:string;generation:string;distribution:'debian';release:'12';architecture:'amd64';manager:'apt';adapterVersion:1}
export type PackageHelperTarget=LocalPackageTarget|ContainerPackageTarget;
export interface PackageHelperRequest { requestId:string; targetId:string; manager:'apt'; packages:{name:string;version?:string}[] }
export interface PackageHelperDecision { requestId:string; previewDigest:string; decisionNonce:string; expiresAt:number }
export interface PackageHelperPreview {
  target:PackageHelperTarget;
  packages:{name:string;version:string;architecture:string;sha256:string;downloadBytes:number;installedBytes:number;requested:boolean;uris:string[];repositories:{origin:string;label:string;archive:string;component:string;site:string;trusted:boolean}[]}[];
  stateDigest:string; repositoryDigest:string;
  impact:{newPackages:number;downloadBytes:number;installedBytes:number;removals:0;upgrades:0;downgrades:0;maintainerScripts:'trusted-package-root-execution';triggers:'may-modify-existing-packages-and-services';serviceChanges:'package-defined'};
}
export interface ContainerInstallReceipt {targetId:string;baseImageId:string;imageId:string;generation:string;manifestDigest:string}
export interface PackageHelperRecord {
  containerReceipt?:ContainerInstallReceipt;
  requestId:string;request:PackageHelperRequest;preview:PackageHelperPreview;previewDigest:string;
  state:'prepared'|'noop'|'authorized'|'running'|'succeeded'|'failed'|'uncertain';
  createdAt:number;updatedAt:number;expiresAt:number;code:string;decision?:PackageHelperDecision;
  reconciliation?:{matches:boolean;healthy:boolean;packages:{name:string;expectedVersion:string;installedVersion:string|null}[]};
}
export type InstallPolicy = 'ask' | 'auto' | 'ai';
export interface InstallSettings { policy: InstallPolicy; reviewerModel: string; revision: number; target?: PackageHelperTarget }
export interface InstallSettingsView extends InstallSettings { available: boolean; message: string; scope: 'current-profile-local-linux-target'|'project-execution-container' }
export type InstallState = 'preparing' | 'reviewing' | 'pending' | 'approved' | 'authorizing' | 'dispatching' | 'succeeded' | 'failed' | 'noop' | 'rejected' | 'stale' | 'uncertain';
/** Public evidence only. Helper authorization nonce/descriptor never belong here. */
export interface InstallRecord {
  containerReceipt?:ContainerInstallReceipt;
  id: string; chatId: string; projectId: string; frameId: string; role: AgentRole; generation: number; modeVersion: number;
  recommendation: { packages: {name:string;version?:string}[]; reason: string };
  settings: InstallSettings; state: InstallState; createdAt: number; updatedAt: number;
  preview?: PackageHelperPreview; previewDigest?: string; expiresAt?: number;
  decision?: { source: 'human'|'auto'|'ai'; outcome: 'approve'|'reject'|'ask'; reason: string; at: number };
  code: string; recoveryRequired: boolean; reconciliation?: PackageHelperRecord['reconciliation'];
}

/** Sanitized receipt; original host source/destination paths never cross this boundary. */
export interface ProjectTransferReceipt {
  id:string;kind:'import'|'export';project:string;phase:'copying'|'publishing'|'succeeded'|'failed'|'cancelled'|'uncertain';
  code:string;residue:boolean;manifestDigest:string;files:number;bytes:number;excludedCount:number;
  excluded:{path:string;reason:string}[];history:boolean;storageId:string;sessionId:string;identity:[string,string]|null;
}
/** M31 supplies the native host runtime; the current source adapter uses terminal-issued codes. */
export interface HostProjectTransferPicker {
  authorizeImport():Promise<{code:string}|null>;
  authorizeExport(managedFolder:string):Promise<{code:string}|null>;
}

/** Human-only project file recovery; never a native tool or execution authority. */
export interface CheckpointSummary {id:string;projectId:string;chatId:string;label:string;createdAt:string;digest:string;files:number;bytes:number;excludedCount:number;excluded:{path:string;reason:string}[]}
export interface CheckpointRestoreSummary {id:string;checkpointId:string;createdAt:string;status:'claiming'|'uncertain'|'done';files:number}
export interface CheckpointList {items:CheckpointSummary[];restores:CheckpointRestoreSummary[];limits:{files:number;fileBytes:number;bytes:number;projectCount:number}}
export interface CheckpointPreview {checkpoint:CheckpointSummary;previewToken:string;revision:string;expiresAt:number;changes:{path:string;kind:'add'|'remove'|'modify';diff:string}[];currentExcludedCount:number}
export interface CheckpointAccess {read(root:string,input:string):Promise<FileSnapshot>;restore(root:string,file:FileSnapshot&{mode:number},expected:FileSnapshot,beforeMutation:()=>void):Promise<FileSnapshot>}
