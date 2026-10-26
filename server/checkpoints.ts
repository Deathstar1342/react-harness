import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import type {CheckpointList,CheckpointPreview,CheckpointSummary,CheckpointRestoreSummary,CheckpointAccess} from '../shared/types.js';
import type {Store} from './store.js';
import type {Runtime} from './runtime.js';
import {checkpointTree,checkpointPolicy,checkpointLimits,type CheckpointFile} from './checkpoint-files.js';
import {boundedDiff} from './changes.js';
import {hash} from './tools/paths.js';
import {checkpointSave,checkpointSaveJournal,checkpointSaveEffects,checkpointMetadata,checkpointLoad,checkpointExactClaim,checkpointValidateJournal,checkpointChangeDigest,checkpointHeaderIntegrity,checkpointJournalIntegrity,checkpointContext,checkpointProject,checkpointRows,checkpointJSON,checkpointRecordSchema,checkpointJournalSchema,checkpointIntegrity,CHECKPOINT_STATE_LIMITS,type CheckpointRecord as Record,type CheckpointJournal as Journal,type CheckpointChange as Change} from './checkpoint-state.js';
import {addGoalUncertainty,goalOf,saveGoal} from './goals.js';

export const captureCheckpointInput=z.strictObject({chatId:z.uuid(),label:z.string().trim().max(80).default('Task boundary')});
export const previewCheckpointInput=z.strictObject({chatId:z.uuid()});
export const restoreCheckpointInput=z.strictObject({chatId:z.uuid(),previewToken:z.uuid(),revision:z.string().regex(/^[a-f0-9]{64}$/),confirmation:z.literal('restore-files')});
interface Preview {bytes:number;projectId:string;checkpointId:string;chatId:string;root:string;rootIdentity:string;checkpointIntegrity:string;treeRevision:string;appRevision:string;revision:string;expiresAt:number;changes:Change[]}
const ck=(id:string)=>`checkpoint:v1:${id}`,jk=(id:string)=>`checkpoint-restore:v1:${id}`;
const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const absent=(filename:string):CheckpointFile=>({path:filename,content:'',hash:null,mode:0o600});
const summary=(r:Record):CheckpointSummary=>({id:r.id,projectId:r.projectId,chatId:r.chatId,label:r.label,createdAt:r.createdAt,digest:r.digest,files:r.files.length,bytes:r.bytes,excluded:r.excluded,excludedCount:r.excludedCount});
const journalSummary=(r:Journal):CheckpointRestoreSummary=>({id:r.id,checkpointId:r.checkpointId,createdAt:r.createdAt,status:r.status,files:r.changes.length});


