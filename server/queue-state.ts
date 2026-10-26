import {validQueueIdleRun} from './queue-run-source.js';
import {validQueueGoal} from './queue-goals.js';
import {createHash} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {z} from 'zod';
import type {Store} from './store.js';
import {assertNativeJSON,parseNativeJSON} from './native-json.js';
import {nativePrivateUnit} from './native-storage.js';
import {rootPathSync} from './tools/paths.js';
export const QUEUE_LIMITS={tasks:32,revisions:8,textBytes:16000,retainedBytes:512000,envelopeBytes:600000,page:16,pageBytes:327680,referenceBytes:8192} as const;
const uuid=z.uuid(),int=z.number().int().safe().nonnegative(),digest=z.string().regex(/^[a-f0-9]{64}$/),stamp=z.string().datetime();
export const queueDigest=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const version=z.strictObject({revision:int.positive(),original:z.string().min(1).max(16000),digest,canonicalDigest:digest,createdAt:stamp,source:z.literal('human-api')});
const receipt=z.strictObject({kind:z.enum(['native-root','goal']),eventId:int.positive(),callId:z.string().min(1).max(200),goalId:uuid.optional(),goalRevision:int.positive().optional(),goalGeneration:int.optional()});
const claim=z.strictObject({id:uuid,session:uuid,queueRevision:int.positive(),textRevision:int.positive(),digest,chatId:uuid,humanMessageId:uuid,rootId:uuid,modeVersion:int,approvalMode:z.enum(['autonomous','balanced','review']),instructionsHash:digest.nullable(),skillsHash:digest,goalId:uuid.optional(),goalRevision:int.positive().optional(),goalGeneration:int.optional(),stage:z.enum(['claimed','dispatched']),stopKind:z.enum(['decision','failure','cancel']).optional(),askUserCallId:z.string().min(1).max(200).optional(),receipt:receipt.optional()});
export const queueTaskSchema=z.strictObject({id:uuid,versions:z.array(version).min(1).max(8),status:z.enum(['pending','running','accepted','stopped','cancelled']),reason:z.string().max(256),claim:claim.optional()});
const scope=z.strictObject({id:uuid,revision:int.positive(),digest});
const schema=z.strictObject({schema:z.literal('queue-v1'),projectId:uuid,root:z.string().min(1).max(4096),rootIdentity:z.string().min(1).max(4608),revision:int,status:z.enum(['paused','running','completed']),reason:z.string().max(256),session:uuid.nullable(),policyDigest:digest.nullable(),scope:z.array(scope).max(32),tasks:z.array(queueTaskSchema).max(32)});
export type QueueState=z.infer<typeof schema>;
export type QueueTask=z.infer<typeof queueTaskSchema>;
export type QueueClaim=NonNullable<QueueTask['claim']>;
export const queueError=(message='Queue changed. Reload before continuing.',statusCode=409)=>Object.assign(Error(message),{statusCode});
export function queueRoot(root:string){const canonical=rootPathSync(root),s=lstatSync(canonical,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw queueError('Project identity unavailable.',503);return `${canonical}:${s.dev}:${s.ino}:${s.birthtimeNs}`;}
export function queueText(original:string){if(typeof original!=='string'||!original.trim()||original.includes('\0')||Buffer.byteLength(original)>16000||Buffer.from(original,'utf8').toString('utf8')!==original)throw queueError('Task text must contain 1–16000 UTF-8 bytes.',400);return {revision:1,original,digest:queueDigest(original),canonicalDigest:queueDigest(original.trim()),createdAt:new Date().toISOString(),source:'human-api' as const};}
function validate(value:unknown):QueueState {
 const q=schema.parse(value);let bytes=0;const ids=new Set<string>(),chats=new Set<string>();
 for(const task of q.tasks){if(ids.has(task.id))throw queueError('Duplicate queue identity.',503);ids.add(task.id);for(const [i,v] of task.versions.entries()){bytes+=Buffer.byteLength(v.original);queueText(v.original);if(v.revision!==i+1||v.digest!==queueDigest(v.original)||v.canonicalDigest!==queueDigest(v.original.trim()))throw queueError('Task provenance unavailable.',503);}const v=task.versions.at(-1)!;
 if(task.claim){const c=task.claim;if(c.digest!==v.digest||c.textRevision!==v.revision||chats.has(c.chatId)||Buffer.byteLength(JSON.stringify(c))>2048||c.receipt?.kind==='goal'&&(c.receipt.goalId!==c.goalId||c.receipt.goalRevision!==c.goalRevision))throw queueError('Claim provenance unavailable.',503);chats.add(c.chatId);}
 if(task.status==='pending'&&task.claim||['running','accepted','stopped'].includes(task.status)&&!task.claim||task.status==='accepted'&&!task.claim?.receipt)throw queueError('Queue claim unavailable.',503);
 }
 if(bytes>512000||Buffer.byteLength(JSON.stringify(q.scope))>8192||new Set(q.scope.map(t=>t.id)).size!==q.scope.length||q.scope.some(s=>!q.tasks.some(t=>t.id===s.id&&t.versions.at(-1)!.revision===s.revision&&t.versions.at(-1)!.digest===s.digest)))throw queueError('Queue exceeds retained bounds or scope changed.',503);
 if(q.tasks.filter(t=>t.status==='running').length>1)throw queueError('Conflicting queue claims.',503);return q;
}
export function installQueue(store:Store){store.db.function('queue_run_idle',{deterministic:true},raw=>validQueueIdleRun(raw)?1:0);store.db.function('queue_goal_ok',{deterministic:true},raw=>validQueueGoal(raw)?1:0);store.db.function('queue_json_ok',{deterministic:true},(raw,max)=>{if(typeof raw!=='string'||typeof max!=='number'||!Number.isSafeInteger(max)||max<1||max>1100000)return 0;try{assertNativeJSON(raw,max);return 1;}catch{return 0;}});store.db.exec('CREATE TABLE IF NOT EXISTS task_queues (project_id TEXT PRIMARY KEY NOT NULL,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS queue_links (chat_id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL,claim_id TEXT UNIQUE NOT NULL,root_id TEXT NOT NULL,UNIQUE(project_id,task_id))');}
/** SQL gates precede JS. A display read never loads RunState or mutates durable data. */
export function readQueue(store:Store,projectId:string):QueueState{return nativePrivateUnit(()=>{
 if(!uuid.safeParse(projectId).success)throw queueError('Project unavailable.',404);
 const p=store.db.prepare("SELECT CASE WHEN typeof(root)='text' AND length(CAST(root AS BLOB))<=4096 THEN root END AS root,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=8192 THEN data END AS data FROM projects WHERE id=?").get(projectId);
 if(typeof p?.root!=='string'||typeof p.data!=='string')throw queueError('Project unavailable.',503);
 const original=z.strictObject({id:uuid,name:z.string().min(1).max(100),path:z.string().min(1).max(4096),createdAt:stamp,removalError:z.string().max(4000).optional()}).parse(parseNativeJSON(p.data,8192));if(original.id!==projectId||original.path!==p.root)throw queueError('Project identity unavailable.',503);
 const row=store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=600000 THEN data END AS data FROM task_queues WHERE project_id=?").get(projectId);
 if(!row)return {schema:'queue-v1',projectId,root:p.root,rootIdentity:queueRoot(p.root),revision:0,status:'paused',reason:'Start explicitly to run the listed tasks.',session:null,policyDigest:null,scope:[],tasks:[]};
 if(typeof row.data!=='string')throw queueError('Queue storage unavailable.',503);
 let q:QueueState;try{q=validate(parseNativeJSON(row.data,600000));}catch{throw queueError('Queue storage unavailable.',503);}
 if(q.projectId!==projectId||q.root!==p.root)throw queueError('Queue project reference unavailable.',503);
 const links=store.db.prepare("SELECT CASE WHEN typeof(chat_id)='text' AND length(CAST(chat_id AS BLOB))<=200 THEN chat_id END chat_id,CASE WHEN typeof(task_id)='text' AND length(CAST(task_id AS BLOB))<=200 THEN task_id END task_id,CASE WHEN typeof(claim_id)='text' AND length(CAST(claim_id AS BLOB))<=200 THEN claim_id END claim_id,CASE WHEN typeof(root_id)='text' AND length(CAST(root_id AS BLOB))<=200 THEN root_id END root_id FROM queue_links WHERE project_id=? LIMIT 33").all(projectId);
 if(links.length>32||links.length!==q.tasks.filter(t=>t.claim).length||links.some(l=>!q.tasks.some(t=>t.id===l.task_id&&t.claim?.id===l.claim_id&&t.claim?.chatId===l.chat_id&&t.claim?.rootId===l.root_id)))throw queueError('Original queue claim links unavailable. No claim can be reset or replayed.',503);return q;
});}
export function writeQueue(store:Store,input:QueueState){const q=validate(input),data=JSON.stringify(q);if(Buffer.byteLength(data)>600000)throw queueError('Queue retention capacity reached.',409);store.db.prepare('INSERT INTO task_queues VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data').run(q.projectId,data);}
export function revokeQueue(q:QueueState,reason:string){if(q.revision>=Number.MAX_SAFE_INTEGER)throw queueError('Queue revision exhausted.',503);q.revision++;q.status='paused';q.reason=reason.slice(0,256);q.scope=[];q.session=null;q.policyDigest=null;}
export function queueEvidence(store:Store,table:'events'|'messages'|'state',key:number|string,chatId?:string,max=8192):Record<string,unknown>{
 const row=table==='events'?store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=? THEN data END AS data FROM events WHERE id=? AND chat_id=?").get(max,key,chatId!):table==='messages'?store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=? THEN data END AS data FROM messages WHERE id=? AND chat_id=?").get(max,key,chatId!):store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=? THEN data END AS data FROM state WHERE key=?").get(max,key);
 if(typeof row?.data!=='string')throw queueError('Original queue evidence unavailable.',503);const value=parseNativeJSON(row.data,max);if(!value||typeof value!=='object'||Array.isArray(value))throw queueError('Original queue evidence unavailable.',503);return value as Record<string,unknown>;
}
