import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { commandEvent, isCommand } from './command-events.js';
import { definitionFor } from './tool-registry.js';
import {recoverProcessJobs} from './process-jobs.js';
import { addGoalUncertainty, goalOf, goalStatus, protectPlan, saveGoal } from './goals.js';
import type { RunState } from './runtime.js';
import type { Approval, ApprovalMode, Chat, ChatDetail, Message, Plan, Project, RunEvent, TestReport, FileChange, FileChangeStatus, FileChangeSummary, RoleModels, PlanStepRef, PlanEvidence, PlanStep } from '../shared/types.js';

const now = () => new Date().toISOString();
export class Store {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  private transactionEvents?: RunEvent[];
  private modelDefaults?: RoleModels;
  initializeModels(models: RoleModels) {
    this.transaction(() => {
      for (const chat of this.chats()) if (!chat.models) {
        this.db.prepare('UPDATE chats SET data=? WHERE id=?').run(JSON.stringify({...chat, models: {...models}}), chat.id);
      }
    });
    this.modelDefaults = {...models};
  }
  setModelDefaults(models: RoleModels) { this.modelDefaults = {...models}; }
  chatModels(chatId: string): RoleModels {
    const models = this.chat(chatId).models;
    if (!models) throw new Error('Chat model assignments have not been initialized');
    return models;
  }
  constructor(readonly filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    if(filename !== ':memory:' && existsSync(filename)) {
      const existing = new DatabaseSync(filename,{readOnly:true});
      try {
        const tables=existing.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        if(tables.length) {
          const marker=tables.some(t=>t.name==='state') ? existing.prepare("SELECT data FROM state WHERE key='prototype:protocol'").get() : undefined;
          if(marker?.data !== JSON.stringify('native-tools-v1')) throw new Error('Incompatible prototype profile. Select an explicitly fresh application home for native-tools-v1; existing data and project folders were preserved.');
        }
      } finally {existing.close();}
    }
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, chat_id TEXT NOT NULL REFERENCES chats(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id), type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_chat ON events(chat_id,id);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id,seq);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS test_reports (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file_changes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, snapshots TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS file_changes_project ON file_changes(project_id);
      CREATE TABLE IF NOT EXISTS install_requests (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chat_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS installs_project ON install_requests(project_id);
    `);
    this.setState('prototype:protocol','native-tools-v1');
    this.changes.setMaxListeners(100);
  }
  transaction<T>(fn: () => T): T {
    // Nested domain transitions participate in the same atomic transaction.
    if(this.transactionEvents)return fn();
    this.db.exec('BEGIN IMMEDIATE');
    const events: RunEvent[] = [];
    this.transactionEvents = events;
    let result: T;
    try { result = fn(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionEvents = undefined; }
    for (const event of events) this.emitEvent(event);
    return result;
  }
  getState<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT data FROM state WHERE key=?').get(key);
    return row ? JSON.parse(String(row.data)) as T : fallback;
  }
  recordFileChange(change: FileChange) {
    if (this.chat(change.chatId).projectId !== change.projectId) throw new Error('Change project ownership mismatch');
    const {before,after,destination,...summary} = change;
    this.db.prepare('INSERT INTO file_changes VALUES (?,?,?,?,?)').run(change.id,change.projectId,change.status,JSON.stringify({...summary,...(destination ? {destinationPath: destination.after.path} : {})}),JSON.stringify({before,after,...(destination ? {destination} : {})}));
  }
  fileChange(projectId: string, id: string): FileChange {
    const row = this.db.prepare('SELECT summary,snapshots,status FROM file_changes WHERE id=? AND project_id=?').get(id,projectId);
    if (!row) throw Object.assign(new Error('Recorded change not found'),{statusCode:404});
    return {...JSON.parse(String(row.summary)),...JSON.parse(String(row.snapshots)),status:String(row.status)};
  }
  fileChanges(projectId: string, limit = 101): FileChangeSummary[] {
    return this.db.prepare('SELECT summary,status FROM file_changes WHERE project_id=? ORDER BY rowid DESC LIMIT ?').all(projectId,limit).map(row=>({...JSON.parse(String(row.summary)),status:String(row.status)}));
  }
  transitionFileChange(id: string, from: FileChangeStatus, to: FileChangeStatus) {
    if (this.db.prepare('UPDATE file_changes SET status=? WHERE id=? AND status=?').run(to,id,from).changes !== 1) throw Object.assign(new Error('Recorded change state changed; refresh before continuing'),{statusCode:409});
  }
  setState(key: string, value: unknown) { this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value)); }
  projects(): Project[] { return this.db.prepare('SELECT data FROM projects ORDER BY rowid DESC').all().map(row => JSON.parse(String(row.data))); }
  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    return JSON.parse(String(row.data));
  }
  createProject(name: string, root: string): Project {
    const existing = this.db.prepare('SELECT data FROM projects WHERE root=?').get(root);
    if (existing) return JSON.parse(String(existing.data));
    const project = { id: randomUUID(), name, path: root, createdAt: now() };
    this.db.prepare('INSERT INTO projects VALUES (?,?,?)').run(project.id, root, JSON.stringify(project));
    return project;
  }
  removalError(projectId: string, message: string) {
    const project = {...this.project(projectId), removalError: message};
    this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(project),projectId);
  }
  private deleteChatRecords(chatId: string) {
    this.assertSkillRemovalSafe(this.chat(chatId).projectId);
    for(const row of this.db.prepare("SELECT key,data FROM state WHERE key LIKE 'skills:write:%' AND json_extract(data,'$.chatId')=?").all(chatId)) {
      const claim=JSON.parse(String(row.data)) as {id:string};
      this.db.prepare('DELETE FROM state WHERE key=? OR key=?').run(row.key,`skills:uncertain-event:${claim.id}`);
    }
    for (const table of ['messages','events','approvals','test_reports']) this.db.prepare(`DELETE FROM ${table} WHERE chat_id=?`).run(chatId);
    this.db.prepare("DELETE FROM file_changes WHERE json_extract(summary,'$.chatId')=?").run(chatId);
    // Run, plan, summary and archived context keys are scoped by exact chat ID.
    for (const row of this.db.prepare('SELECT key FROM state').all()) {
      if (String(row.key).split(':').includes(chatId)) this.db.prepare('DELETE FROM state WHERE key=?').run(row.key);
    }
    this.db.prepare('DELETE FROM chats WHERE id=?').run(chatId);
  }
  deleteChat(chatId: string) {
    this.chat(chatId);
    this.assertInstallRemovalSafe(this.chat(chatId).projectId);
    this.transaction(()=>this.deleteChatRecords(chatId));
  }
  deleteProject(projectId: string) {
    this.project(projectId);
    this.assertInstallRemovalSafe(projectId);
    this.assertSkillRemovalSafe(projectId);
    this.transaction(()=>{
      for (const chat of this.chats(projectId)) this.deleteChatRecords(chat.id);
      this.db.prepare('DELETE FROM file_changes WHERE project_id=?').run(projectId);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
    });
  }
  chats(projectId?: string): Chat[] {
    return (projectId ? this.db.prepare('SELECT data FROM chats WHERE project_id=?').all(projectId) : this.db.prepare('SELECT data FROM chats').all()).map(row => JSON.parse(String(row.data))).sort((a: Chat,b: Chat) => b.updatedAt.localeCompare(a.updatedAt));
  }
  assertSkillRemovalSafe(projectId:string) {
    const unresolved=this.db.prepare("SELECT state.key FROM state JOIN chats ON chats.id=json_extract(state.data,'$.chatId') WHERE state.key LIKE 'skills:write:%' AND chats.project_id=? AND json_extract(state.data,'$.status') IN ('recording','unknown') LIMIT 1").get(projectId);
    if(unresolved)throw Object.assign(new Error('An unresolved skill write or personal promotion retains evidence in this project. Removal cannot discard uncertainty; inspect the retained claim.'),{statusCode:409});
  }
  install(id: string): import('../shared/types.js').InstallRecord {
    const row = this.db.prepare('SELECT data FROM install_requests WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('Install request not found'), {statusCode:404});
    return JSON.parse(String(row.data));
  }
  installs(): import('../shared/types.js').InstallRecord[] {
    return this.db.prepare('SELECT data FROM install_requests ORDER BY rowid DESC').all().map(row=>JSON.parse(String(row.data)));
  }
  saveInstall(item: import('../shared/types.js').InstallRecord) {
    this.db.prepare('INSERT INTO install_requests VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(item.id,item.projectId,item.chatId,JSON.stringify(item));
  }
  assertInstallRemovalSafe(projectId: string) {
    if (this.installs().some(item=>item.projectId === projectId && (item.recoveryRequired || ['preparing','reviewing','pending','approved','authorizing','dispatching'].includes(item.state)))) throw Object.assign(new Error('Resolve system install requests and recovery before removing this project or its chats'), {statusCode:409});
  }
  chat(id: string): Chat {
    const row = this.db.prepare('SELECT data FROM chats WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('Chat not found'), { statusCode: 404 });
    return JSON.parse(String(row.data));
  }
  createChat(projectId: string, title: string, approvalMode: ApprovalMode): Chat {
    this.project(projectId);
    const chat: Chat = { id: randomUUID(), projectId, title, approvalMode, status: 'idle', mode: 'execute', modeVersion: 0, createdAt: now(), updatedAt: now(), ...(this.modelDefaults ? {models: {...this.modelDefaults}} : {}) };
    this.db.prepare('INSERT INTO chats VALUES (?,?,?)').run(chat.id, projectId, JSON.stringify(chat));
    return chat;
  }
  updateChat(id: string, patch: Partial<Pick<Chat,'title'|'approvalMode'|'status'|'mode'|'modeVersion'>>): Chat {
    const chat = { ...this.chat(id), ...patch, updatedAt: now() };
    this.db.prepare('UPDATE chats SET data=? WHERE id=?').run(JSON.stringify(chat), id);
    this.event(id, 'status', chat);
    return chat;
  }
  messages(chatId: string): Message[] { return this.db.prepare('SELECT data FROM messages WHERE chat_id=? ORDER BY seq').all(chatId).map(row => JSON.parse(String(row.data))); }
  message(chatId: string, role: Message['role'], content: string, metadata?: Record<string,unknown>): Message {
    const item: Message = { id: randomUUID(), chatId, role, content, createdAt: now(), ...(metadata ? { metadata } : {}) };
    this.db.prepare('INSERT INTO messages(id,chat_id,data) VALUES (?,?,?)').run(item.id, chatId, JSON.stringify(item));
    this.event(chatId, 'message', item);
    return item;
  }
  event(chatId: string, type: string, data: unknown): RunEvent {
    const createdAt = now();
    const result = this.db.prepare('INSERT INTO events(chat_id,type,data,created_at) VALUES (?,?,?,?)').run(chatId,type,JSON.stringify(data),createdAt);
    const event = { id: Number(result.lastInsertRowid), chatId, type, data, createdAt };
    if (this.transactionEvents) this.transactionEvents.push(event);
    else this.emitEvent(event);
    return event;
  }
  private emitEvent(event: RunEvent) {
    // Notifications follow persistence. A disconnected/throwing subscriber must
    // not turn a committed transition into an apparent rollback or block peers.
    // Durable events remain available for SSE replay.
    for(const channel of [event.chatId,'event'])for(const listener of this.changes.rawListeners(channel)) {
      try{listener.call(this.changes,event);}catch{/* Delivery failure is not an execution outcome. */}
    }
  }
  recentEvents(chatId: string, limit = 1000): RunEvent[] {
    return this.db.prepare('SELECT * FROM (SELECT * FROM events WHERE chat_id=? ORDER BY id DESC LIMIT ?) ORDER BY id').all(chatId,limit).map(row => ({ id:Number(row.id), chatId:String(row.chat_id), type:String(row.type), data:JSON.parse(String(row.data)), createdAt:String(row.created_at) }));
  }
  events(chatId: string, after = 0, limit = 2000): RunEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE chat_id=? AND id>? ORDER BY id LIMIT ?').all(chatId,after,limit).map(row => ({ id: Number(row.id), chatId: String(row.chat_id), type: String(row.type), data: JSON.parse(String(row.data)), createdAt: String(row.created_at) }));
  }
  approval(item: Approval): void {
    this.db.prepare('INSERT INTO approvals VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(item.id,item.chatId,JSON.stringify(item));
    this.event(item.chatId,'approval',item);
  }
  getApproval(id: string): Approval {
    const row = this.db.prepare('SELECT data FROM approvals WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('Approval not found'), { statusCode: 404 });
    return JSON.parse(String(row.data));
  }
  approvals(chatId: string): Approval[] { return this.db.prepare('SELECT data FROM approvals WHERE chat_id=? ORDER BY rowid').all(chatId).map(row => JSON.parse(String(row.data))); }
  invalidateApprovals(chatId: string): void {
    const run = this.getState<{frames:{pending?:{stage:string;approvalId?:string}}[]}>(`run:${chatId}`,{frames:[]});
    const prepared = new Set((run.frames ?? []).filter(frame=>frame.pending?.stage === 'prepared').map(frame=>frame.pending?.approvalId));
    for (const approval of this.approvals(chatId)) {
      if (approval.status === 'pending' || approval.status === 'approved' && prepared.has(approval.id)) this.approval({...approval,status:'stale'});
    }
  }
  initializePlanning() {
    this.transaction(() => {
      for (const chat of this.chats()) {
        if (!chat.mode) {
          const run = this.getState<RunState | null>(`run:${chat.id}`, null);
          this.updateChat(chat.id, {mode: run?.planOnly ? 'plan' : 'execute', modeVersion: 0});
        }
        const plan = this.plan(chat.id);
        if (plan.phases.length && !plan.id) this.revisePlan(chat.id, plan);
      }
    });
  }
  revisePlan(chatId: string, proposed: Plan): Plan {
    if (!this.transactionEvents) return this.transaction(() => this.revisePlan(chatId, proposed));
    const previous = this.plan(chatId);
    const structure = (plan: Plan) => JSON.stringify(plan.phases.map(p => ({id:p.id,title:p.title,steps:p.steps.map(s=>({id:s.id,title:s.title}))})));
    if (previous.id && structure(previous) === structure(proposed)) return previous;
    const plan: Plan = {id: previous.id ?? randomUUID(), version: (previous.version ?? 0) + 1,
      phases: proposed.phases.map(phase => ({id: phase.id, title: phase.title,
        steps: phase.steps.map(step => ({id: step.id, title: step.title, status: step.status === 'blocked' ? 'blocked' : 'pending'}))}))};
    this.setPlan(chatId, plan);
    protectPlan(this,chatId,plan);
    return plan;
  }
  planStep(chatId: string, ref: PlanStepRef): PlanStep | undefined {
    const plan = this.plan(chatId);
    if (plan.id !== ref.planId || plan.version !== ref.planVersion) return undefined;
    return plan.phases.find(p => p.id === ref.phaseId)?.steps.find(s => s.id === ref.stepId);
  }
  progress(chatId: string, ref: PlanStepRef | undefined, delegationId: string, status: PlanStep['status'], outcome: string, summary: string, sourceEventId?: number): void {
    if (!this.transactionEvents) return this.transaction(() => this.progress(chatId, ref, delegationId, status, outcome, summary, sourceEventId));
    if (!ref || !this.planStep(chatId, ref)) return;
    const plan = this.plan(chatId);
    const step = plan.phases.find(p => p.id === ref.phaseId)!.steps.find(s => s.id === ref.stepId)!;
    // An older delegation cannot overwrite a newer owner of the same step.
    if (outcome !== 'started' && step.evidence?.delegationId !== delegationId) return;
    const event = this.event(chatId, 'plan_progress', {...ref, delegationId, status, outcome, summary, sourceEventId});
    step.status = status;
    step.evidence = {eventId: event.id, delegationId, outcome, summary, ...(sourceEventId ? {sourceEventId} : {})} satisfies PlanEvidence;
    this.setPlan(chatId, plan);
  }
  plan(chatId: string): Plan { return this.getState(`plan:${chatId}`, { phases: [] }); }
  setPlan(chatId: string, plan: Plan) { this.setState(`plan:${chatId}`, plan); this.event(chatId,'plan',plan); }
  testReport(chatId: string, report: TestReport) {
    this.db.prepare('INSERT INTO test_reports VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(report.id,chatId,JSON.stringify(report));
    this.event(chatId,'tests',report);
  }
  detail(chatId: string): ChatDetail {
    const recent = this.recentEvents(chatId,1001);
    return { chat: this.chat(chatId), messages: this.messages(chatId), plan: this.plan(chatId), goal: goalOf(this,chatId), approvals: this.approvals(chatId), events: recent.slice(-1000), eventsTruncated:recent.length>1000, tests: this.db.prepare('SELECT data FROM test_reports WHERE chat_id=? ORDER BY rowid').all(chatId).map(row => JSON.parse(String(row.data))) };
  }
  recover():void {
    if(!this.transactionEvents)return this.transaction(()=>this.recover());
    recoverProcessJobs(this);
    this.db.prepare("UPDATE file_changes SET status='unknown' WHERE status IN ('recording','undoing')").run();
    for (const chat of this.chats()) {
      const run = this.getState<RunState|null>(`run:${chat.id}`,null);
      const goal=goalOf(this,chat.id);
      if(goal && ['running','waiting_for_approval'].includes(goal.status))goalStatus(this,chat.id,'paused','Backend restarted. Explicit resume is required; uncertain effects will not be replayed.');
      const uncertainInstalls=this.installs().filter(item=>item.chatId===chat.id && (item.recoveryRequired || ['authorizing','dispatching','uncertain'].includes(item.state)));
      const uncertainEffects=[...(run?.frames??[]).filter(frame=>frame.pending?.stage==='executing' && definitionFor(frame.pending.action.name).effect!=='read').map(frame=>({id:frame.pending!.id,installId:undefined as string|undefined})),...uncertainInstalls.map(item=>({id:item.id,installId:item.id}))];
      for(const effect of goal?uncertainEffects:[]) {
        const key=`goal-recovery:${chat.id}:${effect.id}`;
        let eventId=this.getState<number|null>(key,null);
        if(!eventId){eventId=this.event(chat.id,'goal_uncertainty',{installId:effect.installId,reason:'Backend restarted with a potentially modifying action dispatched; no automatic replay.'}).id;this.setState(key,eventId);}
        const current=goalOf(this,chat.id)!;
        const reason='Backend restarted during a possible effect. Inspect recorded uncertainty; goal resume cannot replay it.';
        if(!current.uncertainEventIds.includes(eventId) || current.status!=='blocked' || current.reason!==reason) {
          addGoalUncertainty(this,chat.id,current,[eventId]);current.status='blocked';current.reason=reason;saveGoal(this,chat.id,current);
        }
      }
      this.invalidateApprovals(chat.id);
      for(const frame of run?.frames ?? []) {
        if(frame.pending?.stage==='prepared' && frame.pending.action.name!=='recommend_packages') {frame.pending.stage='done';frame.pending.result={ok:false,output:'Backend restarted before dispatch; obsolete proposal was not executed.',data:{status:'not_started'}};}
        for(const call of [...(frame.queuedCalls ?? [])]) if(call.id!==frame.pending?.callId) {
          frame.messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({ok:false,output:'Backend restarted before dispatch; not executed.',data:{status:'not_started'}})});
          frame.queuedCalls=frame.queuedCalls!.filter(item=>item.id!==call.id);
        }
        this.setState(`native:frame:${chat.id}:${frame.id}`,frame.messages);
      }
      if(run)this.setState(`run:${chat.id}`,run);
      for (const frame of run?.frames ?? []) if (frame.planStep && (chat.status === 'running' || frame.pending?.stage === 'executing') && this.planStep(chat.id,frame.planStep)?.evidence?.outcome !== 'interrupted') {
        this.progress(chat.id,frame.planStep,frame.id,'blocked','interrupted','Backend restarted; unfinished work must be reconciled before completion.');
      }
      for (const frame of run?.frames ?? []) if (frame.pending?.stage === 'executing' && !frame.pending.commandOutcomeRecorded && isCommand(frame.pending.action)) {
        this.transaction(()=>{
          this.event(chat.id,'command',commandEvent(frame,frame.pending!,{ok:false,output:'Backend restarted during execution. Outcome is uncertain; this command will not be rerun automatically. Shell state was lost.',data:{uncertain:true,shellReset:true}}));
          frame.pending!.commandOutcomeRecorded = true;
          this.setState(`run:${chat.id}`,run);
        });
      }
    }
    for (const chat of this.chats()) if (chat.status === 'running' || chat.status === 'awaiting_approval') {
      this.updateChat(chat.id, { status: 'interrupted' });
      this.message(chat.id,'system','The backend restarted during this task. Resume will reconcile recorded actions; uncertain commands will not be rerun automatically.');
    }
  }
  close() { this.changes.removeAllListeners(); this.db.close(); }
}
