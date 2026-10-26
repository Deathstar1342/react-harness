import {nativePrivateUnit} from './native-storage.js';
import {z} from 'zod';
import path from 'node:path';
import type {Store} from './store.js';
import {parseNativeJSON} from './native-json.js';
import {checkpointLimits,checkpointPolicy,checkpointExclusion,manifestDigest,assertCheckpointRoot,type CheckpointFile} from './checkpoint-files.js';
import {hash,safeRelative} from './tools/paths.js';
import type {SQLInputValue} from 'node:sqlite';

export const CHECKPOINT_STATE_LIMITS={recordBytes:12*1024*1024,journalBytes:24*1024*1024,checkpointBytes:64*1024*1024,journalBytesTotal:64*1024*1024,journalCount:64,chats:64,contextRows:257,contextBytes:8*1024*1024,contextRecordBytes:2*1024*1024,auxiliaryRows:256,auxiliaryBytes:4*1024*1024} as const;
export const checkpointConflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const fail=()=>{throw checkpointConflict('Checkpoint integrity/state is malformed, incomplete or exceeds its bounded observation; no effect authority or uncertainty waiver is available');};
const uuid=z.uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/),integer=z.number().int().safe().nonnegative(),stamp=z.string().min(1).max(200),date=z.iso.datetime();
const relative=z.string().min(1).max(1024).refine(v=>{try{return safeRelative(v)===v&&!checkpointExclusion(v)&&v.split('/').every(p=>p.length<=240&&!/[<>"|?*]/.test(p));}catch{return false;}});
const file=z.strictObject({path:relative,content:z.string().max(checkpointLimits.fileBytes),hash:digest.nullable(),mode:z.number().int().min(0).max(0o777)}).refine(f=>Buffer.byteLength(f.content)<=checkpointLimits.fileBytes&&!f.content.includes('\0')&&Buffer.from(f.content).toString('utf8')===f.content&&(f.hash===null?f.content==='':hash(f.content)===f.hash));
const exclusions=z.array(z.strictObject({path:z.string().min(1).max(1024),reason:z.enum(['Git metadata or credential path','Dependency, build or runtime output','Private/runtime data','Private application/provider ledger','Private application state','Private or cache path','Binary asset/archive/font/media'])})).max(100);
export const checkpointRecordSchema=z.strictObject({id:uuid,projectId:uuid,chatId:uuid,label:z.string().min(1).max(80),createdAt:date,source:z.literal('human'),policy:z.literal(checkpointPolicy),root:z.string().min(1).max(4096),rootIdentity:stamp,digest,fileCount:integer.max(checkpointLimits.files),headerIntegrity:digest,files:z.array(file.refine(f=>f.hash!==null)).max(checkpointLimits.files),bytes:integer.max(checkpointLimits.bytes),excluded:exclusions,excludedCount:integer.max(checkpointLimits.entries),integrity:digest});
const change=z.strictObject({id:uuid,before:file,after:file,digest}).refine(c=>c.before.path===c.after.path);
export const checkpointJournalSchema=z.strictObject({id:uuid,projectId:uuid,checkpointId:uuid,chatId:uuid,root:z.string().min(1).max(4096),rootIdentity:stamp,createdAt:date,source:z.literal('human'),confirmation:z.literal('restore-files'),previewTokenHash:digest,status:z.enum(['claiming','uncertain','done']),revision:digest,checkpointIntegrity:digest,fileCount:integer.max(checkpointLimits.files*2),changesDigest:digest,integrity:digest,changes:z.array(change).max(checkpointLimits.files*2)});
export type CheckpointRecord=z.infer<typeof checkpointRecordSchema>;
export type CheckpointJournal=z.infer<typeof checkpointJournalSchema>;
export type CheckpointChange=z.infer<typeof change>;
export const checkpointKey=(id:string)=>`checkpoint:v1:${id}`,checkpointJournalKey=(id:string)=>`checkpoint-restore:v1:${id}`;
export function checkpointIntegrity(record:CheckpointRecord){const {integrity:_,headerIntegrity:__,...data}=record;return hash(JSON.stringify(data));}
const alias=(v:string)=>v.normalize('NFC').toLowerCase();
function uniqueFiles(files:CheckpointFile[]){const names=new Set<string>();for(const f of files){if(names.has(alias(f.path)))fail();names.add(alias(f.path));}for(const f of names)for(let slash=f.indexOf('/');slash>=0;slash=f.indexOf('/',slash+1))if(names.has(f.slice(0,slash)))fail();}
/** SQL limits rows and returns NULL for excessive record/aggregate bytes BEFORE JS or parsing. SQL is trusted fixed caller code. */
function observeCheckpointRows(store:Store,select:string,args:SQLInputValue[],rows:number,per:number,total:number):{key:string;data:string;bytes:number}[]{
 const values=store.db.prepare(`WITH bounded_source AS (${select} LIMIT ?), sized AS (SELECT key,data,length(CAST(data AS BLOB)) AS bytes FROM bounded_source), budget AS (SELECT *,SUM(bytes) OVER(ORDER BY key) AS total FROM sized) SELECT CASE WHEN length(CAST(key AS BLOB))<=512 THEN key END AS key,bytes,CASE WHEN bytes<=? AND total<=? THEN data END AS data FROM budget ORDER BY key`).all(...args,rows+1,per,total);
 if(values.length>rows)fail();return values.map(v=>{if(typeof v.key!=='string'||typeof v.data!=='string'||!Number.isSafeInteger(v.bytes))return fail();return {key:v.key,data:v.data,bytes:Number(v.bytes)};});
}
export const checkpointRows=(...args:Parameters<typeof observeCheckpointRows>)=>nativePrivateUnit(()=>observeCheckpointRows(...args));
export function checkpointJSON(source:string,max:number):unknown{try{return parseNativeJSON(source,max);}catch{return fail();}}
const projectSchema=z.strictObject({id:uuid,name:z.string().min(1).max(200),path:z.string().min(1).max(4096),createdAt:date,removalError:z.string().max(4000).optional()});
function observeCheckpointProject(store:Store,id:string){
 uuid.parse(id);const rows=checkpointRows(store,'SELECT id AS key,data FROM projects WHERE id=?',[id],1,16384,16384);if(rows.length!==1)return fail();
 const result=projectSchema.safeParse(checkpointJSON(rows[0].data,16384));if(!result.success||result.data.id!==id||path.resolve(result.data.path)!==result.data.path)return fail();
 const root=store.db.prepare('SELECT CASE WHEN length(CAST(root AS BLOB))<=4096 THEN root END AS root FROM projects WHERE id=?').get(id);if(root?.root!==result.data.path)return fail();return result.data;
}
export const checkpointProject=(...args:Parameters<typeof observeCheckpointProject>)=>nativePrivateUnit(()=>observeCheckpointProject(...args));
/** Complete bounded private catalog. Unknown keys/records/references fail closed, never disappear as an empty list. */
function observeCheckpointCatalog(store:Store){
 const metadata=checkpointMetadata(store);
 const records=metadata.records.map(entry=>({record:loadCheckpointBody(store,entry.record),storedBytes:entry.storedBytes}));
 const journals=metadata.journals.map(entry=>({...entry,journal:loadCheckpointJournal(store,entry.journal)}));return {records,journals};
}
export const checkpointCatalog=(store:Store)=>nativePrivateUnit(()=>observeCheckpointCatalog(store));
const roleModels=z.strictObject({architect:z.string().max(200),coder:z.string().max(200),critic:z.string().max(200)});
const chatSchema=z.strictObject({id:uuid,projectId:uuid,title:z.string().max(200),status:z.enum(['idle','running','awaiting_approval','paused','interrupted','error']),approvalMode:z.enum(['autonomous','balanced','review']),mode:z.enum(['plan','execute']).optional(),modeVersion:integer.optional(),createdAt:date,updatedAt:date,models:roleModels.optional()});
/** Exact context bytes are hashed, never returned. Missing optional rows are explicit nulls in the fingerprint. */
function observeCheckpointContext(store:Store,projectId:string,chatId?:string){
 const project=checkpointProject(store,projectId),rows=checkpointRows(store,'SELECT id AS key,data FROM chats WHERE project_id=? ORDER BY id',[projectId],CHECKPOINT_STATE_LIMITS.chats,32768,1024*1024);
 const chats=rows.map(row=>{const parsed=chatSchema.safeParse(checkpointJSON(row.data,32768));if(!parsed.success||parsed.data.id!==row.key||parsed.data.projectId!==projectId)return fail();return parsed.data;});
 if(chatId&&!chats.some(c=>c.id===chatId))fail();
 const states=checkpointRows(store,"SELECT key,data FROM state WHERE key IN (SELECT 'run:'||id FROM chats WHERE project_id=? UNION SELECT 'goal:'||id FROM chats WHERE project_id=? UNION SELECT 'plan:'||id FROM chats WHERE project_id=? UNION SELECT 'skills:selected:'||id FROM chats WHERE project_id=?) OR key=? ORDER BY key",[projectId,projectId,projectId,projectId,`transfer:reservation:${projectId}`],CHECKPOINT_STATE_LIMITS.contextRows,CHECKPOINT_STATE_LIMITS.contextRecordBytes,CHECKPOINT_STATE_LIMITS.contextBytes);
 for(const row of states){const value=checkpointJSON(row.data,CHECKPOINT_STATE_LIMITS.contextRecordBytes);if(row.key.startsWith('transfer:')){if(value!==null)throw checkpointConflict('An export is pending or uncertain');continue;}
  if(!value||typeof value!=='object'||Array.isArray(value))fail();
  if(row.key.startsWith('run:')){
   const frames=(value as {frames?:unknown}).frames;if(!Array.isArray(frames)||frames.length>256)return fail();
   for(const frame of frames){if(!frame||typeof frame!=='object'||Array.isArray(frame))fail();const pending=frame.pending;if(pending!==undefined){if(!pending||typeof pending!=='object'||!['prepared','executing','done'].includes(pending.stage))fail();if(pending.stage==='executing')throw checkpointConflict('Resolve pending project actions before checkpoint work');}}
  }
 }
 const eventIds=store.db.prepare('SELECT chat_id,max(id) AS id FROM events WHERE chat_id IN (SELECT id FROM chats WHERE project_id=?) GROUP BY chat_id ORDER BY chat_id LIMIT ?').all(projectId,CHECKPOINT_STATE_LIMITS.chats+1);if(eventIds.length>CHECKPOINT_STATE_LIMITS.chats)fail();
 const approvals=checkpointRows(store,'SELECT id AS key,data FROM approvals WHERE chat_id IN (SELECT id FROM chats WHERE project_id=?) ORDER BY id',[projectId],CHECKPOINT_STATE_LIMITS.auxiliaryRows,131072,CHECKPOINT_STATE_LIMITS.auxiliaryBytes);
 for(const row of approvals){const a=checkpointJSON(row.data,131072) as {id?:unknown;chatId?:unknown;status?:unknown};if(!a||a.id!==row.key||!chats.some(c=>c.id===a.chatId)||!['pending','approved','denied','stale'].includes(String(a.status)))fail();if(a.status==='pending')throw checkpointConflict('Resolve pending project approvals before checkpoint work');}
 const installs=checkpointRows(store,'SELECT id AS key,data FROM install_requests WHERE project_id=? ORDER BY id',[projectId],100,131072,CHECKPOINT_STATE_LIMITS.auxiliaryBytes);
 for(const row of installs){const i=checkpointJSON(row.data,131072) as {id?:unknown;projectId?:unknown;state?:unknown;recoveryRequired?:unknown};if(!i||i.id!==row.key||i.projectId!==projectId||typeof i.recoveryRequired!=='boolean'||!['preparing','reviewing','pending','approved','authorizing','dispatching','succeeded','noop','rejected','stale','failed','uncertain','not_started'].includes(String(i.state)))fail();if(i.recoveryRequired||['preparing','reviewing','pending','approved','authorizing','dispatching','uncertain'].includes(String(i.state)))throw checkpointConflict('Resolve system install requests and recovery before checkpoint work');}
 // Existing process/skill/removal guards may parse these later; bound and validate BEFORE calling them.
 for(const [prefix,max]of [['process-job:',131072],['skills:write:',512000]] as const){
  const auxiliary=checkpointRows(store,'SELECT key,data FROM state WHERE key LIKE ? ORDER BY key',[prefix+'%'],CHECKPOINT_STATE_LIMITS.auxiliaryRows,max,CHECKPOINT_STATE_LIMITS.auxiliaryBytes);
  for(const row of auxiliary){const v=checkpointJSON(row.data,max) as {id?:unknown;chatId?:unknown;projectId?:unknown;status?:unknown};if(!v||typeof v.id!=='string'||row.key!==prefix+v.id||typeof v.chatId!=='string')fail();
   if(prefix==='process-job:'){if(typeof v.projectId!=='string'||!['starting','running','completed','failed','not_started','interrupted','uncertain'].includes(String(v.status)))fail();if(v.projectId===projectId&&['starting','running','uncertain'].includes(String(v.status)))throw checkpointConflict('A project process is active or uncertain');}
   else {if(!['prepared','recording','done','rejected','unknown'].includes(String(v.status)))fail();if(chats.some(c=>c.id===v.chatId)&&['recording','unknown'].includes(String(v.status)))throw checkpointConflict('A skill write or promotion is uncertain');}
  }
 }
 if(store.db.prepare("SELECT id FROM file_changes WHERE project_id=? AND status NOT IN ('confirmed','undone','rejected') LIMIT 1").get(projectId))throw checkpointConflict('A recorded file effect is uncertain; inspect its retained outcome before checkpoint work');
 if(chats.some(c=>['running','awaiting_approval'].includes(c.status)))throw checkpointConflict('Pause all active project chats before checkpoint work');
 return {project,chats,revision:hash(JSON.stringify([rows.map(r=>[r.key,r.data]),states.map(r=>[r.key,r.data]),eventIds,approvals.map(r=>[r.key,r.data]),installs.map(r=>[r.key,r.data])]))};
}

export const checkpointContext=(...args:Parameters<typeof observeCheckpointContext>)=>nativePrivateUnit(()=>observeCheckpointContext(...args));

export const checkpointHeaderSchema=checkpointRecordSchema.omit({files:true});
export const checkpointJournalHeaderSchema=checkpointJournalSchema.omit({changes:true});
export function checkpointHeaderIntegrity(record:Omit<CheckpointRecord,'files'>){const {files:__,...input}=record as CheckpointRecord;const {headerIntegrity:_,...header}=checkpointHeaderSchema.parse(input);return hash(JSON.stringify(header));}
export function checkpointChangeDigest(c:CheckpointChange){const {digest:_,...value}=c;return hash(JSON.stringify(value));}
export function checkpointJournalIntegrity(j:Omit<CheckpointJournal,'changes'>){const {changes:__,...input}=j as CheckpointJournal;const {integrity:_,...value}=checkpointJournalHeaderSchema.parse(input);return hash(JSON.stringify(value));}
const headerOf=(r:CheckpointRecord)=>{const {files:_,...header}=r;return checkpointHeaderSchema.parse(header);};
export const journalHeaderOf=(j:CheckpointJournal)=>{const {changes:_,...header}=j;return checkpointJournalHeaderSchema.parse(header);};
const metadataKey=(id:string)=>`checkpoint-meta:v1:${id}`;
function metadataRows(store:Store,prefix:'checkpoint-meta:v1:'|'checkpoint-restore:v1:',exact?:string){
 const capture=prefix==='checkpoint-meta:v1:',limit=capture?checkpointLimits.totalCount:CHECKPOINT_STATE_LIMITS.journalCount,bodyMax=CHECKPOINT_STATE_LIMITS.recordBytes,totalMax=capture?CHECKPOINT_STATE_LIMITS.checkpointBytes:CHECKPOINT_STATE_LIMITS.journalBytesTotal;
 const select=capture?`SELECT m.key,m.data,length(CAST(m.data AS BLOB))+length(CAST(body.data AS BLOB)) AS bytes,length(CAST(body.data AS BLOB)) AS bodyBytes FROM state m LEFT JOIN state body ON body.key='checkpoint:v1:'||substr(m.key,${prefix.length+1}) WHERE m.${exact?'key=?':'key LIKE ?'} ORDER BY m.key LIMIT ?`:`SELECT key,data,length(CAST(data AS BLOB)) AS bytes,0 AS bodyBytes FROM state WHERE ${exact?'key=?':'key LIKE ?'} ORDER BY key LIMIT ?`;
 const rows=store.db.prepare(`WITH candidates AS (${select}), budget AS (SELECT *,SUM(bytes) OVER(ORDER BY key) AS total FROM candidates) SELECT CASE WHEN length(CAST(key AS BLOB))<=256 THEN key END AS key,bytes,CASE WHEN length(CAST(data AS BLOB))<=32768 AND bodyBytes<=? AND total<=? THEN data END AS data FROM budget`).all(exact??prefix+'%',exact?2:limit+1,bodyMax,totalMax);
 if(rows.length>(exact?1:limit))fail();return rows.map(row=>{if(typeof row.key!=='string'||typeof row.data!=='string'||!Number.isSafeInteger(row.bytes))return fail();return {key:row.key,bytes:Number(row.bytes),data:checkpointJSON(row.data,32768)};});
}
/** Small headers and SQL size/count metadata only: no JSON traversal of source or restore bodies. */
function observeCheckpointMetadata(store:Store){
 if(store.db.prepare("SELECT 1 FROM state body WHERE body.key LIKE 'checkpoint:v1:%' AND NOT EXISTS (SELECT 1 FROM state m WHERE m.key='checkpoint-meta:v1:'||substr(body.key,15)) LIMIT 1").get())fail();
 if(store.db.prepare("SELECT 1 FROM checkpoint_effects e WHERE NOT EXISTS (SELECT 1 FROM state j WHERE j.key='checkpoint-restore:v1:'||e.restore_id) LIMIT 1").get())fail();
 const records=metadataRows(store,'checkpoint-meta:v1:').map(row=>{const parsed=checkpointHeaderSchema.safeParse(row.data);if(!parsed.success)return fail();const r=parsed.data;
  if(row.key!==metadataKey(r.id)||r.headerIntegrity!==checkpointHeaderIntegrity(r)||checkpointProject(store,r.projectId).path!==r.root||r.excludedCount<r.excluded.length)return fail();return {record:r,storedBytes:row.bytes};});
 const ids=new Map(records.map(r=>[r.record.id,r.record]));
 const journals=metadataRows(store,'checkpoint-restore:v1:').map(row=>{const parsed=checkpointJournalHeaderSchema.safeParse(row.data);if(!parsed.success)return fail();const r=parsed.data,checkpoint=ids.get(r.checkpointId);
  if(row.key!==checkpointJournalKey(r.id)||r.integrity!==checkpointJournalIntegrity(r)||!checkpoint||r.projectId!==checkpoint.projectId||r.root!==checkpoint.root||r.rootIdentity!==checkpoint.rootIdentity||r.checkpointIntegrity!==checkpoint.integrity)return fail();
  const effects=store.db.prepare('SELECT count(*) AS n,min(ordinal) AS first,max(ordinal) AS last,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes,coalesce(max(length(CAST(data AS BLOB))),0) AS largest FROM checkpoint_effects WHERE restore_id=?').get(r.id);
  const history=store.db.prepare('SELECT count(f.id) AS n,coalesce(sum(length(CAST(f.summary AS BLOB))+length(CAST(f.snapshots AS BLOB))),0) AS bytes FROM checkpoint_effects e LEFT JOIN file_changes f ON f.id=e.change_id WHERE e.restore_id=?').get(r.id);
  if(!effects||!history||Number(effects.n)!==r.fileCount||r.fileCount&&(Number(effects.first)!==0||Number(effects.last)!==r.fileCount-1)||Number(effects.largest)>1100000||Number(effects.bytes)>CHECKPOINT_STATE_LIMITS.journalBytes||!Number.isSafeInteger(effects.bytes)||!Number.isSafeInteger(history.bytes)||r.status!=='done'&&Number(history.n)!==r.fileCount)return fail();
  return {journal:r,storedBytes:row.bytes+Number(effects.bytes),historyBytes:Number(history.bytes)};});
 if(journals.reduce((n,j)=>n+j.storedBytes+j.historyBytes,0)>CHECKPOINT_STATE_LIMITS.journalBytesTotal)fail();return {records,journals};
}
export const checkpointMetadata=(store:Store)=>nativePrivateUnit(()=>observeCheckpointMetadata(store));
function loadCheckpointBody(store:Store,header:z.infer<typeof checkpointHeaderSchema>){
 const rows=checkpointRows(store,'SELECT key,data FROM state WHERE key=?',[checkpointKey(header.id)],1,CHECKPOINT_STATE_LIMITS.recordBytes,CHECKPOINT_STATE_LIMITS.recordBytes);if(rows.length!==1)return fail();const parsed=checkpointRecordSchema.safeParse(checkpointJSON(rows[0].data,CHECKPOINT_STATE_LIMITS.recordBytes));if(!parsed.success)return fail();const r=parsed.data;
 if(JSON.stringify(headerOf(r))!==JSON.stringify(header)||r.fileCount!==r.files.length||r.integrity!==checkpointIntegrity(r)||r.digest!==manifestDigest(r.files)||r.bytes!==r.files.reduce((n,f)=>n+Buffer.byteLength(f.content),0))return fail();uniqueFiles(r.files);return r;
}
export const checkpointLoad=(store:Store,projectId:string,id:string)=>nativePrivateUnit(()=>{
 const header=checkpointMetadata(store).records.find(r=>r.record.id===id&&r.record.projectId===projectId)?.record;if(!header)return fail();return loadCheckpointBody(store,header);
});
function loadCheckpointJournal(store:Store,header:z.infer<typeof checkpointJournalHeaderSchema>){
 const rows=checkpointRows(store,"SELECT printf('%04d',ordinal)||':'||change_id AS key,data FROM checkpoint_effects WHERE restore_id=? ORDER BY ordinal",[header.id],checkpointLimits.files*2,1100000,CHECKPOINT_STATE_LIMITS.journalBytes);
 const changes=rows.map((row,index)=>{const parsed=change.safeParse(checkpointJSON(row.data,1100000));if(!parsed.success||row.key!==String(index).padStart(4,'0')+':'+parsed.data.id||parsed.data.digest!==checkpointChangeDigest(parsed.data))return fail();return parsed.data;});
 const parsed=checkpointJournalSchema.safeParse({...header,changes});if(!parsed.success)return fail();const j=parsed.data;
 if(j.fileCount!==changes.length||new Set(changes.map(c=>c.id)).size!==changes.length||new Set(changes.map(c=>alias(c.before.path))).size!==changes.length||j.changesDigest!==hash(JSON.stringify(changes.map(c=>c.digest))))return fail();return j;
}
export function checkpointSave(store:Store,record:CheckpointRecord){const header=headerOf(record);if(Buffer.byteLength(JSON.stringify(header))>32768)fail();store.setState(checkpointKey(record.id),record);store.setState(metadataKey(record.id),header);}
export function checkpointSaveJournal(store:Store,journal:CheckpointJournal){const header=journalHeaderOf(journal);if(Buffer.byteLength(JSON.stringify(header))>32768)fail();store.setState(checkpointJournalKey(journal.id),header);}
export function checkpointSaveEffects(store:Store,journal:CheckpointJournal){
 for(const [ordinal,c]of journal.changes.entries())store.db.prepare('INSERT INTO checkpoint_effects VALUES (?,?,?,?)').run(journal.id,ordinal,c.id,JSON.stringify(c));
}
export const checkpointExactClaim=(store:Store,expected:CheckpointJournal,index:number)=>nativePrivateUnit(()=>{
 if(!Number.isSafeInteger(index)||index<0||index>=expected.changes.length)return fail();
 const rows=metadataRows(store,'checkpoint-restore:v1:',checkpointJournalKey(expected.id));if(rows.length!==1)return fail();const parsed=checkpointJournalHeaderSchema.safeParse(rows[0].data);if(!parsed.success)return fail();const header=parsed.data;
 if(header.status!=='claiming'||header.integrity!==checkpointJournalIntegrity(header)||JSON.stringify(header)!==JSON.stringify(journalHeaderOf(expected)))return fail();
 const row=store.db.prepare('SELECT change_id,CASE WHEN length(CAST(data AS BLOB))<=1100000 THEN data END AS data FROM checkpoint_effects WHERE restore_id=? AND ordinal=?').get(expected.id,index);
 if(typeof row?.data!=='string'||row.change_id!==expected.changes[index].id)return fail();const selected=change.safeParse(checkpointJSON(row.data,1100000));
 if(!selected.success||selected.data.digest!==checkpointChangeDigest(selected.data)||JSON.stringify(selected.data)!==JSON.stringify(expected.changes[index]))return fail();
 assertCheckpointRoot(expected.root,expected.rootIdentity);
});
export const checkpointValidateJournal=(store:Store,expected:CheckpointJournal)=>nativePrivateUnit(()=>{
 const rows=metadataRows(store,'checkpoint-restore:v1:',checkpointJournalKey(expected.id));if(rows.length!==1)return fail();const header=checkpointJournalHeaderSchema.safeParse(rows[0].data);if(!header.success||header.data.integrity!==checkpointJournalIntegrity(header.data))return fail();
 const j=loadCheckpointJournal(store,header.data);if(JSON.stringify(j)!==JSON.stringify(expected))return fail();assertCheckpointRoot(expected.root,expected.rootIdentity);
});
