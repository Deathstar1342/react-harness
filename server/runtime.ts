import { randomUUID } from 'node:crypto';
import { commandEvent, isCommand } from './command-events.js';
import type { Action, NativeToolCall, AgentRole, Approval, CompletionResult, ModelMessage, ModelProvider, ToolContext, ToolResult, ToolService, PlanStepRef } from '../shared/types.js';
import type { Config } from './config.js';
import { Store } from './store.js';
import { ProjectInstructionsError, projectInstructionsPolicy, readProjectInstructions } from './project-instructions.js';
import { hash } from './tools/paths.js';
import { definitionFor, parseToolArguments, publishedTools, validateAction, validateToolResult } from './tool-registry.js';
import { validateNativeCalls, validateNativeHistory } from './provider.js';
import type { InstallService } from './installs.js';

interface PendingAction { callId?: string; id: string; action: Action; approvalId?: string; stage: 'prepared' | 'executing' | 'done'; result?: ToolResult; instructionsHash?: string | null; commandOutcomeRecorded?: boolean }
export interface Frame { proseTurns?:number; queuedCalls?: NativeToolCall[]; evidenceEventIds?: number[]; planStep?: PlanStepRef; reviewDelegationId?: string; id: string; role: AgentRole; messages: ModelMessage[]; objective?: string; pending?: PendingAction; final?: string; repairs: number; failures?: number; scope?: string[]; shellId?: string; reviewKind?: 'completion'|'checkpoint' }
export interface RunState {
  frames: Frame[];
  steering: string[];
  planOnly: boolean;
  steps: number;
  generation: number;
  objective?: string;
  instructionsHash?: string | null;
}
export interface RuntimeHooks {
  instructions(role: AgentRole): string;
  prepareMessages?: (chatId: string, frame: Frame, messages: ModelMessage[], signal: AbortSignal) => Promise<ModelMessage[]>;
  complete?: (role: AgentRole, input: Parameters<ModelProvider['complete']>[0]) => Promise<CompletionResult>;
}

const readTools = new Set(['read_file', 'list_files', 'search', 'git_status', 'git_diff']);
const workspaceTools = new Set([...readTools, 'write_file', 'run_shell', 'execute_python', 'run_tests']);
const safeResult = (error: unknown): ToolResult => ({
  ok: false,
  output: error instanceof Error ? error.message : 'Action failed',
});

export class Runtime {
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private runs = new Map<string, RunState>();
  private projectEdits = new Map<string,'undo'|'removal'>();
  private decisions = new Map<string, number>();

  private assertAvailable(chatId: string) {
    const projectId = this.store.chat(chatId).projectId;
    if (this.store.project(projectId).removalError) throw Object.assign(new Error('Project removal needs recovery before work can resume'),{statusCode:409});
    if (this.projectEdits.has(projectId)) {
      throw Object.assign(
        new Error(`${this.projectEdits.get(projectId)==='undo' ? 'An undo' : 'A removal'} is in progress; wait before starting project work`),
        { statusCode: 409 },
      );
    }
  }

