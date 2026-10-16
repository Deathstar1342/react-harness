import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AgentRole, InstallRecord, InstallSettings, InstallSettingsView, PackageHelperDecision, PackageHelperRecord, PackageHelperTarget, ToolResult } from '../shared/types.js';
import type { RuntimeHooks } from './runtime.js';
import { Store } from './store.js';
import { PackageHelperClient, PackageHelperError, helperCanonical, helperProtocol } from './package-helper.js';
import { checkedRecord, targetSchema } from './install-validation.js';
import { packageRecommendation, reviewInstall } from './install-review.js';
import type { InstallRecoveryReceipt } from './goals.js';
import {reserveMutation} from './tools/mutations.js';
import {processBlocking,processRecords} from './process-jobs.js';

export type InstallHelper = Pick<PackageHelperClient,'prepare'|'authorize'|'execute'|'status'|'reconcile'> & {hello():Promise<{protocol:typeof helperProtocol;target:PackageHelperTarget}>};
const key = 'system-installs:v1';
const pendingStates = new Set(['preparing','reviewing','pending','approved','authorizing']);
const conflict = (message: string) => Object.assign(new Error(message), {statusCode:409});
const settingsPatch = z.object({ policy: z.enum(['ask','auto','ai']).optional(), reviewerModel: z.string().trim().min(1).max(200).regex(/^[^\s\x00-\x1f]+$/).optional(), revision: z.number().int().nonnegative() }).strict();

/** One trusted profile/backend owner. All mutations/dispatch claims are synchronous
 * SQLite boundaries; no await occurs between the final check and execute call. */
