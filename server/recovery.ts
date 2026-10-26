import {createHash} from 'node:crypto';
import type {Store} from './store.js';
import type {RecoveryEntry,RecoveryStatus,RecoveryView,ChatStatus,GoalStatus,PlanStepRef} from '../shared/types.js';
import {toolRegistry,parseToolArguments} from './tool-registry.js';
import {helperCanonical} from './package-helper.js';

export const RECOVERY_LIMITS={events:500,installs:100,processes:64,calls:100,steps:100,entries:200,evidence:8,
  eventBytes:131072,recordBytes:131072,runBytes:2097152,sourceBytes:4194304} as const;
type Obj=Record<string,unknown>;
const object=(value:unknown):Obj=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Obj:{};
const identity=(value:unknown):string|undefined=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)?value:undefined;
const integer=(value:unknown):number|undefined=>Number.isSafeInteger(value)&&Number(value)>=0?Number(value):undefined;
const time=(value:unknown):string|null=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))?value:null;
const epochTime=(value:unknown):string|null=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<253402300800000?time(new Date(value).toISOString()):null;
const statuses=new Set<RecoveryStatus>(['completed','failed','not_started','running','uncertain','interrupted','unknown']);
const status=(value:unknown):RecoveryStatus=>statuses.has(value as RecoveryStatus)?value as RecoveryStatus:'unknown';
const toolName=(value:unknown)=>typeof value==='string'&&toolRegistry.has(value)?value:undefined;
const originalToolName=(value:unknown)=>{
  const fn=object(value),name=toolName(fn.name);if(!name||typeof fn.arguments!=='string'||Buffer.byteLength(fn.arguments)>RECOVERY_LIMITS.recordBytes)return;
  try{parseToolArguments(name,fn.arguments);return name;}catch{return;}
};
const operationKey=(frameId:string,kind:'command'|'call',id:string)=>JSON.stringify([frameId,kind,id]);
const nonDispatchStatus=(result:Obj):RecoveryStatus=>{
  const data=object(result.data);
  if(data.uncertain===true||data.recoveryRequired===true||data.cancelled===true||data.timedOut===true||data.shellReset===true||data.exitCode!==undefined||['uncertain','authorizing','dispatching','succeeded'].includes(String(data.state))||result.ok!==false)return 'uncertain';
  return data.status==='not_started'?'not_started':'unknown';
};
const ref=(value:unknown):PlanStepRef|undefined=>{const v=object(value),planId=identity(v.planId),phaseId=identity(v.phaseId),stepId=identity(v.stepId),planVersion=integer(v.planVersion);return planId&&phaseId&&stepId&&planVersion?{planId,phaseId,stepId,planVersion}:undefined;};
const parse=(value:unknown,max:number):Obj|undefined=>{
  if(typeof value!=='string'||Buffer.byteLength(value)>max)return;
  try{const result=JSON.parse(value);return result&&typeof result==='object'&&!Array.isArray(result)?result:undefined;}catch{return;}
};
const missing=()=>Object.assign(new Error('Recovery evidence is unavailable for this chat.'),{statusCode:404});

/** A deferred, read-only SQLite snapshot. Never calls Store recovery/transaction,
 * Runtime, install history (which expires decisions), or a host/worker/helper. */
export function recoveryView(store:Store,chatId:string):RecoveryView {
  if(!identity(chatId))throw missing();
  store.db.exec('SAVEPOINT recovery_observation');
  try {
    const result=observe(store,chatId);
    store.db.exec('RELEASE recovery_observation');
    return result;
  }catch(error){store.db.exec('ROLLBACK TO recovery_observation');store.db.exec('RELEASE recovery_observation');
    if((error as {statusCode?:number})?.statusCode===404)throw missing();
    throw Object.assign(new Error('Recovery evidence could not be read. Refresh to try observation again.'),{statusCode:503});
  }
}

