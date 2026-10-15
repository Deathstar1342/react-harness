import {randomUUID} from 'node:crypto';
import type {Action, ApprovalMode, ProcessJob, ToolContext, ToolResult, ToolService} from '../shared/types.js';
import type {Store} from './store.js';
import type {RunState} from './runtime.js';
import {readProjectInstructions} from './project-instructions.js';
import {addGoalUncertainty, goalOf, invalidateGoal, saveGoal} from './goals.js';
import {reserveMutation, assertMutationIdle, mutationRootKey} from './tools/mutations.js';
import {parseToolArguments} from './tool-registry.js';

export const PROCESS_LIMITS={jobs:64,outputBytes:64_000,events:128,pageBytes:16_000,waitMs:1000} as const;
export interface ProcessOrigin {
  skillsHash?:string;
  projectId:string; chatId:string; frameId:string; callId:string; commandId:string;
  generation:number; modeVersion:number; instructionsHash:string|null; targets:string[];
  taskId:string;
  assignment?:string; plan?:{id:string;version:number};
  approvalId?:string; approvalMode:ApprovalMode;
  goal?:{id:string;revision:number;generation:number};
}
export interface ProcessRecord extends ProcessJob, ProcessOrigin {
  action:Action; outputEvents:number; dispatched:boolean; cancellationRequested?:boolean;
}
const nonterminal=(job:ProcessJob)=>job.status==='starting'||job.status==='running';
export const processBlocking=(job:ProcessJob)=>nonterminal(job)||job.status==='uncertain';
const stateKey=(id:string)=>`process-job:${id}`;
export function processRecords(store:Store,projectId?:string,chatId?:string):ProcessRecord[] {
  return store.db.prepare("SELECT data FROM state WHERE key LIKE 'process-job:%' AND (? IS NULL OR json_extract(data,'$.projectId')=?) AND (? IS NULL OR json_extract(data,'$.chatId')=?) ORDER BY rowid").all(projectId??null,projectId??null,chatId??null,chatId??null).map(row=>JSON.parse(String(row.data)));
}
function publicJob(record:ProcessRecord):ProcessJob {
  const {id,projectId,chatId,frameId,callId,commandId,status,createdAt,updatedAt,output,baseOffset,endOffset,truncated,exitCode,message}=record;
  return {id,projectId,chatId,frameId,callId,commandId,status,createdAt,updatedAt,output,baseOffset,endOffset,truncated,exitCode,message};
}
function lifecycle(store:Store,record:ProcessRecord) {
  return store.event(record.chatId,'command',{commandId:record.commandId,agentId:record.frameId,sessionId:record.id,role:'coder',action:record.action,processId:record.id,
    status:record.status==='starting'||record.status==='running'?'running':record.status==='not_started'?'failed':record.status,
    ...(record.exitCode===undefined?{}:{exitCode:record.exitCode}),output:record.output,truncated:record.truncated,message:record.message});
}
function recordUncertainty(store:Store,record:ProcessRecord,eventId:number) {
  const goal=goalOf(store,record.chatId);
  if(goal){addGoalUncertainty(store,record.chatId,goal,[eventId]);goal.status='blocked';goal.reason='Process effects were interrupted or uncertain. Status, cancellation and critic verdicts cannot establish rollback or verification.';saveGoal(store,record.chatId,goal);}
}
export function recoverProcessJobs(store:Store) {
  for(const record of processRecords(store))if(nonterminal(record)) {
    record.status='uncertain';record.message='Backend restarted with a claimed process. No process was adopted, signalled or replayed. Inspect retained evidence.';record.updatedAt=new Date().toISOString();
    store.setState(stateKey(record.id),record);
    recordUncertainty(store,record,lifecycle(store,record).id);
  }
}

/** Owns only authorized sandbox jobs. Completion callbacks store observations;
 * they never schedule models or mutate another frame's pending/native calls. */
