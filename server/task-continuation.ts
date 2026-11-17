import {z} from 'zod';
import type {PlanStepRef, TaskContinuation} from '../shared/types.js';
import {parseNativeJSON} from './native-json.js';
import {readPlanEvidence} from './plan-evidence.js';
import {reviewChange, reviewEvidence, reviewLimits} from './review-evidence.js';
import {toolRegistry} from './tool-registry.js';
import type {Frame, RunState} from './runtime.js';
import type {Store} from './store.js';
import {hash, safeRelative} from './tools/paths.js';

const runBytes = 2 * 1024 * 1024;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const uint = z.number().int().nonnegative();
const eventId = uint.positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const planRef = z.object({planId:id,planVersion:uint,phaseId:id,stepId:id});
const names = z.array(z.string().max(1024)).max(100);
const assignmentShape = z.object({objective:z.string().min(1).max(4096),acceptanceCriteria:names,paths:names,planStep:planRef});
const controlShape = z.strictObject({
  eventId, interruptionEventId:eventId.optional(), kind:z.enum(['pause','interrupt','restart','budget','resume']),
  frameId:id, generation:uint, binding:digest,
});
export type ContinuationControl = z.infer<typeof controlShape>;

const envelope = z.looseObject({
  frames:z.array(z.looseObject({id,role:z.enum(['architect','coder','critic'])})).max(16),
  generation:uint,planOnly:z.boolean(),steering:z.array(z.string()).max(1000),
});
const chatShape = z.looseObject({
  id,projectId:id,mode:z.literal('execute'),modeVersion:uint,
  status:z.enum(['idle','running','awaiting_approval','paused','interrupted','error']),
  approvalMode:z.string().max(32),models:z.record(z.string(),z.string().max(200)),
});
const unavailable = (reason: string): TaskContinuation => ({status:'unavailable', reason, evidence:[], partial:true});
export const continuationConflict = (reason:string) => Object.assign(new Error(reason),{statusCode:409});

function stateValue(store:Store,key:string,max:number) {
  return store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=? THEN data END AS data FROM state WHERE key=?").get(max,key);
}
function parsed<T>(schema:z.ZodType<T>,raw:unknown,max:number):T|undefined {
  if (typeof raw !== 'string') return;
  try { const result=schema.safeParse(parseNativeJSON(raw,max)); if(result.success) return result.data; }
  catch { /* Retain the unavailable state. */ }
}
function sameRef(a: PlanStepRef, b: PlanStepRef) {
  return a.planId===b.planId && a.planVersion===b.planVersion && a.phaseId===b.phaseId && a.stepId===b.stepId;
}
function explicitScope(paths: string[]) {
  try { return paths.length>0 && paths.every(path=>safeRelative(path)===path); }
  catch { return false; }
}

function hasScopedCoder(state:RunState,planningReadOnly=false) {
  const frame=Array.isArray(state.frames)?state.frames.at(-1):undefined;
  return frame?.role==='coder' && (Object.hasOwn(frame,'delegationEventId') ||
    !planningReadOnly && Boolean((frame.scope || frame.assignment?.paths) && (frame.planStep || frame.assignment?.planStep)));
}

function assignmentFrame(state:RunState) {
  const frame=state.frames.at(-1);
  if (frame?.role!=='coder' || state.frames.length!==2 || state.frames[0].role!=='architect') return;
  const cert=assignmentShape.safeParse(frame.assignment), ref=planRef.safeParse(frame.planStep);
  if(!cert.success || !ref.success || !explicitScope(cert.data.paths) || !sameRef(ref.data,cert.data.planStep) ||
     JSON.stringify(frame.scope)!==JSON.stringify(cert.data.paths) || state.planOnly) return;
  return {frame, ref:ref.data, assignment:cert.data};
}

function boundEvidence(store:Store,chatId:string,event:number,type:string,max:number) {
  return store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=? THEN data END AS data FROM events WHERE chat_id=? AND id=? AND type=?").get(max,chatId,event,type)?.data;
}