function observe(store:Store,chatId:string):RecoveryView {
  const coverage:RecoveryView['coverage']=[];
  const cover=(source:string,limit:number,truncated=false)=>{const item={source,limit,truncated,unavailable:0};coverage.push(item);return item;};
  // Both SQL-returned bytes and JSON parsing are bounded. Never return an
  // oversized raw record to JavaScript, even on an error path.
  const state=(key:string,max:number,source:string):Obj|undefined=>{
    const c=cover(source,1),row=store.db.prepare('SELECT CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data FROM state WHERE key=?').get(max,key);
    if(!row)return;
    const value=parse(row.data,max);if(!value)c.unavailable++;return value;
  };
  const chatRow=store.db.prepare('SELECT project_id,CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data FROM chats WHERE id=?').get(RECOVERY_LIMITS.recordBytes,chatId);
  const chat=parse(chatRow?.data,RECOVERY_LIMITS.recordBytes),projectId=identity(chatRow?.project_id);
  if(!chat||!projectId||chat.id!==chatId||chat.projectId!==projectId)throw missing();
  if(!store.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))throw missing();
  const chatStatus:ChatStatus|'unknown'=['idle','running','awaiting_approval','paused','interrupted','error'].includes(String(chat.status))?chat.status as ChatStatus:'unknown';
  const chatState:RecoveryView['chat']={status:chatStatus,mode:chat.mode==='plan'?'plan':chat.mode==='execute'?'execute':'unknown',modeVersion:integer(chat.modeVersion)??null,updatedAt:time(chat.updatedAt)};
  if(chatState.status==='unknown'||chatState.mode==='unknown'||chatState.modeVersion===null||!chatState.updatedAt)cover('chat',1).unavailable++;
  const entries=new Map<string,RecoveryEntry>();
  const make=(id:string,kind:RecoveryEntry['kind'],label:string,s:RecoveryStatus,reason:string,destination:RecoveryEntry['destination'],updatedAt:string|null=null):RecoveryEntry=>
    ({id,kind,label,status:s,reason,destination,updatedAt,evidence:[],evidenceTruncated:false});
  const eventEvidence=(entry:RecoveryEntry,id:unknown,at:unknown)=>{
    const n=integer(id);if(n&& !entry.evidence.some(e=>e.eventId===n)){entry.evidence.push({eventId:n,at:time(at)});entry.evidence.sort((a,b)=>b.eventId-a.eventId);if(entry.evidence.length>RECOVERY_LIMITS.evidence){entry.evidence.pop();entry.evidenceTruncated=true;}}
  };
  const latest=store.db.prepare('SELECT MAX(id) AS id FROM events WHERE chat_id=?').get(chatId);
  const eventCoverage=cover('events',RECOVERY_LIMITS.events);
  // Window budget applies before materializing JSON. Invalid/large records stay
  // as unavailable rows and never disappear into a misleading empty history.
  const eventRows=store.db.prepare(`WITH recent AS (
    SELECT id,type,created_at,data,length(CAST(data AS BLOB)) AS bytes FROM events WHERE chat_id=? AND type IN ('command','tool') ORDER BY id DESC LIMIT ?
  ), bounded AS (SELECT *,SUM(CASE WHEN bytes<=? THEN bytes ELSE 0 END) OVER(ORDER BY id DESC) AS total FROM recent)
  SELECT id,type,created_at,CASE WHEN bytes<=? AND total<=? THEN data END AS data FROM bounded ORDER BY id DESC`).all(chatId,RECOVERY_LIMITS.events+1,RECOVERY_LIMITS.eventBytes,RECOVERY_LIMITS.eventBytes,RECOVERY_LIMITS.sourceBytes);
  eventCoverage.truncated=eventRows.length>RECOVERY_LIMITS.events;
  // Visit newest first; never let an older/out-of-order outcome replace a later
  // uncertainty or conflict. Retain earlier IDs without projecting raw payloads.
  const commandEvidence=new Map<string,RecoveryEntry>();
  for(const row of eventRows.slice(0,RECOVERY_LIMITS.events)){
    const data=parse(row.data,RECOVERY_LIMITS.eventBytes),frameId=identity(data?.agentId),commandId=identity(data?.commandId),callId=identity(data?.toolCallId);
    if(!data||!frameId||(!commandId&&!callId)){eventCoverage.unavailable++;continue;}
    const name=toolName(object(data.action).name),key=operationKey(frameId,commandId?'command':'call',(commandId??callId)!);
    const previous=entries.get(key);
    const command=row.type==='command';
    let outcome=command?status(data.status):'unknown' as RecoveryStatus;
    if(command&&(!name||!toolRegistry.get(name)?.command))outcome='unknown';
    if(command && outcome==='completed' && data.exitCode!==0)outcome='unknown';
    if(command && outcome==='failed' && (!Number.isInteger(data.exitCode)||data.exitCode===0))outcome='unknown';
    if(command && outcome==='not_started' && (data.exitCode!==undefined||data.cancelled===true||data.timedOut===true||data.shellReset===true))outcome='unknown';
    if(command && (data.cancelled===true||data.timedOut===true) && outcome==='completed')outcome='uncertain';
    if(command && (data.uncertain===true||data.recoveryRequired===true))outcome='uncertain';
    const result=object(data.result),resultData=object(result.data);
    if(!command && 'result' in data){outcome=resultData.uncertain===true||resultData.recoveryRequired===true?'uncertain':resultData.status==='not_started'?nonDispatchStatus(result):name&&typeof result.ok==='boolean'?(toolRegistry.get(name)?.command?'unknown':result.ok?'completed':'failed'):'unknown';}
    if(!previous){
      const entry=make(key,command?'command':'tool',name??'Recorded operation',outcome,command?'Recorded command outcome; running is not a liveness check.':'Recorded tool result; missing command exit evidence stays unknown.','terminal',time(row.created_at));
      if(command&&data.truncated===true)entry.outputTruncated=true;
      Object.assign(entry,{frameId,...(commandId?{commandId}:{}),...(callId?{callId}:{})});eventEvidence(entry,row.id,row.created_at);entries.set(key,entry);
      if(command)commandEvidence.set(key,entry);
    }else{
      eventEvidence(previous,row.id,row.created_at);
      if(command&&data.truncated===true)previous.outputTruncated=true;
      if(command){
        if(!commandEvidence.has(key)){
          // A generic tool result cannot replace command lifecycle authority.
          previous.kind='command';previous.status=outcome;previous.reason='Recorded command lifecycle governs the outcome.';commandEvidence.set(key,previous);
        }else if(outcome==='uncertain'||outcome==='interrupted'){
          if(previous.status!==outcome) {previous.status='uncertain';previous.reason='Conflicting or earlier uncertain command evidence remains unresolved.';}
        }else if(outcome!=='running'&&previous.status!==outcome){previous.status='uncertain';previous.reason='Conflicting command outcomes; inspect original evidence.';}
      }else if(outcome==='uncertain'){previous.status='uncertain';previous.reason='Recorded tool uncertainty remains unresolved.';}
    }
  }
  const legacyCoverage=cover('legacy output',RECOVERY_LIMITS.events);
  const legacyRows=store.db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB))<=? THEN CASE WHEN json_valid(data) THEN
    json_type(data,'$.commandId')='text' AND json_type(data,'$.agentId')='text' ELSE 0 END ELSE 0 END AS correlated
    FROM events WHERE chat_id=? AND type='tool_output' ORDER BY id DESC LIMIT ?`).all(RECOVERY_LIMITS.eventBytes,chatId,RECOVERY_LIMITS.events+1);
  legacyCoverage.truncated=legacyRows.length>RECOVERY_LIMITS.events;
  legacyCoverage.unavailable=legacyRows.slice(0,RECOVERY_LIMITS.events).filter(row=>row.correlated!==1).length;
  const run=state(`run:${chatId}`,RECOVERY_LIMITS.runBytes,'run');
  const callCoverage=cover('calls',RECOVERY_LIMITS.calls);
  const originalHuman=(id:string)=>store.db.prepare("SELECT 1 FROM messages WHERE id=? AND chat_id=? AND CASE WHEN length(CAST(data AS BLOB))<=? THEN CASE WHEN json_valid(data) THEN json_extract(data,'$.role')='user' ELSE 0 END ELSE 0 END").get(id,chatId,RECOVERY_LIMITS.recordBytes);
  const humanMessageIds:string[]=[];
  if(run){
    if(!Array.isArray(run.frames))callCoverage.unavailable++;
    if(Array.isArray(run.humanMessageIds))for(const raw of run.humanMessageIds.slice(0,100)){
      const id=identity(raw);if(id&&originalHuman(id))humanMessageIds.push(id);
    }
    if(Array.isArray(run.humanMessageIds)&&run.humanMessageIds.length>100)callCoverage.truncated=true;
    let count=0;
    const frames=Array.isArray(run.frames)?run.frames:[];if(frames.length>100)callCoverage.truncated=true;
    for(const rawFrame of frames.slice(0,100)){
      const frame=object(rawFrame),frameId=identity(frame.id);if(!frameId){callCoverage.unavailable++;continue;}
      const originals=new Map<string,{name:string|undefined;count:number}>();
      const results=new Map<string,Obj[]>();
      for(const message of (Array.isArray(frame.messages)?frame.messages:[]).map(object)){
        if(message.role==='tool'){const id=identity(message.tool_call_id),result=parse(message.content,RECOVERY_LIMITS.recordBytes);if(id&&result)results.set(id,[...(results.get(id)??[]).slice(0,1),result]);}
        if(message.role==='assistant')for(const call of (Array.isArray(message.tool_calls)?message.tool_calls:[]).map(object)){
        const id=identity(call.id);if(id)originals.set(id,{name:originalToolName(call.function),count:(originals.get(id)?.count??0)+1});
      }}
      const original=(id:string|undefined,name?:string)=>!!id&&originals.get(id)?.count===1&&!!originals.get(id)?.name&&(!name||originals.get(id)?.name===name);
      const pending=object(frame.pending),commandId=identity(pending.id),callId=identity(pending.callId),name=toolName(object(pending.action).name);
      if(commandId){
        if(++count>RECOVERY_LIMITS.calls){callCoverage.truncated=true;break;}
        const key=operationKey(frameId,'command',commandId),result=object(pending.result),rd=object(result.data);
        let s:RecoveryStatus=rd.uncertain===true||rd.recoveryRequired===true?'uncertain':pending.stage==='prepared'?'not_started':pending.stage==='executing'?(chatStatus==='running'?'running':'uncertain'):pending.stage==='done'?(rd.status==='not_started'?nonDispatchStatus(result):name&&toolRegistry.get(name)?.command?'unknown':typeof result.ok==='boolean'?(result.ok?'completed':'failed'):'unknown'):'unknown';
        const nativeResults=callId?results.get(callId)??[]:[];
        if(nativeResults.length>1||nativeResults.length&&pending.stage!=='done'||nativeResults.some(result=>object(result.data).uncertain===true||object(result.data).recoveryRequired===true)||rd.status==='not_started'&&nativeResults.some(result=>nonDispatchStatus(result)!=='not_started'))s='uncertain';
        if(!original(callId,name)){s='unknown';callCoverage.unavailable++;}
        const old=entries.get(key);
        if(old){if(s==='uncertain' || old.status==='unknown')old.status=s==='completed'&&toolRegistry.get(name??'')?.command?'unknown':s;else if(s==='not_started'&&old.status!=='not_started'){old.status='uncertain';old.reason='Dispatch-stage evidence conflicts with the recorded outcome.';}old.callId=callId;}
        else {const entry=make(key,'tool',name??'Pending operation',s,'Durable dispatch stage. No original timestamp/event was retained for this stage.','controls');Object.assign(entry,{frameId,commandId,...(callId?{callId}:{})});entries.set(key,entry);}
      }
      for(const rawCall of Array.isArray(frame.queuedCalls)?frame.queuedCalls:[]){
        const call=object(rawCall),id=identity(call.id);if(id===callId)continue;
        if(++count>RECOVERY_LIMITS.calls){callCoverage.truncated=true;break;}
        if(!id){callCoverage.unavailable++;continue;}
        const key=operationKey(frameId,'call',id);
        if(!entries.has(key)){const valid=original(id,toolName(object(call.function).name));if(!valid)callCoverage.unavailable++;const entry=make(key,'tool',toolName(object(call.function).name)??'Queued native call',!valid?'unknown':results.has(id)?'uncertain':'not_started',valid?'Durable queued proposal has not been dispatched.':'Original native identity is unavailable or conflicting.','approvals');Object.assign(entry,{frameId,callId:id});entries.set(key,entry);}
      }
      // Recovery closes queued native groups with explicit not_started results;
      // these are read only by exact frame+call identity, never by call ID alone.
      for(const rawMessage of Array.isArray(frame.messages)?frame.messages:[]){
        const message=object(rawMessage);if(message.role!=='tool')continue;
        const id=identity(message.tool_call_id),result=parse(message.content,RECOVERY_LIMITS.recordBytes);
        const data=object(result?.data);if(!id||data.status!=='not_started'&&data.uncertain!==true&&data.recoveryRequired!==true)continue;
        if(id===callId)continue;
        if(++count>RECOVERY_LIMITS.calls){callCoverage.truncated=true;break;}
        const key=operationKey(frameId,'call',id),valid=original(id),s=!valid?'unknown':(results.get(id)?.length??0)>1?'uncertain':nonDispatchStatus(result!);
        if(!valid)callCoverage.unavailable++;
        const old=entries.get(key);if(old){if(s==='uncertain')old.status='uncertain';}
        else{const entry=make(key,'tool','Native call',s,s==='not_started'?'Exact native result records that dispatch did not start.':'Native non-dispatch evidence is incomplete or contradictory.','controls');Object.assign(entry,{frameId,callId:id});entries.set(key,entry);}
      }
      if(count>RECOVERY_LIMITS.calls)break;
    }
  }

  const readRecords=(kind:'process'|'install',limit:number):Obj[]=>{
    const c=cover(kind==='process'?'processes':'installs',limit),max=RECOVERY_LIMITS.recordBytes;
    const selection=kind==='install'?'SELECT rowid,id,project_id,NULL AS key,data,length(CAST(data AS BLOB)) AS bytes FROM install_requests WHERE chat_id=? ORDER BY rowid DESC LIMIT ?':
      `SELECT rowid,NULL AS id,NULL AS project_id,key,data,length(CAST(data AS BLOB)) AS bytes FROM state WHERE key LIKE 'process-job:%' AND
        CASE WHEN length(CAST(data AS BLOB))<=${max} THEN CASE WHEN json_valid(data) THEN json_extract(data,'$.chatId')=? ELSE 1 END ELSE 1 END ORDER BY rowid DESC LIMIT ?`;
    const rows=store.db.prepare(`WITH recent AS (${selection}),bounded AS (SELECT *,SUM(CASE WHEN bytes<=? THEN bytes ELSE 0 END) OVER(ORDER BY rowid DESC) AS total FROM recent)
      SELECT id,project_id,key,CASE WHEN bytes<=? AND total<=? THEN data END AS data FROM bounded ORDER BY rowid DESC`).all(chatId,limit+1,max,max,RECOVERY_LIMITS.sourceBytes);
    c.truncated=rows.length>limit;
    return rows.slice(0,limit).flatMap(row=>{const item=parse(row.data,max);if(!item||item.chatId!==chatId||item.projectId!==projectId||!identity(item.id)||!identity(item.frameId)||(kind==='install'?(item.id!==row.id||row.project_id!==projectId):row.key!==`process-job:${item.id}`)){c.unavailable++;return [];}return [item];});
  };
  for(const item of readRecords('process',RECOVERY_LIMITS.processes)){
    const frameId=identity(item.frameId)!,commandId=identity(item.commandId),callId=identity(item.callId);if(!commandId||!callId){coverage.at(-1)!.unavailable++;continue;}
    const key=operationKey(frameId,'command',commandId),old=entries.get(key);
    let s=item.status==='starting'?'running':status(item.status);
    if(s==='completed'&&item.exitCode!==0)s='unknown';
    if(s==='not_started'&&item.dispatched!==false)s='unknown';
    if(!time(item.createdAt)||!time(item.updatedAt)||integer(item.generation)===undefined||integer(item.modeVersion)===undefined||typeof item.dispatched!=='boolean'){s='unknown';coverage.at(-1)!.unavailable++;}
    if(old?.status==='uncertain'||old?.status==='interrupted')s='uncertain';
    if(old&&s==='running'&&['completed','failed','not_started'].includes(old.status))s='uncertain';
    if(old&&['completed','failed','not_started'].includes(s)&&old.status!==s&&old.status!=='running'&&old.status!=='unknown')s='uncertain';
    const entry=make(key,'process','Owned process',s,'Last recorded owned-process state. Observation/cancellation does not undo effects.','terminal',time(item.updatedAt));
    if(item.truncated===true||old?.outputTruncated)entry.outputTruncated=true;
    Object.assign(entry,{frameId,commandId,callId,processId:identity(item.id),...(integer(item.generation)!==undefined?{generation:integer(item.generation)}:{})});if(old){entry.evidence=old.evidence;entry.evidenceTruncated=old.evidenceTruncated;}entries.set(key,entry);
  }
  for(const item of readRecords('install',RECOVERY_LIMITS.installs)){
    const frameId=identity(item.frameId)!,installId=identity(item.id)!,key=operationKey(frameId,'command',installId),old=entries.get(key);
    let s:RecoveryStatus=item.recoveryRequired===true?'uncertain':item.state==='succeeded'||item.state==='noop'?'completed':item.state==='failed'?'failed':item.state==='uncertain'?'uncertain':item.state==='dispatching'||item.state==='authorizing'?'running':['preparing','reviewing','pending','approved','rejected','stale'].includes(String(item.state))?'not_started':'unknown';
    if(!epochTime(item.createdAt)||!epochTime(item.updatedAt)||integer(item.generation)===undefined||integer(item.modeVersion)===undefined||typeof item.recoveryRequired!=='boolean'){s='unknown';coverage.at(-1)!.unavailable++;}
    const sources=store.db.prepare(`SELECT id,created_at,CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data FROM events WHERE chat_id=? AND type IN ('install','install_reconciliation') AND
      CASE WHEN length(CAST(data AS BLOB))<=? THEN CASE WHEN json_valid(data) THEN COALESCE(json_extract(data,'$.installId'),json_extract(data,'$.id'))=? ELSE 0 END ELSE 0 END ORDER BY id DESC LIMIT ?`).all(RECOVERY_LIMITS.recordBytes,chatId,RECOVERY_LIMITS.recordBytes,installId,RECOVERY_LIMITS.evidence+1);
    const originalUncertainty=old?.status==='uncertain'||old?.status==='interrupted'||sources.some(row=>parse(row.data,RECOVERY_LIMITS.recordBytes)?.state==='uncertain');
    let receiptEventId:number|undefined;
    if(originalUncertainty){
      const receipt=state(`install-reconciliation:${installId}`,RECOVERY_LIMITS.recordBytes,`install receipt ${installId}`),target=object(object(item.settings).target);
      const eventId=integer(receipt?.eventId),event=eventId?store.db.prepare("SELECT created_at,CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data FROM events WHERE chat_id=? AND id=? AND type='install_reconciliation'").get(RECOVERY_LIMITS.recordBytes,chatId,eventId):undefined,data=parse(event?.data,RECOVERY_LIMITS.recordBytes);
      const settings=target.scope==='project-container'?undefined:state('system-installs:v1',RECOVERY_LIMITS.recordBytes,`install target ${installId}`);
      const valid=receipt&&receipt.installId===installId&&receipt.chatId===chatId&&receipt.state==='succeeded'&&receipt.healthy===true&&receipt.matches===true&&['status','reconcile'].includes(String(receipt.method))&&typeof item.previewDigest==='string'&&receipt.previewDigest===item.previewDigest&&identity(target.id)&&receipt.targetKey===helperCanonical(target)
        &&(target.scope==='project-container'?!!item.containerReceipt&&helperCanonical(receipt.containerReceipt??null)===helperCanonical(item.containerReceipt):helperCanonical(settings?.target??null)===helperCanonical(target))
        &&data?.installId===installId&&data.method===receipt.method&&data.state==='succeeded'&&data.healthy===true&&data.matches===true;
      if(s!=='completed'||!valid)s='uncertain';else receiptEventId=eventId;
    }
    const entry=make(key,'install','System install',s,'Retained install outcome. Only the existing exact-target recovery flow can reconcile it.','installs',epochTime(item.updatedAt));
    Object.assign(entry,{frameId,installId,commandId:installId,...(integer(item.generation)!==undefined?{generation:integer(item.generation)}:{})});if(old){entry.evidence=old.evidence;entry.evidenceTruncated=old.evidenceTruncated;}entries.set(key,entry);
    for(const source of sources)eventEvidence(entry,source.id,source.created_at);
    if(receiptEventId){const source=store.db.prepare('SELECT created_at FROM events WHERE id=? AND chat_id=?').get(receiptEventId,chatId);eventEvidence(entry,receiptEventId,source?.created_at);}
  }
  const rawGoal=state(`goal:${chatId}`,RECOVERY_LIMITS.recordBytes,'goal'),rawPlan=state(`plan:${chatId}`,RECOVERY_LIMITS.recordBytes,'plan');
  let goal:RecoveryView['goal'],plan:RecoveryView['plan'];
  if(rawGoal){
    const id=identity(rawGoal.id),revision=integer(rawGoal.revision),s=String(rawGoal.status),human=identity(rawGoal.humanMessageId);
    if(id&&revision&&['running','waiting_for_approval','waiting_for_user','paused','blocked','completed'].includes(s)){
      const original=human&&originalHuman(human);
      const uncertain=Array.isArray(rawGoal.uncertainEventIds)?rawGoal.uncertainEventIds:[];
      const source=store.db.prepare(`SELECT id FROM events WHERE chat_id=? AND type='goal' AND CASE WHEN length(CAST(data AS BLOB))<=? THEN CASE WHEN json_valid(data) THEN json_extract(data,'$.id')=? AND json_extract(data,'$.revision')=? AND json_extract(data,'$.status')=? ELSE 0 END ELSE 0 END ORDER BY id DESC LIMIT 1`).get(chatId,RECOVERY_LIMITS.recordBytes,id,revision,s);
      goal={id,revision,status:s as GoalStatus,humanMessageId:original?human!:null,updatedAt:time(rawGoal.updatedAt),uncertainEventIds:uncertain.slice(0,100).flatMap(v=>integer(v)?[Number(v)]:[]),truncated:uncertain.length>100||rawGoal.uncertaintyOverflow===true||rawGoal.evidenceOverflow===true,eventId:integer(source?.id)??null};
      if(!source)coverage.find(c=>c.source==='goal')!.unavailable++;
    }else coverage.find(c=>c.source==='goal')!.unavailable++;
  }
  const planCoverage=cover('steps',RECOVERY_LIMITS.steps);
  if(rawPlan){
    const id=identity(rawPlan.id),version=integer(rawPlan.version);if(id&&version){
      plan={id,version};let count=0;
      for(const rawPhase of Array.isArray(rawPlan.phases)?rawPlan.phases:[]){const phase=object(rawPhase);
        for(const rawStep of Array.isArray(phase.steps)?phase.steps:[]){
          if(++count>RECOVERY_LIMITS.steps){planCoverage.truncated=true;break;}
          const step=object(rawStep),stepRef=ref({planId:id,planVersion:version,phaseId:phase.id,stepId:step.id});if(!stepRef){planCoverage.unavailable++;continue;}
          const evidence=object(step.evidence),eventId=integer(evidence.eventId);
          const entry=make(`plan:${id}:${stepRef.phaseId}:${stepRef.stepId}`,'plan','Plan step',step.status==='done'&&eventId?'completed':step.status==='in_progress'?'running':'unknown',step.status==='done'&&eventId?'Existing plan acceptance; this does not prove unobserved requirements.':'Plan state alone does not prove dispatch, success or absence of effects.','plan');entry.planStep=stepRef;
          if(eventId){const row=store.db.prepare("SELECT created_at,CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data FROM events WHERE id=? AND chat_id=? AND type='plan_progress'").get(RECOVERY_LIMITS.recordBytes,eventId,chatId),data=parse(row?.data,RECOVERY_LIMITS.recordBytes),sourceRef=ref(data);
            if(row&&sourceRef&&JSON.stringify(sourceRef)===JSON.stringify(stepRef)&&data?.delegationId===evidence.delegationId&&data?.status===step.status&&(step.status!=='done'||data?.outcome==='accepted'))eventEvidence(entry,eventId,row.created_at);
            else {entry.status='unknown';planCoverage.unavailable++;}}
          entries.set(entry.id,entry);
        }if(count>RECOVERY_LIMITS.steps)break;
      }
    }else if(Array.isArray(rawPlan.phases)&&rawPlan.phases.length)planCoverage.unavailable++;
  }
  const all=[...entries.values()],entryCoverage=cover('entries',RECOVERY_LIMITS.entries,all.length>RECOVERY_LIMITS.entries);
  const priority=(s:RecoveryStatus)=>['uncertain','interrupted','running','unknown','not_started','failed','completed'].indexOf(s);
  all.sort((a,b)=>priority(a.status)-priority(b.status)||(b.updatedAt??'').localeCompare(a.updatedAt??'')||a.id.localeCompare(b.id));
  const projected=all.slice(0,entryCoverage.limit);
  const body={schema:'recovery-v1' as const,chatId,projectId,chat:chatState,latestEventId:integer(latest?.id)??0,...(goal?{goal}:{}),...(plan?{plan}:{}),humanMessageIds,entries:projected,coverage};
  return {...body,revision:createHash('sha256').update(JSON.stringify(body)).digest('hex'),observedAt:new Date().toISOString()};
}