export class InstallService {
  private active = new Map<string,Promise<ToolResult|null>>();
  private recovering = new Set<string>();
  private controllers = new Map<string,AbortController>();
  private calls = new Set<Promise<unknown>>();
  private closing = false;
  constructor(readonly store: Store, critic: string, private complete: NonNullable<RuntimeHooks['complete']>, private connect: () => Promise<InstallHelper> = () => PackageHelperClient.connect(), private now = Date.now, private reviewTimeoutMs = 20000,private container?:{connect:(projectId:string,originalTarget?:PackageHelperTarget)=>Promise<InstallHelper>;available:()=>Promise<boolean>}) {
    if (!store.getState(key,null)) store.setState(key,{policy:'ask',reviewerModel:critic,revision:0});
    for (const item of store.installs()) {
      if (['dispatching','authorizing'].includes(item.state)) this.write({...item,state:'uncertain',recoveryRequired:true,code:'RESTART_REQUIRES_STATUS'});
      else if (pendingStates.has(item.state)) this.stale(item,'RESTART_REQUIRES_NEW_PREVIEW');
    }
  }
  settings(): InstallSettings { return this.store.getState<InstallSettings>(key,{policy:'ask',reviewerModel:'',revision:0}); }
  private track<T>(promise:Promise<T>):Promise<T> {
    const tracked=promise.finally(()=>this.calls.delete(tracked));this.calls.add(tracked);return tracked;
  }
  private write(item: InstallRecord) {
    item = {...item,updatedAt:this.now()};
    this.store.saveInstall(item);
    // Never publish a helper decision nonce or private transport state.
    if (this.store.chats().some(c=>c.id===item.chatId)) this.store.event(item.chatId,'install',{id:item.id,state:item.state,code:item.code});
    return item;
  }
  private stale(item: InstallRecord, code: string) {
    if (!pendingStates.has(item.state)) return;
    this.write({...item,state:'stale',code});
    this.controllers.get(item.id)?.abort();
    const approval = this.store.approvals(item.chatId).find(a=>a.id===item.id);
    if (approval && ['pending','approved'].includes(approval.status)) this.store.approval({...approval,status:'stale'});
    const chat=this.store.chats().find(c=>c.id===item.chatId);
    if(chat?.status==='awaiting_approval')this.store.updateChat(chat.id,{status:'paused'});
  }
  invalidate(chatId?: string, code = 'CONTEXT_CHANGED') {
    for (const item of this.store.installs()) if (!chatId || item.chatId===chatId) this.stale(item,code);
  }
  expire() {
    for (const item of this.store.installs()) if (item.expiresAt && this.now() >= item.expiresAt) this.stale(item,'PREVIEW_EXPIRED');
  }
  update(input: unknown): InstallSettings {
    if (this.closing) throw conflict('Backend is shutting down');
    const patch = settingsPatch.parse(input), old = this.settings();
    if (patch.revision !== old.revision) throw conflict('System install settings changed; reload before saving');
    if ((patch.policy ?? old.policy) === old.policy && (patch.reviewerModel ?? old.reviewerModel) === old.reviewerModel) return old;
    const next = {...old,...patch,revision:old.revision+1};
    this.store.transaction(()=>{this.store.setState(key,next);this.invalidate(undefined,'POLICY_CHANGED');});
    return next;
  }
  private async discover(projectId?:string,originalTarget?:PackageHelperTarget) {
    if (this.closing) throw conflict('Backend is shutting down');
    const client = await this.track(this.container?(projectId?this.container.connect(projectId,originalTarget):Promise.reject(new Error('Project target required'))):this.connect());
    if(this.closing)throw conflict('Backend is shutting down');
    const hello = await this.track(client.hello());
    if (hello.protocol !== helperProtocol) throw new Error('UNSUPPORTED_HELPER');
    const target:PackageHelperTarget = targetSchema.parse(hello.target);
    if (this.closing) throw conflict('Backend is shutting down');
    const settings = this.settings();
    if (!this.container && settings.target && helperCanonical(settings.target)!==helperCanonical(target)) {
      this.store.transaction(()=>{
        this.store.setState(key,{...settings,target,policy:'ask',revision:settings.revision+1});
        this.invalidate(undefined,'TARGET_CHANGED');
      });
    } else if (!this.container && !settings.target) this.store.setState(key,{...settings,target});
    return {client,target};
  }
  async view(): Promise<InstallSettingsView> {
    this.expire();
    if(this.container){const available=await this.container.available();return {...this.settings(),available,message:available?'Packages target each project execution container. Rebuild requires a new approved preview.':'Container install broker is unavailable; no host fallback.',scope:'project-execution-container'};}
    try { await this.discover(); return {...this.settings(),available:true,message:'Selected local Linux environment',scope:'current-profile-local-linux-target'}; }
    catch { return {...this.settings(),available:false,message:'System installs unavailable. A supported helper must be provisioned separately in the selected Linux environment.',scope:'current-profile-local-linux-target'}; }
  }
  history() { this.expire(); const all=this.store.installs();return {items:all.slice(0,100),truncated:all.length>100}; }
  create(id: string, chatId: string, frameId: string, role: AgentRole, generation: number, recommendation: unknown) {
    if (this.closing) throw conflict('Backend is shutting down');
    const chat = this.store.chat(chatId);
    if (chat.mode === 'plan' || role === 'critic') throw conflict('Planning and review cannot request system installs');
    if (this.store.installs().some(i=>(!this.container||i.projectId===chat.projectId)&&(i.recoveryRequired || i.state==='dispatching'))) throw conflict('A system install needs recovery or is still running');
    return this.write({id,chatId,projectId:chat.projectId,frameId,role,generation,modeVersion:chat.modeVersion ?? 0,recommendation:packageRecommendation.parse(recommendation),settings:this.settings(),state:'preparing',createdAt:this.now(),updatedAt:this.now(),code:'PREPARING',recoveryRequired:false});
  }
  private current(id: string, guard: () => boolean): InstallRecord {
    const item = this.store.install(id), chat = this.store.chat(item.chatId), settings=this.settings();
    if (this.closing || !pendingStates.has(item.state) || !guard() || chat.mode==='plan' || chat.modeVersion!==item.modeVersion || settings.revision!==item.settings.revision || settings.policy!==item.settings.policy || settings.reviewerModel!==item.settings.reviewerModel || !this.container && item.settings.target && helperCanonical(settings.target)!==helperCanonical(item.settings.target) || item.expiresAt && this.now()>=item.expiresAt || this.store.installs().some(other=>other.id!==id && (!this.container||other.projectId===item.projectId) && (other.recoveryRequired || other.state==='dispatching'))) {
      this.stale(item,item.expiresAt && this.now()>=item.expiresAt ? 'PREVIEW_EXPIRED':'CONTEXT_CHANGED');
      throw conflict('System install decision is stale; request a new preview');
    }
    return item;
  }
  decide(id: string, decision: 'approve'|'deny', guard: () => boolean) {
    const item = this.current(id,guard);
    if (item.state!=='pending') throw conflict('System install is no longer awaiting a decision');
    this.write({...item,state:decision==='approve'?'approved':'rejected',decision:{source:'human',outcome:decision==='approve'?'approve':'reject',reason:decision==='approve'?'User approved this exact preview.':'User denied this exact preview.',at:this.now()},code:decision==='approve'?'HUMAN_APPROVED':'HUMAN_REJECTED'});
    const approval=this.store.getApproval(id);
    this.store.approval({...approval,status:decision==='approve'?'approved':'denied'});
  }
  result(id: string): ToolResult {
    const item = this.store.install(id);
    return {ok:['succeeded','noop'].includes(item.state),output:`System install ${item.state}: ${item.code}.${item.decision?.outcome==='reject' ? ' '+item.decision.reason : ''}${item.recoveryRequired ? ' Outcome needs explicit status/reconciliation; do not retry installation.' : ''}`,data:{installId:id,state:item.state,recoveryRequired:item.recoveryRequired}};
  }
  advance(id: string, guard: () => boolean, signal: AbortSignal, refreshContext: () => Promise<unknown> = async()=>{}): Promise<ToolResult|null> {
    // A duplicate caller cannot start a second helper dispatch.
    if (this.active.has(id)) return Promise.reject(conflict('System install is already in progress'));
    const item=this.store.install(id);
    if(processRecords(this.store,item.projectId).some(processBlocking))return Promise.reject(conflict('A project process is active or uncertain.'));
    const reservation=reserveMutation(this.store.project(item.projectId).path);
    const promise = this.perform(id,guard,signal,refreshContext).finally(()=>{this.active.delete(id);reservation.release();});
    this.active.set(id,promise);return promise;
  }
  private async perform(id: string, guard: () => boolean, signal: AbortSignal, refreshContext: () => Promise<unknown>): Promise<ToolResult|null> {
    const controller=new AbortController();this.controllers.set(id,controller);
    const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const valid=()=>!controller.signal.aborted && guard();
    try {
      let item=this.store.install(id);
      if (!pendingStates.has(item.state)) return this.result(id);
      if (item.state==='preparing') {
        const {client,target}=await this.discover(item.projectId);
        item=this.current(id,valid);
        item=this.write({...item,settings:{...item.settings,target}});
        const record=checkedRecord(await this.track(client.prepare({requestId:id,targetId:target.id,manager:'apt',packages:item.recommendation.packages})),item);
        item=this.current(id,valid);
        if (!['prepared','noop'].includes(record.state)) throw new Error('INVALID_HELPER_EVIDENCE');
        item=this.write({...item,preview:record.preview,previewDigest:record.previewDigest,expiresAt:record.expiresAt});
        this.current(id,valid);
        if (record.state==='noop') { if(record.preview.packages.length)throw new Error(); this.write({...item,state:'noop',code:'ALREADY_INSTALLED'});return this.result(id); }
        if (!record.preview.packages.length) throw new Error('INVALID_HELPER_EVIDENCE');
        if (item.settings.policy==='auto') item=this.write({...item,state:'approved',code:'POLICY_APPROVED',decision:{source:'auto',outcome:'approve',reason:'Supported request passed deterministic policy.',at:this.now()}});
        else if (item.settings.policy==='ai') {
          this.write({...item,state:'reviewing',code:'REVIEWING'});
          const review=await reviewInstall(this.complete,item.settings.reviewerModel,item.preview!,item.recommendation.reason,controller.signal,this.reviewTimeoutMs);
          item=this.current(id,valid);
          item=this.write({...item,state:review.decision==='approve'?'approved':review.decision==='reject'?'rejected':'pending',code:review.decision==='approve'?'REVIEW_APPROVED':review.decision==='reject'?'REVIEW_REJECTED':'HUMAN_REQUIRED',decision:{source:'ai',outcome:review.decision,reason:review.reason,at:this.now()}});
          if (item.state==='rejected') return this.result(id);
        } else item=this.write({...item,state:'pending',code:'HUMAN_REQUIRED'});
        if (item.state==='pending') this.store.approval({id,chatId:item.chatId,agentId:item.frameId,action:{name:'recommend_packages',args:item.recommendation},inspection:{effect:'execute',risk:'elevated',description:`Install system packages in ${target.scope==='project-container'?'project execution container: ':''}${target.distribution} ${target.release}: ${item.recommendation.reason}`},status:'pending',createdAt:new Date(this.now()).toISOString(),install:item});
      }
      item=this.current(id,valid);
      if (item.state==='pending') return null;
      if (item.state!=='approved' || item.decision?.outcome!=='approve') throw conflict('Install has no current approval');
      // Refresh authenticated target before authorization; all awaits precede the
      // final durable claim. The helper independently checks package state again.
      const {client,target}=await this.discover(item.projectId);
      item=this.current(id,valid);
      if(helperCanonical(target)!==helperCanonical(item.settings.target))throw new Error('TARGET_CHANGED');
      const decision:PackageHelperDecision={requestId:id,previewDigest:item.previewDigest!,decisionNonce:randomBytes(32).toString('hex'),expiresAt:item.expiresAt!};
      this.write({...item,state:'authorizing',code:'AUTHORIZING'});
      const authorized=checkedRecord(await this.track(client.authorize(decision)),item);
      if(authorized.state!=='authorized'||helperCanonical(authorized.decision)!==helperCanonical(decision))throw new Error('INVALID_HELPER_EVIDENCE');
      await refreshContext();
      item=this.current(id,valid);
      // There must be NO await between this check, persistence, and invocation.
      this.write({...item,state:'dispatching',code:'RUNNING',recoveryRequired:true});
      const execution=this.track(client.execute(decision));
      const outcome=checkedRecord(await execution,item);
      if(!['succeeded','failed','uncertain'].includes(outcome.state))throw new Error('INVALID_HELPER_EVIDENCE');
      this.acceptOutcome(item,outcome,false);
      return this.result(id);
    } catch (error) {
      const item=this.store.install(id);
      if(item.state==='dispatching'||item.state==='authorizing') this.write({...item,state:'uncertain',recoveryRequired:true,code:'HELPER_REPLY_UNCERTAIN'});
      else if(pendingStates.has(item.state)) {
        if (!valid() || this.closing) this.stale(item,'CONTEXT_CHANGED');
        else this.write({...item,state:'failed',code:error instanceof PackageHelperError && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'HELPER_UNAVAILABLE_OR_UNSUPPORTED'});
      }
      return this.result(id);
    } finally {signal.removeEventListener('abort',abort);this.controllers.delete(id);}
  }
  private acceptOutcome(item:InstallRecord,record:PackageHelperRecord,reconciled:boolean) {
    const current=this.store.install(item.id);
    if(current.containerReceipt&&helperCanonical(current.containerReceipt)!==helperCanonical(record.containerReceipt??null))throw new Error('CONTAINER_LINEAGE_CHANGED');
    if(record.state==='succeeded' && (!record.reconciliation?.healthy || !record.reconciliation.matches))throw new Error('INVALID_HELPER_EVIDENCE');
    const state=record.state==='succeeded'?'succeeded':record.state==='failed'?'failed':record.state==='noop'?'noop':['prepared','authorized'].includes(record.state)?'stale':'uncertain';
    this.write({...this.store.install(item.id),state,code:record.code,containerReceipt:record.containerReceipt,reconciliation:record.reconciliation,recoveryRequired:state==='uncertain' && !(reconciled && record.reconciliation?.healthy)});
  }
  async recover(id: string, reconcile: boolean) {
    if(this.closing || this.active.has(id) || this.recovering.has(id))throw conflict('Wait for the active install operation to stop');
    const item=this.store.install(id);
    if(!['uncertain','failed','succeeded'].includes(item.state))throw conflict('This request does not need outcome recovery');
    if(processRecords(this.store,item.projectId).some(processBlocking))throw conflict('A project process is active or uncertain.');
    const reservation=reserveMutation(this.store.project(item.projectId).path);
    this.recovering.add(id);
    try {
      const {client,target}=await this.discover(item.projectId,item.settings.target);
      if(helperCanonical(target)!==helperCanonical(item.settings.target))throw conflict('Original Linux target is unavailable; retain its recovery history');
      const record=checkedRecord(await this.track(reconcile?client.reconcile(id):client.status(id)),item);
      this.store.transaction(()=>{
        const current=this.store.install(id);
        if(current.updatedAt!==item.updatedAt || current.state!==item.state || current.previewDigest!==item.previewDigest || helperCanonical(current.settings.target)!==helperCanonical(item.settings.target) || !this.container&&helperCanonical(this.settings().target)!==helperCanonical(target) || helperCanonical(current.recommendation)!==helperCanonical(item.recommendation))throw conflict('Install recovery binding changed before persistence');
        this.acceptOutcome(item,record,reconcile);
        const event=this.store.event(item.chatId,'install_reconciliation',{installId:id,method:reconcile?'reconcile':'status',state:record.state,healthy:record.reconciliation?.healthy===true,matches:record.reconciliation?.matches===true});
        const receipt:InstallRecoveryReceipt={...(record.containerReceipt?{containerReceipt:record.containerReceipt}:{}),installId:id,chatId:item.chatId,targetKey:helperCanonical(target),previewDigest:record.previewDigest,method:reconcile?'reconcile':'status',eventId:event.id,state:record.state,healthy:record.reconciliation?.healthy===true,matches:record.reconciliation?.matches===true};
        this.store.setState(`install-reconciliation:${id}`,receipt);
      });
      return this.store.install(id);
    } catch { throw conflict('Helper outcome is unavailable; original recovery gate is retained'); }
    finally {this.recovering.delete(id);reservation.release();}
  }
  beginClose() { if(this.closing)return;this.closing=true;this.invalidate(undefined,'BACKEND_SHUTDOWN'); }
  async close() {
    this.beginClose();
    await Promise.allSettled([...this.active.values()]);
    await Promise.allSettled([...this.calls]);
    if(this.recovering.size)throw conflict('Helper recovery calls are still draining');
    // Historical uncertainty is durable and gates next-start installs/deletion.
    // It is not a live local resource and must not prevent ordinary app closure.
  }
}