/** Human-only, managed-code checkpoints. No filesystem/SQL journal can authorize model execution. */
export class Checkpoints {
 private previews=new Map<string,Preview>();
 constructor(private store:Store,private runtime:Runtime){}
 private load(projectId:string,id:string):Record {
  return checkpointLoad(this.store,projectId,id);
 }
 list(projectId:string):CheckpointList {
  checkpointProject(this.store,projectId);this.expire();const catalog=checkpointMetadata(this.store);
  const items=catalog.records.map(r=>r.record).filter(r=>r.projectId===projectId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(r=>({...r,files:r.fileCount})).map(({root:_,rootIdentity:__,headerIntegrity:___,integrity:____,policy:_____,fileCount:______,source:_______,...publicSummary})=>publicSummary);
  const restores=catalog.journals.map(r=>r.journal).filter(r=>r.projectId===projectId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(r=>({id:r.id,checkpointId:r.checkpointId,createdAt:r.createdAt,status:r.status,files:r.fileCount}));
  return {items,restores,limits:{files:checkpointLimits.files,fileBytes:checkpointLimits.fileBytes,bytes:checkpointLimits.bytes,projectCount:checkpointLimits.projectCount}};
 }
 private expire(){for(const [id,p]of this.previews)if(p.expiresAt<Date.now())this.previews.delete(id);}
 private appRevision(projectId:string){return checkpointContext(this.store,projectId).revision;}
 private admission(projectId:string,chatId:string){
  const context=checkpointContext(this.store,projectId,chatId),project=context.project;
  if(path.dirname(project.path)!==path.resolve(this.runtime.config.workspaceRoot))throw conflict('Only managed project copies can be checkpointed');
  this.store.assertCheckpointSafe(projectId);
 }
 private async exclusive<T>(projectId:string,chatId:string,operation:(access:CheckpointAccess,root:string)=>Promise<T>):Promise<T>{
  this.admission(projectId,chatId);
  return this.runtime.exclusiveRemoval(projectId,async()=>{
   const root=this.store.project(projectId).path;
   if(!this.runtime.tools.checkpointScope)throw conflict('Safe checkpoint file admission unavailable');
   return this.runtime.tools.checkpointScope(root,async access=>{this.admission(projectId,chatId);return operation(access,root);});
  });
 }
 private referenced(id:string){
  if([...this.previews.values()].some(p=>p.checkpointId===id))return true;
  if(checkpointMetadata(this.store).journals.some(j=>j.journal.checkpointId===id))return true;
  // Bound complete candidate evidence before parsing. Unknown/truncated references refuse retention.
  for(const select of ["SELECT key,data FROM state WHERE key NOT LIKE 'checkpoint:v1:%' AND key NOT LIKE 'checkpoint-meta:v1:%' AND key NOT LIKE 'checkpoint-restore:v1:%' ORDER BY key","SELECT id AS key,data FROM messages ORDER BY id","SELECT CAST(id AS TEXT) AS key,data FROM events ORDER BY id"]){
    const rows=checkpointRows(this.store,select,[],512,2*1024*1024,8*1024*1024);
    for(const row of rows)if(JSON.stringify(checkpointJSON(row.data,2*1024*1024)).includes(id))return true;
  }
  return false;
 }
 private retain(incoming:Record){
  let records=checkpointMetadata(this.store).records;const {files:_,...header}=incoming;const serialized=Buffer.byteLength(JSON.stringify(incoming))+Buffer.byteLength(JSON.stringify(header));
  if(serialized>CHECKPOINT_STATE_LIMITS.recordBytes)throw conflict('Serialized checkpoint exceeds storage record limit');
  const over=()=>{const local=records.filter(r=>r.record.projectId===incoming.projectId);return local.length+1>checkpointLimits.projectCount||local.reduce((n,r)=>n+r.storedBytes,serialized)>checkpointLimits.projectBytes||records.length+1>checkpointLimits.totalCount||records.reduce((n,r)=>n+r.storedBytes,serialized)>CHECKPOINT_STATE_LIMITS.checkpointBytes;};
  while(over()){
   const victim=records.filter(r=>r.record.projectId===incoming.projectId).sort((a,b)=>a.record.createdAt.localeCompare(b.record.createdAt)).find(r=>!this.referenced(r.record.id));
   if(!victim)throw conflict('Checkpoint quota reached; referenced recovery evidence cannot be evicted');
   this.store.db.prepare('DELETE FROM state WHERE key=? OR key=?').run(ck(victim.record.id),`checkpoint-meta:v1:${victim.record.id}`);records=records.filter(r=>r!==victim);
  }
 }
 async capture(projectId:string,input:z.infer<typeof captureCheckpointInput>):Promise<CheckpointSummary>{
  input=captureCheckpointInput.parse(input);
  return this.exclusive(projectId,input.chatId,async(access,root)=>{
   const appRevision=this.appRevision(projectId),first=await checkpointTree(root,access),second=await checkpointTree(root,access);
   if(first.revision!==second.revision||first.digest!==second.digest||appRevision!==this.appRevision(projectId))throw conflict('Checkpoint source or project revision changed while capturing');
   this.admission(projectId,input.chatId);
   const record:Record=checkpointRecordSchema.parse({id:randomUUID(),projectId,chatId:input.chatId,label:input.label||'Task boundary',createdAt:new Date().toISOString(),source:'human',policy:checkpointPolicy,root,rootIdentity:second.rootIdentity,digest:second.digest,fileCount:second.files.length,headerIntegrity:'0'.repeat(64),files:second.files,bytes:second.bytes,excluded:second.excluded,excludedCount:second.excludedCount,integrity:'0'.repeat(64)});record.integrity=checkpointIntegrity(record);record.headerIntegrity=checkpointHeaderIntegrity(record);checkpointRecordSchema.parse(record);
   this.expire();this.store.transaction(()=>{this.retain(record);checkpointSave(this.store,record);});return summary(record);
  });
 }
 async preview(projectId:string,id:string,input:z.infer<typeof previewCheckpointInput>):Promise<CheckpointPreview>{
  input=previewCheckpointInput.parse(input);this.expire();
  return this.exclusive(projectId,input.chatId,async(access,root)=>{
   const record=this.load(projectId,id),appRevision=this.appRevision(projectId),current=await checkpointTree(root,access);
   if(current.rootIdentity!==record.rootIdentity)throw conflict('Checkpoint belongs to a replaced project directory');
   const before=new Map(current.files.map(f=>[f.path,f])),after=new Map(record.files.map(f=>[f.path,f]));
   const changes:Change[]=[];const display:CheckpointPreview['changes']=[];let diffBytes=0;
   for(const filename of [...new Set([...before.keys(),...after.keys()])].sort()){
    const b=before.get(filename)??absent(filename),a=after.get(filename)??absent(filename);
    if(b.hash===a.hash&&b.mode===a.mode)continue;
    for(const part of filename.split('/').slice(0,-1).map((_,index)=>filename.split('/').slice(0,index+1).join('/')))if(before.has(part))throw conflict('File/directory topology changed; checkpoint restore refuses ambiguous replacement');
    const diff=boundedDiff(filename,b.content,a.content,b.hash===null,a.hash===null)+(b.hash!==null&&a.hash!==null&&b.mode!==a.mode?`\nMode ${b.mode.toString(8)} → ${a.mode.toString(8)}\n`:'');
    diffBytes+=Buffer.byteLength(diff);if(diffBytes>checkpointLimits.diffBytes)throw conflict('Checkpoint restore diff exceeds the 200 KB review limit');
    const change={id:randomUUID(),before:b,after:a,digest:''};change.digest=checkpointChangeDigest(change);changes.push(change);display.push({path:filename,kind:b.hash===null?'add':a.hash===null?'remove':'modify',diff});
   }
   // Existing directories cannot be replaced by files; empty dirs intentionally remain untouched.
   const targetNames=record.files.map(f=>f.path);if(targetNames.some(target=>current.directories.includes(target)))throw conflict('File/directory topology changed; checkpoint restore refuses existing directories');for(const filename of current.files.map(f=>f.path))if(targetNames.some(target=>filename.startsWith(target+'/')))throw conflict('File/directory topology changed; inspect it before checkpoint restore');
   if(appRevision!==this.appRevision(projectId)||this.load(projectId,id).integrity!==record.integrity)throw conflict('Project/checkpoint revision changed while previewing');
   this.admission(projectId,input.chatId);
   const revision=hash(JSON.stringify([projectId,id,root,current.rootIdentity,record.integrity,current.revision,appRevision,changes])),expiresAt=Date.now()+300000,previewToken=randomUUID();
   const bytes=Buffer.byteLength(JSON.stringify(changes))+4096;if(bytes>32*1024*1024)throw conflict('Checkpoint preview exceeds the bounded memory limit');
   while(this.previews.size>=100||[...this.previews.values()].reduce((n,p)=>n+p.bytes,bytes)>32*1024*1024)this.previews.delete(this.previews.keys().next().value!);
   this.previews.set(previewToken,{bytes,projectId,checkpointId:id,chatId:input.chatId,root,rootIdentity:current.rootIdentity,checkpointIntegrity:record.integrity,treeRevision:current.revision,appRevision,revision,expiresAt,changes});
   return {checkpoint:summary(record),previewToken,revision,expiresAt,changes:display,currentExcludedCount:current.excludedCount};
  });
 }
 async restore(projectId:string,id:string,input:z.infer<typeof restoreCheckpointInput>):Promise<CheckpointRestoreSummary>{
  input=restoreCheckpointInput.parse(input);this.expire();
  const preview=this.previews.get(input.previewToken);
  if(!preview||preview.projectId!==projectId||preview.checkpointId!==id||preview.chatId!==input.chatId||preview.revision!==input.revision)throw conflict('Checkpoint preview is stale, expired or consumed; preview again');
  return this.exclusive(projectId,input.chatId,async(access,root)=>{
   const record=this.load(projectId,id),current=await checkpointTree(root,access);
   if(preview.expiresAt<Date.now()||root!==preview.root||current.rootIdentity!==preview.rootIdentity||current.revision!==preview.treeRevision||this.appRevision(projectId)!==preview.appRevision||record.integrity!==preview.checkpointIntegrity)throw conflict('Checkpoint preview is stale; later edits and revisions must be preserved');
   this.admission(projectId,input.chatId);
   const journal:Journal={id:randomUUID(),projectId,checkpointId:id,chatId:input.chatId,root,rootIdentity:record.rootIdentity,createdAt:new Date().toISOString(),source:'human',confirmation:'restore-files',previewTokenHash:hash(input.previewToken),status:'claiming',revision:preview.revision,checkpointIntegrity:record.integrity,fileCount:preview.changes.length,changesDigest:hash(JSON.stringify(preview.changes.map(c=>c.digest))),integrity:'0'.repeat(64),changes:preview.changes};
   journal.integrity=checkpointJournalIntegrity(journal);checkpointJournalSchema.parse(journal);
   const journals=checkpointMetadata(this.store).journals,journalBytes=Buffer.byteLength(JSON.stringify(journal));
   const prospectiveHistory=journal.changes.reduce((bytes,change)=>bytes+Buffer.byteLength(JSON.stringify({id:change.id,projectId,chatId:input.chatId,path:change.before.path,createdAt:journal.createdAt,status:'recording',source:'checkpoint',restoreId:journal.id}))+Buffer.byteLength(JSON.stringify({before:change.before,after:change.after})),0);
   if(journal.changes.some(c=>Buffer.byteLength(JSON.stringify(c))>1100000)||journalBytes>CHECKPOINT_STATE_LIMITS.journalBytes||journals.length>=CHECKPOINT_STATE_LIMITS.journalCount||journals.filter(j=>j.journal.projectId===projectId).length>=checkpointLimits.journals||journals.reduce((n,j)=>n+j.storedBytes+j.historyBytes,journalBytes+prospectiveHistory)>CHECKPOINT_STATE_LIMITS.journalBytesTotal)throw conflict('Checkpoint restore history quota reached; retained journals cannot be discarded');
   let claimed=false;
   try{
    this.store.transaction(()=>{
     if(this.previews.get(input.previewToken)!==preview||this.appRevision(projectId)!==preview.appRevision||preview.expiresAt<Date.now())throw conflict('Checkpoint preview revision changed before claim');
     checkpointSaveJournal(this.store,journal);checkpointSaveEffects(this.store,journal);
     for(const change of journal.changes)this.store.recordFileChange({id:change.id,projectId,chatId:input.chatId,path:change.before.path,createdAt:journal.createdAt,status:'recording',source:'checkpoint',restoreId:journal.id,before:change.before,after:change.after});
    });claimed=true;this.previews.delete(input.previewToken);
    for(const change of [...journal.changes].sort((a,b)=>Number(a.after.hash!==null)-Number(b.after.hash!==null)||b.before.path.length-a.before.path.length)){
     await access.restore(root,change.after,change.before,()=>checkpointExactClaim(this.store,journal,journal.changes.findIndex(c=>c.id===change.id)));
    }
    const final=await checkpointTree(root,access);if(final.digest!==record.digest||final.rootIdentity!==record.rootIdentity)throw conflict('Restored file set changed before final confirmation');
    checkpointValidateJournal(this.store,journal);
    // Invalidation is safe before completion; a failure leaves the durable claim as a barrier.
    for(const change of journal.changes)this.runtime.notifyFileChange(projectId,change.after.path,'undo');
    this.store.transaction(()=>{
     for(const change of journal.changes){this.store.transitionFileChange(change.id,'recording','confirmed');for(const chat of this.store.chats(projectId))this.store.event(chat.id,'file_changed',{path:change.after.path,source:'undo',hash:change.after.hash,restoreId:journal.id});}
     journal.status='done';journal.integrity=checkpointJournalIntegrity(journal);checkpointSaveJournal(this.store,journal);
    });return journalSummary(journal);
   }catch(error){
    if(!claimed)throw error;
    if(checkpointMetadata(this.store).journals.find(j=>j.journal.id===journal.id)?.journal.status==='done')throw conflict('Checkpoint restore completed, but notification failed. Refresh checkpoint history');
    // If this transaction is vetoed/poisoned, the original claiming journal still blocks all mutation.
    this.store.transaction(()=>{
     journal.status='uncertain';journal.integrity=checkpointJournalIntegrity(journal);checkpointSaveJournal(this.store,journal);
     for(const change of journal.changes)this.store.transitionFileChange(change.id,'recording','unknown');
     for(const chat of this.store.chats(projectId)){
      const event=this.store.event(chat.id,'goal_uncertainty',{restoreId:journal.id,reason:'Checkpoint restore outcome uncertain; no replay or generic waiver.'});
      const goal=goalOf(this.store,chat.id);if(goal){addGoalUncertainty(this.store,chat.id,goal,[event.id]);goal.status='blocked';goal.reason='Checkpoint restore outcome uncertain; inspect retained file history.';saveGoal(this.store,chat.id,goal);}
     }
    });
    throw conflict(`Checkpoint restore outcome is uncertain and cannot replay. ${error instanceof Error?error.message:'Inspect retained history.'}`);
   }
  });
 }
}
