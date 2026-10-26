import {validateNativeHistory} from './provider.js';
import {queueGoal,queueCompletedGoal} from './queue-goals.js';
import {assertQueueOriginalEvents,queueChat} from './queue-admission.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ApprovalMode,QueueView} from '../shared/types.js';
import type {Runtime,RunState,Frame} from './runtime.js';
import {goalOf} from './goals.js';
import {readProjectInstructions} from './project-instructions.js';
import {nativePrivateUnit} from './native-storage.js';
import {reserveMutation} from './tools/mutations.js';
import {parseNativeJSON} from './native-json.js';
import {QUEUE_LIMITS as L,readQueue,writeQueue,revokeQueue,queueError,queueText,queueDigest,queueEvidence,queueRoot,type QueueState,type QueueClaim} from './queue-state.js';
const revision=z.number().int().safe().nonnegative(),uuid=z.uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const queueStartInput=z.strictObject({expectedRevision:revision,scope:z.array(z.strictObject({id:uuid,revision:revision.positive(),digest:hash})).min(1).max(32)});
export const queueEditInput=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('add'),expectedRevision:revision,text:z.string().min(1).max(16000)}),
 z.strictObject({action:z.literal('edit'),expectedRevision:revision,taskId:uuid,text:z.string().min(1).max(16000)}),
 z.strictObject({action:z.literal('reorder'),expectedRevision:revision,order:z.array(uuid).max(32)}),
 z.strictObject({action:z.literal('cancel'),expectedRevision:revision,taskId:uuid}),
 z.strictObject({action:z.literal('pause'),expectedRevision:revision}),
]);
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Queue admission owns no tools or provider. Existing Runtime is the only executor. */
export class TaskQueue {
 readonly session=randomUUID();private stopped=false;private admitting=new Set<string>();private pending=new Set<Promise<unknown>>();
 constructor(readonly runtime:Runtime,readonly approval:()=>ApprovalMode,readonly assertRequests:(projectId:string)=>void=()=>{}){runtime.queue=this;}
 private get store(){return this.runtime.store;}
 private existing(projectId:string){return !!this.store.db.prepare('SELECT 1 AS yes FROM task_queues WHERE project_id=?').get(projectId);}
 private locate(chatId:string){
  const row=this.store.db.prepare("SELECT CASE WHEN typeof(project_id)='text' AND length(CAST(project_id AS BLOB))<=200 THEN project_id END project_id,CASE WHEN typeof(task_id)='text' AND length(CAST(task_id AS BLOB))<=200 THEN task_id END task_id,CASE WHEN typeof(claim_id)='text' AND length(CAST(claim_id AS BLOB))<=200 THEN claim_id END claim_id,CASE WHEN typeof(root_id)='text' AND length(CAST(root_id AS BLOB))<=200 THEN root_id END root_id FROM queue_links WHERE chat_id=?").get(chatId);
  if(!row)return null;if(!uuid.safeParse(row.project_id).success||!uuid.safeParse(row.task_id).success||!uuid.safeParse(row.claim_id).success)throw queueError('Queue link unavailable.',503);
  const projectId=String(row.project_id),q=readQueue(this.store,projectId),task=q.tasks.find(t=>t.id===row.task_id);
  if(!task?.claim||task.claim.id!==row.claim_id||task.claim.rootId!==row.root_id||task.claim.chatId!==chatId)throw queueError('Queue claim reference unavailable.',503);queueChat(this.store,chatId,projectId);return {q,task,projectId};
 }
 owns(chatId:string,state?:RunState){const found=this.locate(chatId);return !!found?.task&&(!state||state.queueClaim?.id===found.task.claim?.id&&state.frames[0]?.id===found.task.claim?.rootId);}
 view(projectId:string,cursor?:string):QueueView{return nativePrivateUnit(()=>{
  const q=readQueue(this.store,projectId);let offset=0;
  if(cursor){try{const c=z.strictObject({projectId:uuid,revision,offset:revision.max(32)}).parse(parseNativeJSON(Buffer.from(cursor,'base64url').toString('utf8'),1024));if(c.projectId!==projectId||c.revision!==q.revision||c.offset%16||c.offset>=q.tasks.length)throw Error();offset=c.offset;}catch{throw queueError();}}
  const entries=q.tasks.slice(offset,offset+16).map(t=>{const v=t.versions.at(-1)!;if(t.claim){queueChat(this.store,t.claim.chatId,projectId);const link=this.store.db.prepare("SELECT CASE WHEN typeof(project_id)='text' AND length(CAST(project_id AS BLOB))<=200 THEN project_id END project_id,CASE WHEN typeof(task_id)='text' AND length(CAST(task_id AS BLOB))<=200 THEN task_id END task_id,CASE WHEN typeof(claim_id)='text' AND length(CAST(claim_id AS BLOB))<=200 THEN claim_id END claim_id,CASE WHEN typeof(root_id)='text' AND length(CAST(root_id AS BLOB))<=200 THEN root_id END root_id FROM queue_links WHERE chat_id=?").get(t.claim.chatId);if(link?.project_id!==projectId||link.task_id!==t.id||link.claim_id!==t.claim.id||link.root_id!==t.claim.rootId)throw queueError('Queue link unavailable.',503);}return {id:t.id,revision:v.revision,text:v.original.trim(),digest:v.digest,status:t.status==='running'&&t.claim?.session!==this.session?'stopped' as const:t.status,reason:t.status==='running'&&t.claim?.session!==this.session?'Retained consumed claim after restart. Execution is not adopted or replayed.':t.reason,...(t.claim?{chatId:t.claim.chatId}:{})};});
  const restarted=q.tasks.some(t=>t.status==='running'&&t.claim?.session!==this.session),status=restarted||q.session!==this.session&&q.status==='running'?'paused':q.status;
  const result:QueueView={schema:'queue-v1',projectId,revision:q.revision,status,reason:restarted?'Backend restarted. Claimed outcomes require inspection; no replay or adoption.':status==='paused'&&q.status==='running'?'Backend restarted. Start is required; claimed tasks cannot be replayed.':q.reason,entries,total:q.tasks.length,nextCursor:offset+16<q.tasks.length?Buffer.from(JSON.stringify({projectId,revision:q.revision,offset:offset+16})).toString('base64url'):null,startScope:q.tasks.filter(t=>t.status==='pending').map(t=>({id:t.id,revision:t.versions.at(-1)!.revision,digest:t.versions.at(-1)!.digest})),limits:{tasks:32,textBytes:16000,page:16},activeTaskId:q.tasks.find(t=>t.status==='running'&&t.claim?.session===this.session)?.id??null};
  if(Buffer.byteLength(JSON.stringify(result))>L.pageBytes)throw queueError('Queue display capacity exceeded.',503);return result;
 });}
 edit(projectId:string,input:z.infer<typeof queueEditInput>){input=queueEditInput.parse(input);this.store.transaction(()=>{
  const q=readQueue(this.store,projectId);if(q.revision!==input.expectedRevision)throw queueError();
  if(input.action==='add'){if(q.tasks.length>=32)throw queueError('Queue retention capacity reached.');q.tasks.push({id:randomUUID(),versions:[queueText(input.text)],status:'pending',reason:'Waiting for explicit Start.'});}
  if(input.action==='edit'||input.action==='cancel'){const task=q.tasks.find(t=>t.id===input.taskId);if(!task||task.status!=='pending'||task.claim)throw queueError('Only an unclaimed pending task can be changed.');if(input.action==='cancel'){task.status='cancelled';task.reason='Cancelled by the user before admission.';}else{if(task.versions.length>=8)throw queueError('Task revision capacity reached.');task.versions.push({...queueText(input.text),revision:task.versions.length+1});}}
  if(input.action==='reorder'){if(input.order.length!==q.tasks.length||new Set(input.order).size!==q.tasks.length||input.order.some(id=>!q.tasks.some(t=>t.id===id)))throw queueError('Order must contain every retained task exactly once.');const oldClaimed=q.tasks.filter(t=>t.claim).map(t=>t.id);const ordered=input.order.map(id=>q.tasks.find(t=>t.id===id)!);if(!equal(oldClaimed,ordered.filter(t=>t.claim).map(t=>t.id))||ordered.some((t,i)=>t.claim&&q.tasks[i]?.id!==t.id))throw queueError('Claimed task positions are immutable.');q.tasks=ordered;}
  revokeQueue(q,input.action==='pause'?'Paused by the user. Active task continues; use its exact Cancel control to interrupt.':'Task list changed. Review the new order and Start explicitly.');writeQueue(this.store,q);
 });return this.view(projectId);}
 async start(projectId:string,input:z.infer<typeof queueStartInput>){input=queueStartInput.parse(input);if(this.stopped||this.admitting.has(projectId))throw queueError('Queue admission is already active.');
  this.store.transaction(()=>{const q=readQueue(this.store,projectId);if(q.revision!==input.expectedRevision||q.status==='running'&&q.session===this.session||!equal(input.scope,this.scope(q)))throw queueError();if(q.tasks.some(t=>t.claim&&t.status!=='accepted'))throw queueError('A retained task claim remains unresolved. It cannot be skipped, retried or replayed.');this.acceptanceBudget(projectId);for(const task of q.tasks)if(task.status==='accepted')this.checkAcceptance(q,task);this.runtime.assertQueueIdle(projectId);this.assertRequests(projectId);q.revision++;q.status='running';q.reason='Running the explicitly selected task order.';q.session=this.session;q.policyDigest=this.policy();q.scope=input.scope;writeQueue(this.store,q);});
  await this.admit(projectId);return this.view(projectId);
 }
 private policy(){return queueDigest(JSON.stringify([this.approval(),this.runtime.config.models]));}
 private scope(q:QueueState){return q.tasks.filter(t=>t.status==='pending').map(t=>({id:t.id,revision:t.versions.at(-1)!.revision,digest:t.versions.at(-1)!.digest}));}
 private async admit(projectId:string){if(this.admitting.has(projectId)||this.stopped)return;this.admitting.add(projectId);let reservation:ReturnType<typeof reserveMutation>|undefined;
  try{
   const before=readQueue(this.store,projectId);if(before.status!=='running'||before.session!==this.session)return;
   if(!before.scope.length){this.store.transaction(()=>{const q=readQueue(this.store,projectId);if(q.revision!==before.revision)throw queueError();q.status='completed';q.reason='All tasks in the explicit Start scope reached native acceptance.';q.revision++;writeQueue(this.store,q);});return;}
   this.acceptanceBudget(projectId);for(const task of before.tasks)if(task.status==='accepted')this.checkAcceptance(before,task);this.runtime.assertQueueIdle(projectId);this.assertRequests(projectId);reservation=reserveMutation(before.root);
   const guidance=await readProjectInstructions(this.runtime.tools,before.root);if(this.stopped)throw queueError('Backend closing.');
   // Do not hold a queue reservation into the runtime or its own mutation guard.
   reservation.release();reservation=undefined;
   let admission!:ReturnType<Runtime['prepareQueueTask']>;
   this.store.transaction(()=>{
    const q=readQueue(this.store,projectId);if(q.revision!==before.revision||q.status!=='running'||q.session!==this.session||q.policyDigest!==this.policy()||queueRoot(q.root)!==q.rootIdentity)throw queueError();
    const selected=q.scope[0],task=q.tasks.find(t=>t.id===selected.id),v=task?.versions.at(-1);if(!task||task.claim||task.status!=='pending'||!v||v.digest!==selected.digest||v.revision!==selected.revision)throw queueError();
    this.assertRequests(projectId);admission=this.runtime.prepareQueueTask(projectId,v.original.trim(),this.approval());
    admission.state.instructionsHash=guidance.hash;admission.state.skillsHash=this.runtime.skills.binding(admission.chatId);this.store.setState(`run:${admission.chatId}`,admission.state);
    const chat=this.store.chat(admission.chatId),goal=goalOf(this.store,admission.chatId);
    task.claim={id:randomUUID(),session:this.session,queueRevision:q.revision,textRevision:v.revision,digest:v.digest,chatId:chat.id,humanMessageId:admission.humanMessageId,rootId:admission.rootId,modeVersion:chat.modeVersion??0,approvalMode:chat.approvalMode,instructionsHash:guidance.hash,skillsHash:admission.state.skillsHash,...(goal?{goalId:goal.id,goalRevision:goal.revision,goalGeneration:goal.generation}:{}),stage:'claimed'};admission.state.queueClaim={projectId,taskId:task.id,id:task.claim.id};this.store.setState(`run:${chat.id}`,admission.state);this.store.db.prepare('INSERT INTO queue_links VALUES (?,?,?,?,?)').run(chat.id,projectId,task.id,task.claim.id,task.claim.rootId);task.status='running';task.reason='Single-use admission committed; this is not proof of execution or completion.';writeQueue(this.store,q);
   });
   // A failed final COMMIT leaves a consumed claim and publishes no runtime cache.
   this.store.transaction(()=>{this.verify(admission.chatId,admission.state,true);const {q,task}=this.locate(admission.chatId)!;task!.claim!.stage='dispatched';writeQueue(this.store,q);});
   this.runtime.publishQueueTask(admission);
  }catch(error){try{this.store.transaction(()=>{const q=readQueue(this.store,projectId);revokeQueue(q,'Admission stopped. Inspect original evidence; no claim is retried.');for(const t of q.tasks)if(t.status==='running'){t.status='stopped';t.reason='Admission or dispatch boundary unavailable; no replay.';}writeQueue(this.store,q);});}catch{/* Poison/COMMIT failure remains authoritative; no effects follow. */}throw error;
  }finally{reservation?.release();this.admitting.delete(projectId);}
 }
 private verify(chatId:string,state:RunState,initial=false){const found=this.locate(chatId);if(!found?.task?.claim)throw queueError('Original queue claim unavailable.',503);const {q,task}=found,c=task.claim!,v=task.versions.at(-1)!;
  const message=queueEvidence(this.store,'messages',c.humanMessageId,chatId,18000),chat=queueChat(this.store,chatId,q.projectId);
  const source=this.store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=1100000 AND queue_json_ok(data,1100000)=1 THEN data=? ELSE 0 END matches FROM state WHERE key=?").get(JSON.stringify(state),`run:${chatId}`);if(source?.matches!==1||!equal(state.queueClaim,{projectId:q.projectId,taskId:task.id,id:c.id}))throw queueError('Queue runtime source changed or is unavailable.');
  if(c.session!==this.session||this.stopped||queueRoot(q.root)!==q.rootIdentity||chat.projectId!==q.projectId||message.id!==c.humanMessageId||message.chatId!==chatId||message.role!=='user'||message.content!==v.original.trim()||queueDigest(String(message.content))!==v.canonicalDigest||!state.humanMessageIds?.includes(c.humanMessageId)||state.frames[0]?.id!==c.rootId||c.textRevision!==v.revision||c.digest!==v.digest)throw queueError('Original queue admission changed; no dispatch.');
  if(initial&&(q.status!=='running'||q.session!==this.session||chat.mode!=='execute'||state.planOnly||chat.modeVersion!==c.modeVersion||chat.approvalMode!==c.approvalMode||state.instructionsHash!==c.instructionsHash||this.runtime.skills.binding(chatId)!==c.skillsHash||!equal(chat.models,this.runtime.config.models)))throw queueError('Queue dispatch authorization changed.');return found;
 }
 beforeProvider(chatId:string,state:RunState){const found=this.locate(chatId);if(found?.task?.status==='accepted'&&!state.queueClaim&&state.frames[0]?.id!==found.task.claim?.rootId)return;if(!found?.task){if(state.queueClaim)throw queueError('Queue link unavailable.',503);return;}this.verify(chatId,state);if(found.task.claim?.stage!=='dispatched')throw queueError('Queue dispatch claim is unavailable.');const c=found.task.claim;if(state.instructionsHash!==c.instructionsHash||state.skillsHash!==this.runtime.skills.binding(chatId)||this.store.chat(chatId).mode!=='execute'||state.planOnly)throw queueError('Queue guidance, skills or execution mode changed before dispatch.');}
 accepted(chatId:string,state:RunState,rootId:string,callId:string,receipt:NonNullable<QueueClaim['receipt']>){const found=this.locate(chatId);if(!found?.task)return;const {q,task}=found,c=task.claim!;
  if(!['running','stopped'].includes(task.status)||c.stopKind==='failure'||c.stopKind==='cancel'||c.session!==this.session||state.frames[0]?.id!==rootId||c.rootId!==rootId||state.frames.length!==1||c.receipt)return;
  const result=queueEvidence(this.store,'state',`native:result:${chatId}:${rootId}:${callId}`);if(result.ok!==true)throw queueError('Original native acceptance unavailable.',503);
  if(receipt.kind==='goal'&&(receipt.goalId!==c.goalId||receipt.goalRevision!==c.goalRevision||receipt.goalGeneration===undefined))throw queueError('Original goal acceptance changed.');
  c.receipt=receipt;task.status='accepted';task.reason='Native acceptance recorded; reservation release is still required.';writeQueue(this.store,q);
 }
 waitingForHuman(chatId:string,frame:Frame,callId:string){const found=this.locate(chatId);if(!found?.task?.claim||found.task.claim.rootId!==frame.id||['failure','cancel'].includes(found.task.claim.stopKind??''))return;
  const result=queueEvidence(this.store,'state',`native:result:${chatId}:${frame.id}:${callId}`),last=frame.messages.at(-1),original=frame.messages.flatMap(m=>m.role==='assistant'?m.tool_calls??[]:[]).filter(c=>c.id===callId);
  if(result.ok!==true||result.output!=='Waiting for user information.'||last?.role!=='tool'||last.tool_call_id!==callId||original.length!==1||original[0].function.name!=='ask_user')throw queueError('Original human decision call unavailable.',503);found.task.claim.askUserCallId=callId;writeQueue(this.store,found.q);this.failed(chatId,'Waiting for an exact human answer. Future tasks require fresh Start.','decision');
 }
 failed(chatId:string,reason:string,kind:'decision'|'failure'|'cancel'='failure'){const found=this.locate(chatId);if(!found?.task)return;const {q,task}=found;const run=this.store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=1100000 AND queue_json_ok(data,1100000)=1 THEN CASE WHEN json_type(data,'$.queueClaim.id')='text' AND length(CAST(json_extract(data,'$.queueClaim.id') AS BLOB))=36 AND json_extract(data,'$.queueClaim.id')=? THEN 1 ELSE 0 END ELSE 0 END matches FROM state WHERE key=?").get(task.claim?.id??'',`run:${chatId}`);if(run?.matches!==1||task.status==='cancelled'||kind==='decision'&&['failure','cancel'].includes(task.claim?.stopKind??''))return;task.status='stopped';if(task.claim&&(!task.claim.stopKind||kind!=='decision'))task.claim.stopKind=kind;task.reason=reason.slice(0,256);revokeQueue(q,reason);writeQueue(this.store,q);}
 transition(chatId:string,state:RunState){const found=this.locate(chatId);if(!found?.task||state.queueClaim?.id!==found.task.claim?.id)return;const chat=queueChat(this.store,chatId,found.projectId),goal=queueGoal(this.store,chatId),root=state.frames.find(f=>f.id===found.task!.claim!.rootId),last=root?.messages.at(-1),askId=found.task.claim?.askUserCallId;
  const exactAsk=!!askId&&last?.role==='tool'&&last.tool_call_id===askId&&root?.messages.some(m=>m.role==='assistant'&&m.tool_calls?.some(c=>c.id===askId&&c.function.name==='ask_user'));
  if(['paused','error','awaiting_approval'].includes(chat.status)||goal&&['blocked','paused','waiting_for_user','waiting_for_approval'].includes(goal.status))this.failed(chatId,'Task stopped for a human decision, failure or unresolved evidence.',chat.status==='awaiting_approval'||goal?.status==='waiting_for_user'||chat.status==='paused'&&!goal&&exactAsk?'decision':'failure');
 }
 human(chatId:string){const projectId=this.store.chat(chatId).projectId;if(this.admitting.has(projectId))throw queueError('Queue admission is in progress.');if(!this.existing(projectId))return;
  const current=readQueue(this.store,projectId),active=current.tasks.find(t=>t.claim&&this.runtime.queueActive(t.claim.chatId));
  if(active?.claim?.chatId!==chatId&&active){this.intervention(projectId);throw queueError('Wait for the exact active queued task to stop before using another chat.');}
  this.intervention(projectId);
 }
 intervention(projectId:string){if(this.admitting.has(projectId))throw queueError('Queue admission is in progress.');if(!this.existing(projectId))return;this.store.transaction(()=>{const q=readQueue(this.store,projectId);if(q.status==='running'){revokeQueue(q,'Project intervention stopped future queue admissions.');writeQueue(this.store,q);}});}
 async cancel(projectId:string,input:{expectedRevision:number;taskId:string;chatId:string}){const parsed=z.strictObject({expectedRevision:revision,taskId:uuid,chatId:uuid}).parse(input);this.store.transaction(()=>{const q=readQueue(this.store,projectId),task=q.tasks.find(t=>t.id===parsed.taskId);if(q.revision!==parsed.expectedRevision||!task?.claim||task.claim.chatId!==parsed.chatId||task.claim.session!==this.session||task.status!=='running')throw queueError();task.status='stopped';task.claim.stopKind='cancel';task.reason='Exact active task cancelled by the user. Inspect original runtime effects.';revokeQueue(q,task.reason);writeQueue(this.store,q);});await this.runtime.control(parsed.chatId,'interrupt');return this.view(projectId);}
 private acceptanceBudget(projectId:string){
  assertQueueOriginalEvents(this.store,projectId);
  const budget=this.store.db.prepare("WITH links AS MATERIALIZED (SELECT CASE WHEN typeof(chat_id)='text' AND length(CAST(chat_id AS BLOB))<=200 THEN chat_id END chat_id,CASE WHEN typeof(root_id)='text' AND length(CAST(root_id AS BLOB))<=200 THEN root_id END root_id FROM queue_links WHERE project_id=? LIMIT 33),frames AS MATERIALIZED (SELECT CASE WHEN typeof(s.data)='text' AND length(CAST(s.data AS BLOB))<=1100000 THEN length(CAST(s.data AS BLOB)) ELSE 8388609 END bytes FROM links l LEFT JOIN state s ON s.key='native:frame:'||l.chat_id||':'||l.root_id) SELECT count(*) n,COALESCE(SUM(bytes),0) bytes FROM frames").get(projectId)!;
  if(Number(budget.n)>32||Number(budget.bytes)>8388608)throw queueError('Queue native reference observation capacity reached. Original history is retained.');
 }
 private checkAcceptance(q:QueueState,task:QueueState['tasks'][number]){
  const c=task.claim,r=c?.receipt;if(!c||!r||task.status!=='accepted')throw queueError('Original queue acceptance unavailable.',503);
  const chat=queueChat(this.store,c.chatId,q.projectId),v=task.versions.at(-1)!,human=queueEvidence(this.store,'messages',c.humanMessageId,c.chatId,18000),ev=queueEvidence(this.store,'events',r.eventId,c.chatId),result=queueEvidence(this.store,'state',`native:result:${c.chatId}:${c.rootId}:${r.callId}`);
  const resultSchema=z.strictObject({ok:z.literal(true),output:z.string().min(1).max(8192)});resultSchema.parse(result);
  if(r.kind==='native-root')z.strictObject({rootId:z.uuid(),callId:z.string().min(1).max(200)}).parse(ev);else z.strictObject({goalId:z.uuid(),goalRevision:z.number().safe().int().positive(),planId:z.string().min(1).max(200),planVersion:z.number().safe().int().positive(),modeVersion:z.number().safe().int().nonnegative(),reviewEventIds:z.array(z.number().safe().int().positive()).max(256)}).parse(ev);
  const event=this.store.db.prepare("SELECT CASE WHEN typeof(type)='text' AND length(CAST(type AS BLOB))<=64 THEN type END type FROM events WHERE id=? AND chat_id=?").get(r.eventId,c.chatId);
  if(chat.projectId!==q.projectId||human.id!==c.humanMessageId||human.role!=='user'||human.content!==v.original.trim()||result.ok!==true||r.kind==='native-root'&&(event?.type!=='queue_native_acceptance'||ev.rootId!==c.rootId||ev.callId!==r.callId)||r.kind==='goal'&&(event?.type!=='goal_completed'||ev.goalId!==r.goalId||ev.goalRevision!==r.goalRevision||queueCompletedGoal(this.store,c.chatId)?.completion?.eventId!==r.eventId||queueGoal(this.store,c.chatId)?.status!=='completed'||r.goalGeneration!==queueGoal(this.store,c.chatId)?.generation))throw queueError('Original native acceptance unavailable.',503);
  // Full native history stays private and is read only at admission/acceptance, never GET.
  const row=this.store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=1100000 THEN data END AS data FROM state WHERE key=?").get(`native:frame:${c.chatId}:${c.rootId}`);
  if(typeof row?.data!=='string')throw queueError('Native acceptance frame unavailable.',503);
  const frame=parseNativeJSON(row.data,1100000);if(!Array.isArray(frame)||frame.length>4096)throw queueError('Native acceptance frame unavailable.',503);
  validateNativeHistory(frame);
  const calls=frame.flatMap(m=>m.role==='assistant'&&Array.isArray(m.tool_calls)?m.tool_calls:[]).filter(call=>call.id===r.callId),answers=frame.filter(m=>m.role==='tool'&&m.tool_call_id===r.callId);
  if(calls.length!==1||calls[0].function?.name!==(r.kind==='goal'?'request_goal_completion':'submit_completion')||answers.length!==1||typeof answers[0].content!=='string'||!equal(parseNativeJSON(answers[0].content,8192),result))throw queueError('Native call/result correlation unavailable.',503);
 }
 async settled(chatId:string){if(this.stopped)return;const found=this.locate(chatId);if(!found?.task)return;const {q,task,projectId}=found;
  if(task.status!=='accepted'||!task.claim?.receipt){if(task.status==='running')this.store.transaction(()=>this.failed(chatId,'Runtime settled without original native acceptance. No task was skipped.'));return;}
  if(q.status!=='running'||q.session!==this.session)return;
  try{this.store.transaction(()=>{const current=readQueue(this.store,projectId),t=current.tasks.find(t=>t.id===task.id)!;if(current.revision!==q.revision||current.scope[0]?.id!==task.id||!t.claim?.receipt)throw queueError();this.runtime.assertQueueIdle(projectId);assertQueueOriginalEvents(this.store,projectId);this.checkAcceptance(current,t);t.reason='Native acceptance and reservation release observed.';current.scope.shift();writeQueue(this.store,current);});
   const job=this.admit(projectId);this.pending.add(job);try{await job;}finally{this.pending.delete(job);}
  }catch{try{this.store.transaction(()=>{const current=readQueue(this.store,projectId);revokeQueue(current,'Reservation release or acceptance could not be confirmed. Start explicitly after inspection.');writeQueue(this.store,current);});}catch{/* Never retry after poison. */}}
 }
 closing(){this.stopped=true;}
 async drain(){while(this.pending.size)await Promise.allSettled([...this.pending]);}
}