function stableBinding(store:Store,chatId:string,state:RunState) {
  const target=assignmentFrame(state);
  if(!target) return;
  const {frame,ref}=target;
  const row=store.db.prepare("SELECT project_id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=8192 THEN data END AS data FROM chats WHERE id=?").get(chatId);
  const chat=parsed(chatShape,row?.data,8192);
  if(!chat || chat.id!==chatId || chat.projectId!==row?.project_id) return;
  const project=store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=8192 THEN data END AS data FROM projects WHERE id=?").get(chat.projectId);
  const projectRecord=parsed(z.looseObject({id,path:z.string().max(4096),createdAt:z.string().max(64)}),project?.data,8192);
  if(projectRecord?.id!==chat.projectId || !eventId.safeParse(frame.delegationEventId).success ||
     !z.string().regex(/^-?\d+:-?\d+:-?\d+$/).safeParse(frame.continuationWorkspace).success) return;
  const delegated=parsed(z.looseObject({delegationId:id,planStep:planRef}),boundEvidence(store,chatId,frame.delegationEventId!,'delegation',8192),8192);
  if(delegated?.delegationId!==frame.id || !sameRef(delegated.planStep,ref)) return;
  const plan=readPlanEvidence(store.db,chatId,128*1024);
  if(plan.status!=='observed' || plan.outline.id!==ref.planId || plan.outline.version!==ref.planVersion || !Array.isArray(plan.outline.phases)) return;
  const phase=plan.outline.phases.find(item=>item?.id===ref.phaseId);
  const step=Array.isArray(phase?.steps) ? phase.steps.find((item: {id?: string})=>item?.id===ref.stepId) : undefined;
  if(step?.evidence?.delegationId!==frame.id || !eventId.safeParse(step.evidence.eventId).success) return;
  const humans=z.array(id).min(1).max(100).safeParse(state.humanMessageIds);
  if(!humans.success) return;
  const originalHuman=store.db.prepare(`SELECT count(*) AS count FROM json_each(?) ids
    JOIN messages m ON m.id=ids.value AND m.chat_id=?
    WHERE CASE WHEN typeof(m.data)='text' AND length(CAST(m.data AS BLOB))<=131072 AND queue_json_ok(m.data,131072)=1
      THEN json_extract(m.data,'$.role')='user' AND json_extract(m.data,'$.chatId')=m.chat_id AND json_extract(m.data,'$.id')=m.id END`)
    .get(JSON.stringify(humans.data),chatId);
  if(originalHuman?.count!==humans.data.length || new Set(humans.data).size!==humans.data.length) return;
  const skill=stateValue(store,'skills:selected:'+chatId,128*1024);
  if(skill && typeof skill.data!=='string') return;
  const goal=store.db.prepare("SELECT 1 FROM state WHERE key=?").get('goal:'+chatId);
  const queue=store.db.prepare("SELECT 1 FROM queue_links WHERE chat_id=?").get(chatId);
  const binding=hash(JSON.stringify([chatId,projectRecord.id,projectRecord.path,projectRecord.createdAt,
    state.frames[0].id,frame.id,frame.delegationEventId,frame.continuationWorkspace,state.generation,frame.assignment,frame.scope,ref,
    state.humanMessageIds,state.instructionsHash,state.instructionTargets,state.skillsHash,skill?.data,chat.modeVersion,chat.models,chat.approvalMode]));
  return {...target,chat,binding,held:Boolean(goal || queue || state.queueClaim || frame.assignment?.goal || projectRecord.removalError)};
}

export function recordContinuationControl(store:Store,chatId:string,state:RunState,kind:ContinuationControl['kind'],interruptionEventId?:number) {
  if (!hasScopedCoder(state)) return;
  const current=stableBinding(store,chatId,state);
  if(!current) {
    delete state.continuationControl;
    return;
  }
  const receipt={kind,frameId:current.frame.id,generation:state.generation,binding:current.binding,...(interruptionEventId?{interruptionEventId}:{})};
  const event=store.event(chatId,'task_continuation_control',{version:1,...receipt});
  state.continuationControl={eventId:event.id,...receipt};
}

function originalStatus(store:Store,chatId:string,frame:Frame,limit:number) {
  return reviewEvidence(store,chatId,[{role:'coder',id:frame.id,origin:null,ids:frame.evidenceEventIds}],frame.scope,undefined,limit);
}