  async exclusiveRemoval<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    this.installs?.expire();
    this.store.assertInstallRemovalSafe(projectId);
    if (this.store.chats(projectId).some(chat => this.decisions.has(chat.id) || this.store.approvals(chat.id).some(a=>a.status==='pending') || this.load(chat.id)?.frames.some(f=>f.pending?.stage==='executing'))) {
      throw Object.assign(new Error('Resolve pending project operations before removal'),{statusCode:409});
    }
    return this.exclusiveProjectEdit(projectId, operation, true);
  }

  forgetChats(chatIds: string[]) { for (const id of chatIds) this.runs.delete(id); }

  async exclusiveProjectEdit<T>(
    projectId: string,
    operation: () => Promise<T>,
    removalRecovery = false,
  ): Promise<T> {
    if (this.store.project(projectId).removalError && !removalRecovery) throw Object.assign(new Error('Project removal needs recovery before work can resume'),{statusCode:409});

    if (
      this.projectEdits.has(projectId) ||
      this.store.chats(projectId).some(chat =>
        this.active.has(chat.id) ||
        ['running', 'awaiting_approval'].includes(chat.status),
      )
    ) {
      throw Object.assign(
        new Error('Pause all active project chats and wait for their actions to stop before changing the project'),
        { statusCode: 409 },
      );
    }

    this.projectEdits.set(projectId,removalRecovery ? 'removal' : 'undo');

    try {
      return await operation();
    } finally {
      this.projectEdits.delete(projectId);
    }
  }

  constructor(
    readonly store: Store,
    readonly provider: ModelProvider,
    readonly tools: ToolService,
    readonly config: Config,
    readonly hooks: RuntimeHooks,
    readonly installs?: InstallService,
  ) { store.initializeModels(config.models); store.initializePlanning(); }

  private load(chatId: string): RunState | null {
    const cached = this.runs.get(chatId);
    if (cached) return cached;

    const saved = this.store.getState<RunState | null>(`run:${chatId}`, null);

    if (saved) {
      saved.planOnly = this.store.chat(chatId).mode === 'plan';
      this.runs.set(chatId, saved);
    }

    return saved;
  }

  private save(chatId: string, state: RunState) {
    this.store.setState(`run:${chatId}`, state);
    for (const frame of state.frames) this.store.setState(`native:frame:${chatId}:${frame.id}`, frame.messages);
  }

  private frame(
    role: AgentRole,
    messages: ModelMessage[],
    objective?: string,
  ): Frame {
    return {
      id: randomUUID(),
      role,
      messages,
      objective,
      repairs: 0,
    };
  }

  async startBuilding(chatId: string, expected: {planId: string; planVersion: number; modeVersion: number}) {
    this.assertAvailable(chatId);
    const chat = this.store.chat(chatId);
    const plan = this.store.plan(chatId);
    const previous = this.store.getState<unknown>(`build:${chatId}`, null);
    if (chat.mode === 'execute' && chat.modeVersion === expected.modeVersion + 1 && JSON.stringify(previous) === JSON.stringify(expected)) return;
    if (chat.mode !== 'plan' || chat.modeVersion !== expected.modeVersion || plan.id !== expected.planId || plan.version !== expected.planVersion || !plan.phases.some(p=>p.steps.length)) {
      throw Object.assign(new Error('The plan or planning session changed; refresh before starting'), {statusCode:409});
    }
    if (this.decisions.has(chatId) || this.load(chatId)?.frames.some(f=>f.pending?.stage === 'executing')) {
      throw Object.assign(new Error('Wait for the current operation to stop before starting'), {statusCode:409});
    }
    this.commitSubmission(chatId, 'Start building', expected);
  }

  async submit(chatId: string, content: string) {
    this.commitSubmission(chatId, content);
  }

  private commitSubmission(chatId: string, content: string, receipt?: {planId: string; planVersion: number; modeVersion: number}) {
    // Load before changing durable mode. Never expose speculative permissions to
    // a loop which may already hold this cached object across a provider await.
    const previous = this.load(chatId);
    const next = this.store.transaction(() => {
      if (receipt) this.store.setState(`build:${chatId}`, receipt);
      return this.prepareSubmission(chatId, content, previous);
    });
    if (previous?.frames.length) {
      // prepareSubmission preserves frame identities held by the active loop.
      Object.assign(previous, next);
      this.runs.set(chatId, previous);
    } else this.runs.set(chatId, next);
    this.launch(chatId);
  }

  private prepareSubmission(chatId: string, content: string, previous: RunState | null): RunState {
    this.assertAvailable(chatId);

    const chat = this.store.chat(chatId);
    const text = content.trim();

    if (!text) throw new Error('Message must not be empty');
    if (text.length > 100000) throw new Error('Message is too large');

    const planning = /^\/plan(?:\s|$)/.test(text);
    const building = /^(?:start building|go ahead)[.!]?$/i.test(text);
    const mode = planning ? 'plan' : building && chat.mode === 'plan' ? 'execute' : chat.mode ?? 'execute';
    if (mode === 'execute' && chat.mode === 'plan') {
      if (!this.store.plan(chatId).phases.some(p=>p.steps.length)) throw Object.assign(new Error('Create a plan before starting to build'), {statusCode:409});
      if (this.decisions.has(chatId) || this.load(chatId)?.frames.some(f=>f.pending?.stage === 'executing')) throw Object.assign(new Error('Wait for the current operation to stop before starting'), {statusCode:409});
    }
    if (mode !== chat.mode) this.store.updateChat(chatId, {mode, modeVersion: (chat.modeVersion ?? 0) + 1});
    this.installs?.invalidate(chatId,'USER_STEERING');
    this.store.message(chatId, 'user', text);

    if (chat.title === 'New chat') {
      this.store.updateChat(chatId, {
        title: text.replace(/^\/\w+\s*/, '').slice(0, 64) || 'New chat',
      });
    }

    const existing = previous && {...previous, steering: [...previous.steering]};

    if (existing?.frames.length) {
      existing.planOnly = mode === 'plan';

      existing.steering.push(text.replace(/^\/btw\s*/, '') || text);
      existing.generation++;

      this.store.invalidateApprovals(chatId);
      this.store.setState(`run:${chatId}`, existing);
      this.store.event(chatId, 'steering', { content: text, delivered: false });
      return existing;
    }

    const history: ModelMessage[] = this.store
      .messages(chatId)
      .filter(message => ['user', 'architect'].includes(message.role))
      .map(message => ({
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.content,
      }));

    const objective = text
      .replace(/^\/plan\s*/, '')
      .replace(/^\/btw\s*/, '')
      .trim();

    const state: RunState = {
      frames: [this.frame('architect', history)],
      steering: [],
      planOnly: mode === 'plan',
      steps: 0,
      generation: 0,
      objective: building && existing?.objective ? existing.objective : objective,
    };

    this.store.setState(`run:${chatId}`, state);
    return state;
  }

  private commitRunTransition(chatId: string, state: RunState, change: (draft: RunState) => void) {
    // Events/progress and the corresponding frame snapshot commit together.
    // Rollback leaves both the live loop's root and every frame untouched.
    const draft = structuredClone(state);
    this.store.transaction(() => {
      change(draft);
      this.store.setState(`run:${chatId}`, draft);
      for(const frame of draft.frames)this.store.setState(`native:frame:${chatId}:${frame.id}`,frame.messages);
    });
    const oldFrames=new Map(state.frames.map(frame=>[frame.id,frame]));
    draft.frames=draft.frames.map(frame=>{const live=oldFrames.get(frame.id);if(!live)return frame;const oldPending=live.pending;if(oldPending&&frame.pending?.id===oldPending.id){for(const key of Object.keys(oldPending))delete (oldPending as unknown as Record<string,unknown>)[key];Object.assign(oldPending,frame.pending);frame.pending=oldPending;}for(const key of Object.keys(live))delete (live as unknown as Record<string,unknown>)[key];Object.assign(live,frame);return live;});
    Object.assign(state, draft);
    this.runs.set(chatId, state);
  }

  private launch(chatId: string) {
    this.assertAvailable(chatId);

    if (this.active.has(chatId)) return;

    const controller = new AbortController();

    const promise = Promise.resolve()
      .then(() => this.loop(chatId, controller.signal))
      .catch(error => {
        if (controller.signal.aborted) return;

        for (const frame of this.load(chatId)?.frames ?? []) this.store.progress(chatId, frame.planStep, frame.id, 'blocked', 'error', 'Run stopped with an error; inspect recorded evidence.');
        this.store.updateChat(chatId, { status: 'error' });
        const message = this.store.message(
          chatId,
          'system',
          error instanceof Error ? error.message : 'Run failed',
        );
        this.store.event(chatId, 'error', { message: message.content, messageId: message.id });
      })
      .finally(() => {
        this.active.delete(chatId);
      });

    this.active.set(chatId, { controller, promise });
  }

  async wait(chatId: string) {
    await this.active.get(chatId)?.promise;
  }

  notifyFileChange(
    projectId: string,
    filename: string,
    source: 'editor' | 'external' | 'agent' | 'undo',
    excludeChatId?: string,
  ) {
    if (this.store.project(projectId).removalError) return;
    for (const chat of this.store.chats(projectId)) {
      if (chat.id === excludeChatId) continue;

      const state = this.load(chat.id);
      if (!state?.frames.length) continue;

      state.steering.push(
        `Workspace change notification: ${JSON.stringify({ path: filename, source })}. Re-read this file before editing. Preserve manual changes unless the requested feature requires changing them.`,
      );

      state.generation++;
      this.installs?.invalidate(chat.id,'WORKSPACE_CHANGED');
      this.store.invalidateApprovals(chat.id);
      this.save(chat.id, state);

      // A paused task stays paused; active tasks consume this at the next safe boundary.
      if (
        chat.status === 'awaiting_approval' &&
        !this.active.has(chat.id) &&
        !this.projectEdits.has(projectId)
      ) {
        this.launch(chat.id);
      }
    }
  }

  async control(chatId: string, action: 'pause' | 'resume' | 'interrupt') {
    this.store.chat(chatId);
    this.decisions.set(chatId,(this.decisions.get(chatId) ?? 0)+1);
    try { return await this.controlInternal(chatId,action); }
    finally { const remaining=this.decisions.get(chatId)!-1;if(remaining)this.decisions.set(chatId,remaining);else this.decisions.delete(chatId); }
  }

  private async controlInternal(chatId: string, action: 'pause' | 'resume' | 'interrupt') {
    this.store.chat(chatId);

    if (action === 'resume') {
      this.assertAvailable(chatId);

      if (this.active.has(chatId)) {
        throw Object.assign(
          new Error('Wait for the current action to stop before resuming'),
          { statusCode: 409 },
        );
      }

      const state = this.load(chatId);
      if (!state?.frames.length) return;

      state.steps = 0;
      this.save(chatId, state);
      this.launch(chatId);

      return;
    }

    const running = this.active.get(chatId);
    this.installs?.invalidate(chatId,'USER_CANCELLED');

    this.store.updateChat(chatId, {
      status: action === 'pause' ? 'paused' : 'interrupted',
    });

    for (const frame of this.load(chatId)?.frames ?? []) this.store.progress(chatId, frame.planStep, frame.id, 'blocked', action, 'Work stopped; completion has not been accepted.');
    running?.controller.abort(new Error(`Task ${action} requested`));

    this.store.invalidateApprovals(chatId);
    await running?.promise;
    const state=this.load(chatId);
    if(state)this.commitRunTransition(chatId,state,draft=>{for(const frame of draft.frames)this.cancelQueued(chatId,frame,'Cancelled before dispatch; no effect started.');});
  }

  async decide(approvalId: string, decision: 'approve' | 'deny') {
    const chatId = this.store.getApproval(approvalId).chatId;
    this.assertAvailable(chatId);
    this.decisions.set(chatId,(this.decisions.get(chatId) ?? 0)+1);
    try { return await this.decideInternal(approvalId,decision); }
    finally { const remaining = this.decisions.get(chatId)!-1; if (remaining) this.decisions.set(chatId,remaining); else this.decisions.delete(chatId); }
  }

  private async decideInternal(approvalId: string, decision: 'approve' | 'deny') {
    const approval = this.store.getApproval(approvalId);

    this.assertAvailable(approval.chatId);

    if (approval.status !== 'pending') {
      throw Object.assign(
        new Error('Approval is no longer pending'),
        { statusCode: 409 },
      );
    }

    const state = this.load(approval.chatId);
    const pending = state?.frames.at(-1)?.pending;

    if (pending?.approvalId !== approval.id || state?.steering.length) {
      throw Object.assign(
        new Error('This proposal has been superseded'),
        { statusCode: 409 },
      );
    }

    try {
      await this.refreshInstructions(approval.chatId, state!);
    } catch (error) {
      this.store.updateChat(approval.chatId, { status: 'error' });
      const message = this.store.message(approval.chatId, 'system', (error as Error).message);
      this.store.event(approval.chatId, 'error', {
        message: (error as Error).message,
        messageId: message.id,
      });

      throw Object.assign(error as Error, { statusCode: 409 });
    }

    // Recheck after the read: a concurrent decision, pause, or steering can win.
    if (
      this.store.getApproval(approvalId).status !== 'pending' ||
      state!.frames.at(-1)?.pending !== pending ||
      state!.steering.length
    ) {
      if (this.store.chat(approval.chatId).status === 'awaiting_approval') {
        this.launch(approval.chatId);
      }

      throw Object.assign(
        new Error('This proposal has been superseded; refresh project guidance before reviewing a new proposal'),
        { statusCode: 409 },
      );
    }

    this.assertAvailable(approval.chatId);

    if (approval.install) {
      if (!this.installs) throw new Error('System installs unavailable');
      this.installs.decide(approval.id,decision,()=>state!.frames.at(-1)?.pending===pending && !state!.steering.length && state!.generation===approval.install!.generation && !state!.planOnly);
      this.launch(approval.chatId);
      return;
    }
    this.store.approval({
      ...approval,
      status: decision === 'approve' ? 'approved' : 'denied',
    });

    this.launch(approval.chatId);
  }

  private toolContext(
    chatId: string,
    frame: Frame,
    signal: AbortSignal,
    commandId?: string,
  ): ToolContext {
    const chat = this.store.chat(chatId);

    return {
      projectRoot: this.store.project(chat.projectId).path,
      chatId,
      agentId: frame.shellId ?? frame.id,
      signal,
      onOutput: output =>
        this.store.event(chatId, 'tool_output', {
          agentId: frame.id,
          commandId,
          sessionId: frame.shellId ?? frame.id,
          output: output.slice(-16000),
          truncated: output.length > 16000,
        }),
    };
  }

  private resolveCall(chatId:string, frame:Frame, callId:string, result:ToolResult) {
    if (!frame.queuedCalls?.some(call=>call.id===callId)) throw new Error('Native call correlation was lost');
    const full = JSON.stringify(result);
    this.store.setState(`native:result:${chatId}:${frame.id}:${callId}`,result);
    const content = Buffer.byteLength(full) <= 120000 ? full : JSON.stringify({ok:result.ok,output:result.output.slice(0,16000),truncated:true,evidence:`native:result:${chatId}:${frame.id}:${callId}`});
    frame.messages.push({role:'tool',tool_call_id:callId,content});
    frame.queuedCalls = frame.queuedCalls.filter(call=>call.id!==callId);
    this.store.setState(`native:frame:${chatId}:${frame.id}`,frame.messages);
  }
  private cancelQueued(chatId:string,frame:Frame,reason:string) {
    if (frame.pending?.stage === 'executing' || frame.pending?.stage === 'done') return;
    for (const call of [...(frame.queuedCalls ?? [])]) {
      if(call.id===frame.pending?.callId && frame.pending.action.name==='recommend_packages') {
        const install=this.store.install(frame.pending.id);
        if(install.recoveryRequired || ['authorizing','dispatching','uncertain','succeeded','noop','failed'].includes(install.state)) {
          this.resolveCall(chatId,frame,call.id,{ok:['succeeded','noop'].includes(install.state),output:`System install evidence: ${install.state}. Cancellation does not undo package effects; inspect the original install record and use explicit reconciliation when required.`,data:{installId:install.id,state:install.state,recoveryRequired:install.recoveryRequired}});continue;
        }
      }
      this.resolveCall(chatId,frame,call.id,{ok:false,output:reason,data:{status:'not_started'}});
    }
    frame.pending = undefined;
  }

  private deliverSteering(chatId:string,state:RunState) {
    if(!state.steering.length)return;
    this.commitRunTransition(chatId,state,draft=>{
      const guidance=draft.steering.splice(0);
      for(const frame of draft.frames) {
        if(frame.planStep) {
          this.store.progress(chatId,frame.planStep,frame.id,'blocked','superseded','New guidance requires a fresh delegation before this step can be accepted.');
          delete frame.planStep;
        }
        this.cancelQueued(chatId,frame,'Proposal superseded before execution; request fresh work.');
        frame.messages.push({role:'user',content:'New user guidance (takes precedence over earlier task details):\n'+guidance.join('\n\n')});
      }
      for(const content of guidance)this.store.event(chatId,'steering',{content,delivered:true});
    });
  }
  private discardPrepared(chatId:string,state:RunState) {
    this.commitRunTransition(chatId,state,draft=>{
      this.store.invalidateApprovals(chatId);
      this.installs?.invalidate(chatId,'GUIDANCE_CHANGED');
      for(const frame of draft.frames)this.cancelQueued(chatId,frame,'Proposal superseded before execution; request fresh work.');
    });
  }

  private async refreshInstructions(
    chatId: string,
    state: RunState,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();

    let instructions;

    try {
      instructions = await readProjectInstructions(
        this.tools,
        this.store.project(this.store.chat(chatId).projectId).path,
      );
    } catch (error) {
      this.discardPrepared(chatId, state);
      delete state.instructionsHash;
      state.generation++;
      this.save(chatId, state);
      throw error;
    }

    signal?.throwIfAborted();

    if (
      state.instructionsHash !== instructions.hash ||
      state.frames.some(
        frame =>
          frame.pending?.stage === 'prepared' &&
          frame.pending.instructionsHash !== instructions.hash,
      )
    ) {
      const previouslyLoaded = state.instructionsHash !== undefined;

      this.discardPrepared(chatId, state);
      state.instructionsHash = instructions.hash;
      state.generation++;

      if (previouslyLoaded) {
        this.store.message(
          chatId,
          'system',
          'Root AGENTS.md changed. Prepared proposals were discarded; the next request uses fresh project guidance.',
        );
      }

      this.save(chatId, state);
    }

    return instructions;
  }

  private goalAnchor(state: RunState, frame: Frame, evidence?: string): string {
    const objective =
      frame.objective ??
      state.objective ??
      'Continue the active user task using the available evidence.';

    return [
      `CURRENT OBJECTIVE:\n${objective}`,
      evidence ? `\nLATEST OBSERVED EVIDENCE:\n${evidence}` : '',
      '\nPROGRESS RULES:',
      '- Treat observed tool results as authoritative evidence.',
      '- Do not repeat an unchanged discovery action.',
      '- A missing README or empty workspace is an observation, not a blocker.',
      '- Choose the next action that advances the current objective.',
      '- Architect delegates bounded implementation work when the objective requires changes.',
      '- Coder performs repository discovery, implementation, and verification.',
    ].join('\n');
  }

  private async loop(chatId: string, signal: AbortSignal) {
    const state = this.load(chatId);
    if (!state?.frames.length) return;

    this.store.updateChat(chatId, { status: 'running' });

    while (state.frames.length && !signal.aborted) {
      const unsettled = state.frames.at(-1)!;
      if (unsettled.pending && unsettled.pending.stage !== 'prepared') {
        if (!await this.executePending(chatId,state,unsettled,signal)) return;
        continue;
      }
      this.deliverSteering(chatId, state);
      const frame = state.frames.at(-1)!;

      if (frame.pending && frame.pending.stage !== 'prepared') {
        if (!await this.executePending(chatId, state, frame, signal)) return;
        continue;
      }

      const instructions = await this.refreshInstructions(chatId, state, signal);

      if (frame.pending) {
        if (!await this.executePending(chatId, state, frame, signal)) return;
        continue;
      }

      if (++state.steps > 100) {
        for (const unfinished of state.frames) this.store.progress(chatId, unfinished.planStep, unfinished.id, 'blocked', 'budget', 'Task reached its safety budget; resume is required.');
        this.store.updateChat(chatId, { status: 'paused' });
        this.store.message(
          chatId,
          'system',
          'The task reached its 100-step safety budget. Review progress and resume to continue.',
        );
        this.save(chatId, state);
        return;
      }

      const generation = state.generation;
      if (!frame.queuedCalls?.length) {
      const authoritative =
        `Project: ${this.store.project(this.store.chat(chatId).projectId).path}\n` +
        `Plan: ${JSON.stringify(this.store.plan(chatId))}\n` +
        `Mode: ${state.planOnly
          ? 'PLAN ONLY: do not change files, run commands, or delegate implementation.'
          : 'Implementation is allowed subject to the runtime approval policy.'}\n` +
        `You are the ${frame.role}. ` +
        `${frame.role === 'architect'
          ? 'You own the user conversation. Delegate code changes to a coder. Inspect context as needed. Report critic findings honestly.'
          : frame.role === 'critic'
            ? 'Review independently against the original request, task acceptance criteria, actual files, git diff, and tool/test evidence. Only read tools are permitted. Conclude with review_result. Do not infer tests passed from model claims.'
            : 'Complete the assigned task, read before editing, preserve manual changes, verify results, and provide evidence. Never delegate recursively.'}`;

      let messages: ModelMessage[] = [
        {
          role: 'system',
          content: `${this.hooks.instructions(frame.role)}\n\n${projectInstructionsPolicy}`,
        },
        {
          role: 'user',
          content: `Authoritative task state:\n${authoritative}`,
        },
        instructions.message,
        ...frame.messages,
      ];

      let preparedFrame:Frame|undefined;
      if (this.hooks.prepareMessages) {
        preparedFrame=structuredClone(frame);
        messages = await this.hooks.prepareMessages(
          chatId,
          preparedFrame,
          messages,
          signal,
        );
      }

      await this.refreshInstructions(chatId,state,signal);
      if(state.generation!==generation)continue;
      if(preparedFrame && JSON.stringify(preparedFrame.messages)!==JSON.stringify(frame.messages))this.commitRunTransition(chatId,state,draft=>{draft.frames.find(item=>item.id===frame.id)!.messages=preparedFrame!.messages;});
      messages.push({role:'user',content:this.goalAnchor(state,frame)});
      this.save(chatId,state);
      const input = {model:this.store.chatModels(chatId)[frame.role],messages,tools:publishedTools(frame.role,state.planOnly?'plan':'execute'),signal,maxTokens:this.config.maxOutputTokens,onDelta:(text:string)=>this.store.event(chatId,'delta',{role:frame.role,text})};
      const completion = this.hooks.complete ? await this.hooks.complete(frame.role,input) : await this.provider.complete(input);
      signal.throwIfAborted();
      this.store.event(chatId,'provider_request',{role:frame.role,model:input.model,finishReason:completion.finishReason,...(completion.requestId?{requestId:completion.requestId}:{})});
      if (completion.usage) this.store.event(chatId,'usage',{role:frame.role,...completion.usage});
      await this.refreshInstructions(chatId,state,signal);
      if (state.generation !== generation) { this.deliverSteering(chatId,state); continue; }
      const calls = validateNativeCalls(completion.toolCalls);
      if (completion.finishReason !== (calls.length ? 'tool_calls' : 'stop')) throw new Error('Native completion did not finish normally');
      if (typeof completion.text !== 'string' || Buffer.byteLength(completion.text)>2_000_000 || !completion.text.trim() && !calls.length) throw new Error('Invalid native assistant message');
      // Check against every original call, including compacted history.
      const seen = new Set(this.store.getState<string[]>(`native:ids:${chatId}`,[]));
      if (calls.some(call=>seen.has(call.id))) throw new Error('Duplicate native call identity');
      calls.forEach(call=>seen.add(call.id));
      let invalidBatch=false;
      try {
        calls.forEach((call,index)=>{
          validateAction(parseToolArguments(call.function.name,call.function.arguments),frame.role,state.planOnly?'plan':'execute');
          if(definitionFor(call.function.name).terminal && index!==calls.length-1)throw new Error('Terminal call must be last');
        });
      } catch {invalidBatch=true;}
      let waitForHuman=false;
      this.commitRunTransition(chatId,state,draft=>{
        const next=draft.frames.find(item=>item.id===frame.id)!;
        this.store.setState(`native:ids:${chatId}`,[...seen]);
        next.messages.push({role:'assistant',content:completion.text,...(calls.length?{tool_calls:calls}:{})});
        next.queuedCalls=calls;
        if(completion.text)this.store.message(chatId,next.role,completion.text,{agentId:next.id});
        if(!calls.length) {
          next.proseTurns=(next.proseTurns??0)+1;
          if(next.role==='architect') {this.store.updateChat(chatId,{status:'idle'});waitForHuman=true;}
          else if(next.proseTurns>=3) {
            this.store.updateChat(chatId,{status:'paused'});waitForHuman=true;
            this.store.message(chatId,'system',`${next.role} stopped after three text-only turns without a required native completion or verdict. Work remains unaccepted; review the task and resume or steer it.`);
            this.store.progress(chatId,next.planStep,next.id,'blocked','no_progress','Internal agent did not provide a native completion or verdict.');
          } else next.messages.push({role:'user',content:next.role==='critic'?'Continue the review using observed evidence; submit review_result when ready. Text is not a recorded verdict.':'Continue the assigned work using native tools, or submit_completion with observed evidence and limitations when ready. A status update does not complete the assignment.'});
        } else {
          next.proseTurns=0;
          if(invalidBatch)for(const call of calls) {
            const result={ok:false,output:'Entire native batch rejected: invalid arguments, unknown tool, tool not permitted for this role or mode, or terminal ordering. No call executed.',data:{status:'not_started'}};
            this.resolveCall(chatId,next,call.id,result);
            const message=this.store.message(chatId,'tool',result.output,{agentId:next.id,name:call.function.name,toolCallId:call.id,ok:false,rejected:true});
            this.store.event(chatId,'tool',{agentId:next.id,result,messageId:message.id,toolCallId:call.id});
          }
        }
      });
      if(waitForHuman)return;
      continue;
      }
      const call = frame.queuedCalls![0];
      const action = parseToolArguments(call.function.name,call.function.arguments);

      try {
        validateAction(action,frame.role,state.planOnly?'plan':'execute');
        const definition=definitionFor(action.name);
        if(definition.kind==='control' && action.name!=='recommend_packages') {
          const outcome=await definition.handler({workspace:this.tools,context:this.toolContext(chatId,frame,signal),control:async request=>this.controlAction(chatId,state,frame,call,request)},action);
          if(outcome.data==='pause')return;
          continue;
        }
        {
          if (action.name === 'recommend_packages') {
            if (!this.installs || state.planOnly || frame.role === 'critic') throw new Error('System installation is unavailable in this mode');
            const id=randomUUID();
            this.commitRunTransition(chatId,state,draft=>{
              const next=draft.frames.find(item=>item.id===frame.id)!;
              this.installs!.create(id,chatId,next.id,next.role,draft.generation,action.args);
              next.pending={id,callId:call.id,action,stage:'prepared',instructionsHash:instructions.hash};
            });
            continue;
          }
          if (!workspaceTools.has(action.name)) {
            throw new Error('Unknown workspace action');
          }

          if (
            (frame.role === 'critic' ||
              frame.role === 'architect' ||
              state.planOnly) &&
            !readTools.has(action.name)
          ) {
            throw new Error(
              'This agent or plan-only task may only use read tools; implementation belongs to the coder',
            );
          }

          if (action.name === 'write_file' && frame.scope?.length) {
            const target = String(action.args.path)
              .replaceAll('\\', '/')
              .replace(/^\.\//, '');

            if (
              !frame.scope.some(item => {
                const scope = item
                  .replaceAll('\\', '/')
                  .replace(/\/$/, '')
                  .replace(/^\.\//, '');

                return target === scope || target.startsWith(`${scope}/`);
              })
            ) {
              throw new Error(
                'This edit exceeds the assigned file scope. Report the scope expansion to the architect before proceeding.',
              );
            }
          }

          const inspection = await definitionFor(action.name).inspect({workspace:this.tools,context:this.toolContext(chatId,frame,signal),control:async()=>{throw new Error('Not a workspace call');}},action);

          signal.throwIfAborted();

          await this.refreshInstructions(chatId, state, signal);

          if (state.generation !== generation) {
            this.deliverSteering(chatId, state);
            continue;
          }

          const mode = this.store.chat(chatId).approvalMode;

          const needsApproval =
            inspection.effect !== 'read' &&
            (mode === 'review' ||
              (mode === 'balanced' &&
                (inspection.effect === 'execute' ||
                  inspection.risk === 'elevated')));

          this.commitRunTransition(chatId,state,draft=>{
          const next=draft.frames.find(item=>item.id===frame.id)!;
          next.pending = {
            callId:call.id,
            id: randomUUID(),
            action,
            stage: 'prepared',
            instructionsHash: instructions.hash,
          };

          if (needsApproval) {
            const approval: Approval = {
              id: randomUUID(),
              chatId,
              agentId: frame.id,
              action,
              inspection,
              status: 'pending',
              createdAt: new Date().toISOString(),
            };

            next.pending!.approvalId = approval.id;
            this.store.approval(approval);
          }
          });
        }
      } catch (error) {
        if (signal.aborted || error instanceof ProjectInstructionsError) {
          throw error;
        }

        const failedFrame=frame;
        this.commitRunTransition(chatId,state,draft=>{
        const frame=draft.frames.find(item=>item.id===failedFrame.id)!;
        this.resolveCall(chatId,frame,call.id,safeResult(error));

        const message = this.store.message(chatId, 'tool', safeResult(error).output.slice(0, 32000), {
          agentId: frame.id, name: action.name, ok: false, rejected: true,
        });
        const rejectedEvent = this.store.event(chatId, 'tool', {
          agentId: frame.id,
          action,
          result: safeResult(error),
          messageId: message.id,
        });

        this.store.progress(chatId, frame.planStep, frame.id, 'blocked', 'failed', safeResult(error).output.slice(0, 2000), rejectedEvent.id);
        frame.failures = (frame.failures ?? 0) + 1;

        if (frame.role === 'coder' && frame.failures >= 3 && !frame.queuedCalls?.length) {
          this.checkpoint(
            draft,
            frame,
            'Repeated failed actions; check scope drift and missing prerequisites before continuing.',
          );
        }
        });
      }

      this.save(chatId, state);
    }

    if (!signal.aborted && !state.frames.length) {
      this.store.updateChat(chatId, { status: 'idle' });
    }
  }

  private async executePending(
    chatId: string,
    state: RunState,
    frame: Frame,
    signal: AbortSignal,
  ): Promise<boolean> {
    const pending = frame.pending!;
    const transition=(change:(next:Frame,draft:RunState)=>void)=>this.commitRunTransition(chatId,state,draft=>{
      const next=draft.frames.find(item=>item.id===frame.id);
      if(!next || next.pending?.id!==pending.id)throw new Error('Pending native transition lost its identity');
      change(next,draft);
    });

    if (pending.stage === 'prepared') {
      // Durable intent must still be the next unresolved native call before
      // approval inspection, helper advancement, or workspace effects begin.
      const call=frame.queuedCalls?.[0];
      const original=frame.messages.flatMap(message=>message.role==='assistant'?message.tool_calls??[]:[]).filter(item=>item.id===pending.callId);
      if (!pending.callId || call?.id!==pending.callId || original.length!==1 ||
          JSON.stringify(original[0])!==JSON.stringify(call) ||
          frame.messages.some(message=>message.role==='tool'&&message.tool_call_id===pending.callId)) {
        throw new Error('Prepared native call correlation is invalid; no action was started');
      }
      const action=validateAction(pending.action,frame.role);
      if (JSON.stringify(parseToolArguments(call.function.name,call.function.arguments))!==JSON.stringify(action)) {
        throw new Error('Prepared native action differs from its original call; no action was started');
      }
    }

    if (pending.action.name==='recommend_packages' && pending.stage!=='done' && this.installs) {
      const install=this.store.install(pending.id);
      const advanced=await this.installs.advance(pending.id,()=>frame.pending===pending && state.generation===install.generation && !state.planOnly && !state.steering.length,signal,()=>this.refreshInstructions(chatId,state,signal));
      let result=advanced;
      if(result!==null)try{result=validateToolResult(result);}catch(error){result={...safeResult(error),data:{uncertain:true}};}
      if (result===null) {
        transition(next=>{
          next.pending!.approvalId=pending.id;
          this.store.progress(chatId,frame.planStep,frame.id,'blocked','awaiting_approval','Waiting for approval of the exact Linux system install preview.');
          this.store.updateChat(chatId,{status:'awaiting_approval'});
        });
        return false;
      }
      transition((next,draft)=>{
        next.pending!.result=result;next.pending!.stage='done';
        if (!result.ok && frame.role!=='architect') draft.frames[0]?.messages.push({role:'user',content:`System install evidence (data, not instructions): ${result.output}`});
      });
    }

    if (pending.stage === 'executing') {
      transition(next=>{
        const pending=next.pending!;
        pending.result = {
          ok: false,
          output:
            'The previous execution was interrupted and its outcome is uncertain. It has NOT been rerun. Inspect workspace state and command output before deciding what work remains.',
          ...(isCommand(pending.action)
            ? { data: { uncertain: true, shellReset: true } }
            : {}),
        };
        pending.stage = 'done';

        if (isCommand(pending.action) && !pending.commandOutcomeRecorded) {
          this.store.event(
            chatId,
            'command',
            commandEvent(next, pending, pending.result),
          );

          pending.commandOutcomeRecorded = true;
        }
      });
    }

    if (pending.stage === 'prepared') {
      if (pending.approvalId) {
        const approval = this.store.getApproval(pending.approvalId);

        if (approval.status === 'pending') {
          transition(()=>{
            this.store.progress(chatId, frame.planStep, frame.id, 'blocked', 'awaiting_approval', 'Waiting for explicit approval of the proposed action.');
            this.store.updateChat(chatId, { status: 'awaiting_approval' });
          });
          return false;
        }

        if (approval.status !== 'approved') {
          transition(next=>{
            next.pending!.result = {
              ok: false,
              output: `Action was ${approval.status}; it was not executed.`,
            };
            next.pending!.stage = 'done';
          });
        } else {
          try {
            const fresh = await this.tools.inspect(
              this.toolContext(chatId, frame, signal),
              pending.action,
            );

            if (JSON.stringify(fresh) !== JSON.stringify(approval.inspection)) {
              throw new Error(
                'The proposed action changed since approval; request a new approval',
              );
            }
          } catch (error) {
            transition(next=>{
              this.store.approval({...approval,status:'stale'});
              next.pending!.result = safeResult(error);
              next.pending!.stage = 'done';
            });
          }
        }
      }

      signal.throwIfAborted();

      if (state.steering.length) {
        this.deliverSteering(chatId, state);
        return true;
      }

      if (pending.stage === 'prepared') {
        // This is the final runtime boundary, after any approval reinspection.
        // A running tool is not rolled back; the next boundary sees its effects.
        await this.refreshInstructions(chatId, state, signal);

        if (frame.pending !== pending) return true;

        if (state.steering.length) {
          this.deliverSteering(chatId, state);
          return true;
        }

        if (state.planOnly && !readTools.has(pending.action.name)) {
          transition(next=>{
            next.pending!.result = {ok:false, output:'Planning mode forbids this prepared action; request a fresh delegation after Start building.'};
            next.pending!.stage = 'done';
          });
          return true;
        }

        if (pending.action.name === 'write_file') {
          const project = this.store.project(
            this.store.chat(chatId).projectId,
          );

          const args = pending.action.args;

          const before = await this.tools.read(
            project.path,
            String(args.path),
          );

          signal.throwIfAborted();

          // Snapshot reads await I/O: recheck M9 guidance and steering afterwards.
          await this.refreshInstructions(chatId, state, signal);

          if (frame.pending !== pending) return true;

          if (state.steering.length) {
            this.deliverSteering(chatId, state);
            return true;
          }

          if (before.hash !== args.baseHash) {
            transition(next=>{
              next.pending!.result = {
                ok: false,
                output:'File changed before recording the write; re-read before editing.',
              };
              next.pending!.stage = 'done';
            });
            return true;
          }

          const content = String(args.content);

          // A stable action ID and transaction bind snapshots to execution intent.
          this.commitRunTransition(chatId,state,draft=>{
            const next=draft.frames.find(item=>item.id===frame.id)!;
            this.store.recordFileChange({
              id: pending.id,
              projectId: project.id,
              chatId,
              path: before.path,
              createdAt: new Date().toISOString(),
              status: 'recording',
              before,
              after: {
                path: before.path,
                content,
                hash: hash(content),
              },
            });

            next.pending!.stage='executing';
          });
        }

        this.commitRunTransition(chatId,state,draft=>{
          draft.frames.find(item=>item.id===frame.id)!.pending!.stage='executing';

          if (isCommand(pending.action)) {
            this.store.event(
              chatId,
              'command',
              commandEvent(frame, pending),
            );
          }
        });

        this.store.event(chatId, 'tool', {
          agentId: frame.id,
          commandId: pending.id,
          sessionId: frame.shellId ?? frame.id,
          action: pending.action,
        });

        const context = this.toolContext(
          chatId,
          frame,
          signal,
          pending.id,
        );

        const publishOutput = context.onOutput;
        let acceptingOutput = true;

        context.onOutput = output => {
          if (acceptingOutput) publishOutput?.(output);
        };

        let executionResult:ToolResult;
        try {
          validateAction(pending.action,frame.role,state.planOnly?'plan':'execute');
          executionResult = await definitionFor(pending.action.name).handler({workspace:this.tools,context,control:async()=>{throw new Error('Not a workspace call');}},pending.action);
        } catch (error) {
          executionResult = {
            ...safeResult(error),
            ...(definitionFor(pending.action.name).effect!=='read'
              ? { data: { uncertain: true } }
              : {}),
          };
        } finally {
          acceptingOutput = false;
        }

        // Persist the outcome even if cancellation happened while the tool was running.
        const completedFrame=frame;
        this.commitRunTransition(chatId,state,draft=>{
          const frame=draft.frames.find(item=>item.id===completedFrame.id)!;
          const pending=frame.pending!;pending.result=executionResult;
          if (pending.action.name === 'write_file') {
            const projectId = this.store.chat(chatId).projectId;
            const change = this.store.fileChange(projectId, pending.id);

            const result = pending.result?.data as
              | { hash?: string; path?: string; mutation?: string }
              | undefined;

            this.store.transitionFileChange(
              pending.id,
              'recording',
              pending.result?.ok &&
                result?.hash === change.after.hash &&
                result.path === change.path
                ? 'confirmed'
                : result?.mutation === 'not_started'
                  ? 'rejected'
                  : 'unknown',
            );
          }

          pending.stage = 'done';


          if (isCommand(pending.action)) {
            this.store.event(
              chatId,
              'command',
              commandEvent(frame, pending, pending.result),
            );

            pending.commandOutcomeRecorded = true;

          }
        });
      }
    }

    if (pending.stage === 'done') {
      const originalFrame=frame;
      let changedFile:{projectId:string;filename:string}|undefined;
      this.commitRunTransition(chatId,state,draft=>{
        const frame=draft.frames.find(item=>item.id===originalFrame.id)!;
        const pending=frame.pending!;
        const result = pending.result ?? {
          ok: false,
          output: 'No execution result was recorded',
        };
        const objective =
          frame.objective ??
          state.objective ??
          'Continue the active user task using the available evidence.';

        const toolEvidence = JSON.stringify(result).slice(0, 120000);
        const command = isCommand(pending.action) ? commandEvent(frame, pending, result) : undefined;
        const outcome = command
          ? command.status === 'completed'
            ? `command exited successfully (exit 0)${result.ok ? '' : ', but the tool reported a separate problem; inspect the report or tool evidence'}`
            : command.status === 'failed'
              ? `command failed (exit ${command.exitCode})`
              : `command outcome is ${command.status}; do not infer success`
          : result.ok ? 'completed successfully' : 'completed with a failure';

        if (!pending.callId) throw new Error('Missing native call identity');
        this.resolveCall(chatId,frame,pending.callId,result);

        const message = this.store.message(
          chatId,
          'tool',
          result.output.slice(0, 32000),
          {
            agentId: frame.id,
            name: pending.action.name,
            ok: result.ok,
            commandId: pending.id,
            toolCallId: pending.callId,
            ...(command ? { commandStatus: command.status, exitCode: command.exitCode } : {}),
          },
        );

        const toolEvent = this.store.event(chatId, 'tool', {
          agentId: frame.id,
          commandId: pending.id,
          sessionId: frame.shellId ?? frame.id,
          action: pending.action,
          result,
          messageId: message.id,
        });

        frame.evidenceEventIds = [...(frame.evidenceEventIds ?? []), toolEvent.id].slice(-100);
        this.store.progress(chatId, frame.planStep, frame.id, result.ok && !signal.aborted ? 'in_progress' : 'blocked', signal.aborted ? 'stopped' : result.ok ? 'working' : 'failed', outcome, toolEvent.id);

        if (result.ok && pending.action.name === 'write_file') {
          const projectId = this.store.chat(chatId).projectId;

          const snapshot = result.data as
            | { path?: string; hash?: string | null }
            | undefined;

          const filename = snapshot?.path ?? String(pending.action.args.path);

          changedFile={projectId,filename};

          for (const affected of this.store.chats(projectId)) {
            this.store.event(affected.id, 'file_changed', {
              path: filename,
              source: 'agent',
              hash: snapshot?.hash,
            });
          }
        }

        const data = result.data as {
          testReport?: import('../shared/types.js').TestReport;
        } | undefined;

        if (data?.testReport) {
          this.store.testReport(chatId, data.testReport);
        }

        frame.failures = result.ok ? 0 : (frame.failures ?? 0) + 1;

        if (frame.role === 'coder' && frame.failures >= 3 && !frame.queuedCalls?.length) {
          this.checkpoint(
            draft,
            frame,
            'Repeated failed actions; review scope drift, failed evidence, and missing prerequisites before the coder continues.',
          );
        }

        frame.pending = undefined;

      });
      if(changedFile)this.notifyFileChange(changedFile.projectId,changedFile.filename,'agent',chatId);
    }

    return !signal.aborted;
  }

  private checkpoint(state: RunState, frame: Frame, reason: string) {
    frame.failures = 0;

    const critic = this.frame(
      'critic',
      [
        {
          role: 'user',
          content:
            `Checkpoint review, not final completion. ${reason}\n` +
            `Assigned objective: ${frame.objective}\n` +
            `File scope: ${JSON.stringify(frame.scope ?? [])}\n` +
            `Evidence: ${JSON.stringify(frame.messages).slice(-150000)}\n` +
            'Inspect actual diffs/files and submit review_result.',
        },
      ],
      frame.objective,
    );

    critic.reviewKind = 'checkpoint';
    state.frames.push(critic);
  }

  private controlAction(chatId:string,state:RunState,original:Frame,call:NativeToolCall,action:Action):ToolResult {
    let paused=false;
    this.commitRunTransition(chatId,state,draft=>{
      const frame=draft.frames.find(item=>item.id===original.id)!;
      validateAction(action,frame.role,draft.planOnly?'plan':'execute');
      const resolve=(output:string,data?:unknown)=>this.resolveCall(chatId,frame,call.id,{ok:true,output,...(data===undefined?{}:{data})});
      switch(action.name) {
        case 'ask_user':
          resolve('Waiting for user information.');
          this.store.message(chatId,'architect',String(action.args.question));
          this.store.progress(chatId,frame.planStep,frame.id,'blocked','awaiting_user',String(action.args.question).slice(0,2000));
          this.store.updateChat(chatId,{status:'paused'});paused=true;break;
        case 'set_plan': {
          const plan=this.store.revisePlan(chatId,{phases:action.args.phases as import('../shared/types.js').PlanPhase[]});
          resolve(`Plan saved at revision ${plan.version}. Runtime evidence controls completion.`,plan);break;
        }
        case 'delegate': {
          const reference=action.args.planStep as PlanStepRef|undefined;
          if(reference&&!this.store.planStep(chatId,reference))throw new Error('Plan step is stale or missing; use the current plan identity and version');
          const objective=String(action.args.objective);
          const coder=this.frame('coder',[{role:'user',content:`Assigned task: ${objective}\nAcceptance criteria: ${JSON.stringify(action.args.acceptanceCriteria)}\nFile scope: ${JSON.stringify(action.args.paths??[])}\nUser request and constraints:\n${frame.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n').slice(-64000)}`}],objective);
          coder.planStep=reference;coder.scope=action.args.paths as string[]|undefined;coder.shellId='coder-primary';
          resolve('Coder delegated; result will follow independent review.',{delegationId:coder.id});
          draft.frames.push(coder);
          const event=this.store.event(chatId,'delegation',{objective,delegationId:coder.id,planStep:reference});
          this.store.progress(chatId,reference,coder.id,'in_progress','started',objective,event.id);break;
        }
        case 'review':
          resolve('Independent review requested.');
          draft.frames.push(this.frame('critic',[{role:'user',content:`Review focus: ${String(action.args.focus)}\nConversation and evidence:\n${JSON.stringify(frame.messages).slice(-100000)}`}],String(action.args.focus)));break;
        case 'review_result':
          resolve('Critic verdict recorded.');
          this.finishReviewInternal(chatId,draft,action.args.verdict==='pass',action.args.findings as string[]);break;
        case 'submit_completion': {
          const summary=String(action.args.summary);
          if(!frame.messages.at(-1)?.content)this.store.message(chatId,frame.role,summary,{agentId:frame.id});
          resolve('Completion submitted for this work frame; recorded review evidence controls acceptance.');
          if(frame.role==='coder') {
            frame.final=summary;
            this.store.progress(chatId,frame.planStep,frame.id,'in_progress','reviewing','Coder reported completion; independent review is pending.');
            const critic=this.frame('critic',[{role:'user',content:`Review this completed coder task before accepting it.\nObjective: ${frame.objective}\nOriginal assignment and evidence:\n${JSON.stringify(frame.messages).slice(-150000)}\nInspect relevant files and git diff. Conclude with review_result.`}],frame.objective);
            critic.reviewDelegationId=frame.id;draft.frames.push(critic);
          } else draft.frames.pop();
          break;
        }
        default:throw new Error('Unknown control tool');
      }
    });
    return {ok:true,output:'Control transition committed.',...(paused?{data:'pause'}:{})};
  }

  private finishReviewInternal(chatId: string, state: RunState, passed: boolean, findings: string[]) {
    const reviewer = state.frames.pop();
    const parent = state.frames.at(-1);

    const reviewEvent = this.store.event(chatId, 'review', { passed, findings, delegationId: reviewer?.reviewDelegationId, planStep: parent?.planStep, reviewKind: reviewer?.reviewKind ?? 'completion', evidenceEventIds: [...(parent?.evidenceEventIds ?? []), ...(reviewer?.evidenceEventIds ?? [])] });

    this.store.message(
      chatId,
      'critic',
      `${passed ? 'Review passed' : 'Changes requested'}${findings.length ? `:\n${findings.join('\n')}` : '.'}`,
    );

    if (reviewer?.reviewKind === 'checkpoint') {
      if (!passed && parent) this.store.progress(chatId,parent.planStep,parent.id,'blocked','checkpoint_changes_requested',findings.join('\n').slice(0,2000),reviewEvent.id);
      parent?.messages.push({
        role: 'user',
        content: passed
          ? `CHECKPOINT PASSED

    The critic accepted continuing from this checkpoint. This verdict does not change any recorded action outcome, failure, or uncertainty.

    Findings: ${findings.length ? findings.join('\n') : 'No additional findings.'}

    Continue from the observed tool evidence. Correct unresolved failures and gather missing evidence; do not repeat an unchanged action without a reason supported by that evidence.

    If the current objective and acceptance criteria are now satisfied, use submit_completion. Otherwise choose a different action that advances the original objective.`
          : `CHECKPOINT CHANGES REQUESTED

    Do not repeat the prior action unchanged.

    Address these findings before continuing:
    ${findings.length ? findings.join('\n') : 'Review did not accept the available evidence.'}

    Continue only within the original scope and gather or correct the missing evidence.`,
      });

      return;
    }

    if (parent?.role === 'coder') {
      if (reviewer?.reviewDelegationId === parent.id && parent.final !== undefined && !state.planOnly) {
        const observed = (parent.evidenceEventIds?.length ?? 0) + (reviewer.evidenceEventIds?.length ?? 0) > 0;
        this.store.progress(chatId, parent.planStep, parent.id, passed && observed ? 'done' : 'blocked', passed && observed ? 'accepted' : passed ? 'missing_evidence' : 'changes_requested', !observed && passed ? 'Review passed without recorded tool evidence; step completion remains unverified.' : findings.join('\n').slice(0,2000) || (passed ? 'Coder completion accepted by independent critic.' : 'Review requires changes.'), reviewEvent.id);
      }
      if (!passed && parent.repairs++ < 2) {
        parent.messages.push({
          role: 'user',
          content:
            `Independent critic requests changes. Address these findings and verify the result:\n` +
            findings.join('\n'),
        });

        return;
      }

      state.frames.pop();

      const architect = state.frames.at(-1);

      architect?.messages.push({
        role: 'user',
        content:
          `Delegation result:\n${parent.final ?? ''}\n` +
          `Critic verdict: ${passed ? 'PASS' : 'FAILED AFTER BOUNDED REPAIRS'}\n` +
          `Findings: ${findings.join('\n')}\n` +
          `Actual execution evidence:\n` +
          `${JSON.stringify(parent.messages.filter(message => message.role === 'tool')).slice(-100000)}\n` +
          'Report remaining issues and verification limits honestly.',
      });
    } else {
      parent?.messages.push({
        role: 'user',
        content:
          `Independent review: ${passed ? 'PASS' : 'CHANGES REQUESTED'}\n` +
          findings.join('\n'),
      });
    }
  }

  async refreshInstall(id: string) {
    if (!this.installs) throw new Error('System installs unavailable');
    this.installs.expire();
    const old=this.store.install(id), state=this.load(old.chatId), frame=state?.frames.at(-1);
    this.assertAvailable(old.chatId);
    if (this.active.has(old.chatId) || this.decisions.has(old.chatId) || !state || state.planOnly || state.steering.length || frame?.id!==old.frameId || frame.pending?.id!==id || !['stale','failed'].includes(old.state) || old.recoveryRequired) throw Object.assign(new Error('This request has changed; ask for a new package recommendation in the chat'),{statusCode:409});
    await this.refreshInstructions(old.chatId,state);
    if(frame.pending?.id!==id || state.steering.length || this.active.has(old.chatId))throw Object.assign(new Error('Request context changed'),{statusCode:409});
    const next=randomUUID();
    this.commitRunTransition(old.chatId,state,draft=>{
      this.installs!.create(next,old.chatId,frame.id,frame.role,state.generation,old.recommendation);
      draft.frames.find(item=>item.id===frame.id)!.pending={...frame.pending!,id:next,approvalId:undefined,stage:'prepared'};
    });
    this.launch(old.chatId);
    return {id:next};
  }

  async close() {
    this.installs?.beginClose();
    for (const item of this.active.values()) {
      item.controller.abort();
    }

    await Promise.all(
      [...this.active.values()].map(item => item.promise),
    );
    await this.installs?.close();
  }
}