export class ProcessJobs {
  private live=new Map<string,{controller:AbortController;promise:Promise<void>;owner:symbol;release:()=>void}>();
  private closing=false;
  private outputCarry=new Map<string,string>();
  constructor(private store:Store,private tools:ToolService,private secrets:()=>string[]=()=>[],private freshSkills?:(chatId:string)=>Promise<void>,private skillBinding?:(chatId:string)=>string) {}
  private get(id:string) {
    const record=this.store.getState<ProcessRecord|null>(stateKey(id),null);
    if(!record)throw new Error('Process handle is unavailable.');return record;
  }
  assertIdle(projectId:string,owner?:symbol) {
    const root=this.store.project(projectId).path;
    assertMutationIdle(root,owner);
    const blocker=processRecords(this.store,projectId).find(record=>processBlocking(record) && !(owner!==undefined && this.live.get(record.id)?.owner===owner));
    if(blocker)throw new Error(`Project process ${blocker.id} is ${blocker.status}; wait or inspect its recorded outcome before further mutation or completion.`);
  }
  assertQuiescent(projectId:string) {
    assertMutationIdle(this.store.project(projectId).path);
    if(processRecords(this.store,projectId).some(nonterminal))throw new Error('A process is still active; wait for its observed terminal outcome.');
  }
  guard(root:string,owner?:symbol) {
    const canonical=mutationRootKey(root);
    const project=this.store.projects().find(project=>mutationRootKey(project.path)===canonical);
    if(project)this.assertIdle(project.id,owner);
  }
  blockers(projectId:string,frameId?:string) {
    return processRecords(this.store,projectId).filter(record=>processBlocking(record)||(record.frameId===frameId&&record.status==='interrupted')).map(record=>`Process ${record.id}: ${record.status}; start is not verification and stop does not roll back effects.`);
  }
  private validate(record:ProcessRecord,owner:symbol) {
    const current=this.get(record.id),chat=this.store.chat(record.chatId),state=this.store.getState<RunState|null>(`run:${record.chatId}`,null),goal=goalOf(this.store,record.chatId);
    const frame=state?.frames.find(frame=>frame.id===record.frameId);
    if(state?.skillsHash!==record.skillsHash)throw new Error('Selected workflow binding changed before process dispatch.');
    if(record.skillsHash!==undefined&&this.skillBinding?.(record.chatId)!==record.skillsHash)throw new Error('Selected workflow revision changed before process dispatch.');
    const archived=this.store.getState<import('../shared/types.js').ModelMessage[]>(`native:frame:${record.chatId}:${record.frameId}`,[]);
    const native=archived.some(message=>message.role==='assistant'&&message.tool_calls?.some(call=>call.id===record.callId&&JSON.stringify(parseToolArguments(call.function.name,call.function.arguments))===JSON.stringify(record.action)));
    if(this.closing||current.status!=='starting'||current.dispatched||current.cancellationRequested||this.live.get(record.id)?.controller.signal.aborted||chat.projectId!==record.projectId||chat.mode==='plan'||chat.modeVersion!==record.modeVersion||chat.approvalMode!==record.approvalMode||!state||state.frames[0]?.id!==record.taskId||state.planOnly||state.generation!==record.generation||state.steering.length||!frame||!native||state.instructionsHash!==record.instructionsHash||['paused','interrupted','error'].includes(chat.status))throw new Error('Process authorization changed before command dispatch.');
    if(record.approvalId && this.store.getApproval(record.approvalId).status!=='approved')throw new Error('Process approval changed before dispatch.');
    const plan=this.store.plan(record.chatId);
    if(JSON.stringify(frame.assignment)!==record.assignment || record.plan&&(plan.id!==record.plan.id||plan.version!==record.plan.version))throw new Error('Process assignment or plan changed before dispatch.');
    if(record.goal && (!goal||goal.id!==record.goal.id||goal.revision!==record.goal.revision||goal.generation!==record.goal.generation))throw new Error('Process goal binding changed before dispatch.');
    this.assertIdle(record.projectId,owner);
  }
  start(origin:ProcessOrigin,action:Action):ToolResult {
    if(this.closing||!this.tools.closeCommandContext||this.tools.processLifecycle!=='sandbox-dispatch-v1')throw new Error('Trusted process dispatch and cleanup are unavailable.');
    this.assertIdle(origin.projectId);
    if(this.secrets().some(secret=>secret&&JSON.stringify(action).includes(secret)))throw new Error('Process command contains protected backend configuration.');
    if(processRecords(this.store,origin.projectId).length>=PROCESS_LIMITS.jobs)throw new Error('This project reached its 64 retained process handles. Resume does not reset this limit; retained evidence is not discarded. Use synchronous commands after all uncertain work is resolved.');
    const root=this.store.project(origin.projectId).path,reservation=reserveMutation(root);
    const id=randomUUID(),controller=new AbortController(),now=new Date().toISOString();
    const record:ProcessRecord={...origin,id,action,status:'starting',createdAt:now,updatedAt:now,output:'',baseOffset:0,endOffset:0,truncated:false,outputEvents:0,dispatched:false};
    try {this.store.transaction(()=>{this.assertIdle(origin.projectId,reservation.owner);this.store.setState(stateKey(id),record);lifecycle(this.store,record);});}
    catch(error){reservation.release();throw error;}
    const live={controller,owner:reservation.owner,release:reservation.release,promise:Promise.resolve()};
    this.live.set(id,live);
    // Start after publication of the private capability; never before claim COMMIT.
    live.promise=Promise.resolve().then(()=>this.run(record,live));
    void live.promise.catch(()=>{});
    return {ok:true,output:'Process claimed; command completion and verification are not established. Inspect status/output using this handle.',data:publicJob(record)};
  }
  private async run(record:ProcessRecord,live:{controller:AbortController;owner:symbol;release:()=>void}) {
    let acknowledged=false,cleanupConfirmed=false,result:ToolResult|undefined,persistenceFailed=false;
    const context:ToolContext={projectRoot:this.store.project(record.projectId).path,chatId:record.chatId,agentId:record.id,signal:live.controller.signal,mutationOwner:live.owner,
      prepareCommand:async()=>{this.validate(record,live.owner);const instructions=await readProjectInstructions(this.tools,context.projectRoot,record.targets);if(instructions.hash!==record.instructionsHash)throw new Error('Applicable guidance changed before process dispatch.');await this.freshSkills?.(record.chatId);this.validate(record,live.owner);},
      beforeCommand:()=>{this.store.transaction(()=>{this.validate(record,live.owner);const current=this.get(record.id);current.status='running';current.dispatched=true;current.updatedAt=new Date().toISOString();this.store.setState(stateKey(record.id),current);});acknowledged=true;},
      onOutput:output=>{if(persistenceFailed)return;try{this.output(record.id,output);}catch{persistenceFailed=true;live.controller.abort();}},
    };
    try {
      result=await this.tools.execute(context,{name:'run_shell',args:{...record.action.args,timeoutMs:record.action.args.timeoutMs??600_000}});
    } catch {result={ok:false,output:'Process executor failed; inspect retained claim.',data:{uncertain:acknowledged}};}
    try {await this.tools.closeCommandContext!(context);cleanupConfirmed=true;}catch{ /* durable uncertainty below retains ownership */ }
    if(!persistenceFailed)try{this.output(record.id,'',true);}catch{persistenceFailed=true;live.controller.abort();}
    const current=this.get(record.id),data=result?.data as {exitCode?:number;cancelled?:boolean;timedOut?:boolean;uncertain?:boolean;shellReset?:boolean;backgroundPids?:number[];error?:string;truncated?:boolean}|undefined;
    const interrupted=!!(data?.cancelled||data?.timedOut||live.controller.signal.aborted);
    const uncertain=current.status==='uncertain'||persistenceFailed||!cleanupConfirmed||!acknowledged&&(result?.ok||Number.isInteger(data?.exitCode))||acknowledged&&(data?.uncertain||data?.backgroundPids?.length||data?.shellReset&&!interrupted||!Number.isInteger(data?.exitCode)&&!interrupted);
    current.status=uncertain?'uncertain':!acknowledged?'not_started':interrupted?'interrupted':data?.exitCode===0&&result?.ok?'completed':'failed';
    current.exitCode=['completed','failed'].includes(current.status)&&Number.isInteger(data?.exitCode)?data!.exitCode:undefined;
    current.truncated ||= data?.truncated===true;
    current.message=current.status==='not_started'?'Command was not dispatched; no trusted dispatch acknowledgement.':current.status==='interrupted'?'Sandbox terminated after dispatch; completed effects were not rolled back.':current.status==='uncertain'?'Outcome or namespace cleanup is uncertain. No replay, automatic undo or status-based reconciliation is authorized.':`Observed command exit ${current.exitCode}; this is not a test report.`;
    current.updatedAt=new Date().toISOString();
    try {
      if(persistenceFailed)throw new Error('An earlier output persistence boundary failed.');
      this.store.transaction(()=>{this.store.setState(stateKey(record.id),current);const event=lifecycle(this.store,current);if(['uncertain','interrupted'].includes(current.status))recordUncertainty(this.store,current,event.id);if(acknowledged)invalidateGoal(this.store,record.chatId,'Process finished; inspect final source and obtain fresh verification/review.');});
    } catch {
      // Never transform a failed final COMMIT into success on a later callback.
      live.controller.abort();
      try {this.store.transaction(()=>{const retained=this.get(record.id);retained.status='uncertain';retained.message='Process persistence failed; retained claim cannot be replayed.';this.store.setState(stateKey(record.id),retained);recordUncertainty(this.store,retained,lifecycle(this.store,retained).id);});}catch{/* prior durable nonterminal claim blocks until restart */}
    } finally {
      this.outputCarry.delete(record.id);
      if(cleanupConfirmed){live.release();this.live.delete(record.id);}
    }
    if(!cleanupConfirmed)throw new Error('Process namespace cleanup was not confirmed; retain backend ownership.');
  }
  private output(id:string,text:string,final=false) {
    const secrets=this.secrets().filter(Boolean);
    text=(this.outputCarry.get(id)??'')+text;
    let cut=final?text.length:Math.max(0,text.length-Math.max(0,...secrets.map(secret=>secret.length-1)));
    for(const secret of secrets){let index=text.indexOf(secret);while(index!==-1){if(index<cut&&index+secret.length>cut)cut=index;index=text.indexOf(secret,index+1);}}
    this.outputCarry.set(id,text.slice(cut));text=text.slice(0,cut);
    for(const secret of secrets)text=text.split(secret).join('[redacted]');
    this.store.transaction(()=>{
      const current=this.get(id);if(!nonterminal(current))return;
      const bytes=Buffer.from(text),remaining=Math.max(0,PROCESS_LIMITS.outputBytes-Buffer.byteLength(current.output));
      // Retain a UTF-8 prefix, dropping an incomplete trailing codepoint.
      const bounded=bytes.subarray(0,remaining).toString('utf8').replace(/\uFFFD$/,'');
      current.output+=bounded;current.endOffset=Buffer.byteLength(current.output);current.truncated ||= bytes.length>remaining;
      if(bounded&&current.outputEvents<PROCESS_LIMITS.events){this.store.event(current.chatId,'tool_output',{agentId:current.frameId,commandId:current.commandId,sessionId:current.id,output:bounded,truncated:current.truncated});current.outputEvents++;}
      this.store.setState(stateKey(id),current);
    });
  }
  async observe(id:string,chatId:string,allowedFrames:string[],offset=0,limit:number=PROCESS_LIMITS.pageBytes,waitMs=0) {
    const authorize=()=>{const record=this.get(id);if(record.chatId!==chatId||!allowedFrames.includes(record.frameId))throw new Error('Process does not belong to this task or reviewed assignment.');return record;};
    let record=authorize();
    if(waitMs>0&&nonterminal(record)){await new Promise(resolve=>setTimeout(resolve,Math.min(waitMs,PROCESS_LIMITS.waitMs)));record=authorize();}
    const bytes=Buffer.from(record.output);if(offset<0||offset>bytes.length||!Number.isSafeInteger(offset))throw new Error('Output cursor is outside retained bytes.');
    if(offset<bytes.length&&(bytes[offset]&0xc0)===0x80)throw new Error('Output cursor must be a UTF-8 boundary.');
    let end=Math.min(bytes.length,offset+Math.min(limit,PROCESS_LIMITS.pageBytes));while(end>offset&&end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
    return {...publicJob(record),output:bytes.subarray(offset,end).toString('utf8'),nextOffset:end};
  }
  async cancel(id:string,chatId:string,frameId?:string) {
    const record=this.get(id);if(record.chatId!==chatId||frameId!==undefined&&record.frameId!==frameId)throw new Error('Cannot cancel another task/frame process.');
    if(!nonterminal(record))return publicJob(record);
    const live=this.live.get(id);if(!live)throw new Error('No live owned process; retained uncertainty cannot be cancelled or reconciled.');
    this.store.transaction(()=>{const current=this.get(id);current.cancellationRequested=true;this.store.setState(stateKey(id),current);});
    live.controller.abort();await live.promise;return publicJob(this.get(id));
  }
  stopChat(chatId:string) {for(const record of processRecords(this.store,undefined,chatId))if(nonterminal(record))this.live.get(record.id)?.controller.abort();}
  async drainChat(chatId:string) {await Promise.all(processRecords(this.store,undefined,chatId).flatMap(record=>{const live=this.live.get(record.id);return live?[live.promise]:[];}));}
  async close() {this.closing=true;for(const live of this.live.values())live.controller.abort();await Promise.all([...this.live.values()].map(live=>live.promise));}
}