export function observeContinuation(store:Store,chatId:string,includeEvidence=true,settingsBinding=''): {state?:RunState;view?:TaskContinuation;binding?:string} {
  const row=stateValue(store,'run:'+chatId,runBytes);
  if(!row) return {};
  const original=parsed(envelope,row.data,runBytes);
  if(!original) return {view:unavailable('Retained native run evidence is unavailable.')};
  const state=original as unknown as RunState;
  const planning=state.planOnly && store.db.prepare(`SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=8192
    AND json_valid(data) THEN json_extract(data,'$.mode')='plan' END AS planning FROM chats WHERE id=?`).get(chatId)?.planning===1;
  if(!hasScopedCoder(state,planning) && !Object.hasOwn(state,'continuationControl')) return {};
  const current=stableBinding(store,chatId,state);
  if(!current) return {view:unavailable('Original Coder assignment, delegation or Plan ownership could not be verified.')};
  if (!['paused','interrupted','error'].includes(current.chat.status)) return {view:{
    status:'blocked',reason:'Wait for the original assignment to stop.',evidence:[],partial:false,
  }};
  const {frame,ref,assignment,binding}=current;
  const control=controlShape.safeParse(state.continuationControl);
  const receipt=control.success ? parsed(
    controlShape.omit({eventId:true}).extend({version:z.literal(1)}),
    boundEvidence(store,chatId,control.data.eventId,'task_continuation_control',1024),1024,
  ) : undefined;
  const verified=control.success && receipt && receipt.kind===control.data.kind && receipt.kind!=='resume' &&
    receipt.generation===control.data.generation && receipt.generation===state.generation &&
    receipt.frameId===control.data.frameId && receipt.frameId===frame.id &&
    receipt.binding===control.data.binding && receipt.binding===binding;
  const clipped=includeEvidence ? originalStatus(store,chatId,frame,reviewLimits.rows) : undefined;
  const evidence:TaskContinuation['evidence']=[];
  const paths=new Set<string>();
  let evidenceBytes=0, omitted=false;
  for(const item of clipped?.receipts??[]) {
    const entry={eventId:item.id,tool:item.tool,path:item.path,destination:item.destination,changeId:item.changeId,
      report:item.report,status:item.status};
    const more=[...new Set([item.path,item.destination].filter((path):path is string=>!!path && !paths.has(path)))];
    const size=Buffer.byteLength(JSON.stringify(entry))+1;
    if(paths.size+more.length>8 || evidenceBytes+size>8*1024) {
      omitted=true;
      continue;
    }
    evidence.push(entry);
    evidenceBytes+=size;
    for(const path of more)paths.add(path);
  }
  const partial=Boolean(omitted || frame.evidenceWindowTruncated || clipped?.incomplete || evidence.some(item=>item.status==='unavailable'));
  const view:TaskContinuation={
    status:'unavailable',reason:'No exact current interruption receipt. Inspect retained work before fresh guidance.',
    frameId:frame.id,planStep:ref,objective:assignment.objective.slice(0,800),
    requirements:assignment.acceptanceCriteria.slice(0,8).map(text=>text.slice(0,256)),evidence,partial,
  };
  if(current.held || state.steering.length || state.frames.some(item=>item.pending || item.queuedCalls?.length) ||
     frame.acceptanceEvidence?.overflow || frame.acceptanceEvidence?.uncertainEventIds?.length || frame.evidenceWindowTruncated) {
    view.status='blocked';
    view.reason='Original work remains held, unsettled, uncertain or outside the evidence bound. Inspect its existing controls.';
    return {view};
  }
  if (!verified) {
    if(control.success) {
      view.status='stale';
      view.reason='The retained interruption no longer matches this assignment. Review current guidance.';
    }
    return {view};
  }
  view.interruptionEventId=control.data.eventId;
  const latest=store.db.prepare('SELECT MAX(id) AS id FROM events WHERE chat_id=?').get(chatId)?.id;
  view.status='available';
  view.reason='Resume will check the original assignment and current workspace before continuing.';
  view.precondition=hash(JSON.stringify([control.data,binding,settingsBinding,latest,current.chat.status,hash(String(row.data))]));
  return {state,view,binding};
}

export function continuationDispatchCurrent(store:Store,chatId:string,state:RunState,control:ContinuationControl) {
  const recorded=stateValue(store,'run:'+chatId,runBytes);
  if(recorded?.data!==JSON.stringify(state))return false;
  const receipt=parsed(controlShape.omit({eventId:true}).extend({version:z.literal(1)}),
    boundEvidence(store,chatId,control.eventId,'task_continuation_control',1024),1024);
  if(receipt?.kind!=='resume' || receipt.interruptionEventId!==control.interruptionEventId ||
     receipt.binding!==control.binding || receipt.generation!==control.generation || receipt.frameId!==control.frameId)return false;
  const binding=stableBinding(store,chatId,state);
  return binding && !binding.held && binding.chat.status==='running' && !state.steering.length &&
    binding.binding===control.binding && state.continuationControl?.eventId===control.eventId &&
    state.generation===control.generation;
}

/** Admission uses the full retained correlation window. Display clipping never
 * contributes to an authorization decision. */
export function assertContinuationEvidence(store:Store,chatId:string,state:RunState) {
  const start=performance.now();
  const frame=state.frames.at(-1)!;
  const projectId=store.chat(chatId).projectId;
  const original=originalStatus(store,chatId,frame,reviewLimits.receipts);
  if(original.incomplete || original.receipts.some(item=>item.status==='uncertain' || item.status==='unavailable'))
    throw continuationConflict('Original assignment effects are uncertain or their receipts are unavailable.');
  let snapshotBytes=0;
  for(const item of original.receipts) {
    if(item.status!=='succeeded' || !item.tool || !toolRegistry.get(item.tool)?.fileMutation) continue;
    if(performance.now()-start>=reviewLimits.ms || snapshotBytes>=reviewLimits.working)
      throw continuationConflict('Original file change evidence exceeded its observation budget.');
    const change=reviewChange(store,projectId,chatId,item);
    if(!change) throw continuationConflict('Original file change is unsettled or could not be verified.');
    snapshotBytes+=change.bytes;
  }
  if(snapshotBytes>reviewLimits.working ||
      store.db.prepare("SELECT 1 FROM file_changes WHERE project_id=? AND status IN ('recording','unknown','undoing') LIMIT 1").get(projectId))
    throw continuationConflict('Project file changes remain uncertain or exceed the evidence bound.');
  const completed=new Set(original.receipts.map(item=>item.id));
  const commands=new Map(original.receipts.filter(item=>item.commandId).map(item=>[item.commandId!,item.id]));
  // Detect damaged/omitted frame receipt pointers independently of the window.
  const rows=store.db.prepare(`WITH recent AS MATERIALIZED (
      SELECT id,type FROM events WHERE chat_id=? AND id>? ORDER BY id LIMIT 2049
    ), sizes AS MATERIALIZED (
      SELECT r.id,r.type,CASE WHEN typeof(e.data)='text' THEN length(CAST(e.data AS BLOB)) ELSE 1048577 END bytes
      FROM recent r JOIN events e ON e.id=r.id WHERE r.type IN ('tool','command','goal_uncertainty')
    ), budget AS MATERIALIZED (
      SELECT *,sum(bytes) OVER (ORDER BY id) total FROM sizes
    ), effects AS MATERIALIZED (
      SELECT b.id,b.type,CASE WHEN b.bytes<=1048576 AND b.total<=16777216 THEN
        CASE WHEN queue_json_ok(e.data,1048576)=1 THEN e.data END END data
      FROM budget b JOIN events e ON e.id=b.id
    )
    SELECT id,type,CASE WHEN NOT json_valid(data) THEN NULL
      WHEN length(json_extract(data,'$.agentId'))<=200 THEN json_extract(data,'$.agentId') END AS frame,
      CASE WHEN json_valid(data) AND length(json_extract(data,'$.commandId'))<=200 THEN json_extract(data,'$.commandId') END AS command,
      CASE WHEN data IS NULL OR NOT json_valid(data) THEN 'unavailable'
      WHEN type='tool' AND json_type(data,'$.result') IS NULL THEN 'dispatch'
      WHEN type='command' AND length(json_extract(data,'$.status'))<=32 THEN json_extract(data,'$.status') END AS status
      FROM effects
    UNION ALL SELECT 0,'overflow',NULL,NULL,NULL WHERE (SELECT count(*) FROM recent)>2048`).all(chatId,frame.delegationEventId!);
  if(rows.some(item=>item.type==='overflow' || item.type==='goal_uncertainty' || item.status==='unavailable' ||
      item.frame===frame.id && (item.type==='tool' && item.status!=='dispatch' ? !completed.has(Number(item.id))
        : item.status==='uncertain' || item.status==='interrupted' || !item.command || !commands.has(String(item.command)) ||
          item.status==='dispatch' && commands.get(String(item.command))!<=Number(item.id))))
    throw continuationConflict('Original dispatch history is uncertain, incomplete or exceeds the continuation limit.');
  const decisions=store.db.prepare(`SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=131072 THEN
      CASE WHEN json_valid(data) AND json_extract(data,'$.id')=id AND json_extract(data,'$.chatId')=chat_id
        AND json_extract(data,'$.status') IN ('approved','denied','stale') THEN 0 ELSE 1 END ELSE 1 END AS blocked
      FROM approvals WHERE chat_id=? LIMIT 257`).all(chatId);
  if(decisions.length>256 || decisions.some(item=>item.blocked!==0))
    throw continuationConflict('An original human decision is pending or unavailable.');
  if(performance.now()-start>=reviewLimits.ms)throw continuationConflict('Original evidence exceeded its observation budget.');
  return original.receipts.slice(-6).map(item=>({eventId:item.id,tool:item.tool,status:item.status,report:item.report}));
}
