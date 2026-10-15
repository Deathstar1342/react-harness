import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {createTwoFilesPatch} from 'diff';
import type {FileSnapshot,ToolResult} from '../shared/types.js';
import type {Runtime} from './runtime.js';
import {projectSkillPath,parseSkill} from './skill-files.js';
import {WorkspaceFiles} from './tools/files.js';
import {reserveMutation} from './tools/mutations.js';
import {hash} from './tools/paths.js';
import {invalidateGoal} from './goals.js';

interface WritePreview {
  owner?:string;
  id:string;chatId:string;scope:'project'|'personal';name:string;destination:string;modeVersion:number|undefined;
  sourceRevision?:string;selectionRevision:number;expiresAt:number;status:'prepared'|'recording'|'done'|'rejected'|'unknown';
  changes:{before:FileSnapshot;after:FileSnapshot}[];diff:string;
}
/** Human route only. There is deliberately no registry handler for personal writes. */
export class SkillWrites {
  private personal=new WorkspaceFiles({maxFileBytes:32000,maxEntries:64,maxSearchFiles:64,leaseMs:45000});
  constructor(private runtime:Runtime) {
    for(const row of runtime.store.db.prepare("SELECT data FROM state WHERE key LIKE 'skills:write:%' AND json_extract(data,'$.status') IN ('recording','unknown')").all()) {
      const preview=JSON.parse(String(row.data)) as WritePreview;
      if(runtime.store.chats().some(chat=>chat.id===preview.chatId))runtime.recordSkillUncertainty(preview.chatId,preview.id);
    }
  }
  private assertWritable(chatId:string) {
    const chat=this.runtime.store.chat(chatId);
    if(chat.mode==='plan')throw new Error('Planning mode cannot save or promote skills. Start building first.');
    this.runtime.processes.assertIdle(chat.projectId);
    this.runtime.store.assertInstallRemovalSafe(chat.projectId);
    for(const related of this.runtime.store.chats(chat.projectId))if(this.runtime.store.db.prepare("SELECT key FROM state WHERE key LIKE 'skills:write:%' AND json_extract(data,'$.chatId')=? AND json_extract(data,'$.status') IN ('recording','unknown') LIMIT 1").get(related.id))throw new Error('A skill write outcome is unknown. Inspect retained evidence; no automatic replay or generic reset.');
    return chat;
  }
  private publish(preview:WritePreview) {
    const store=this.runtime.store;
    const count=Number(store.db.prepare("SELECT count(*) AS n FROM state WHERE key LIKE 'skills:write:%' AND json_extract(data,'$.chatId')=?").get(preview.chatId)!.n);
    if(count>=64)throw new Error('Skill write history reached 64 retained previews for this chat. Retained uncertainty cannot be discarded.');
    store.transaction(()=>store.setState(`skills:write:${preview.id}`,preview));
    return {id:preview.id,scope:preview.scope,name:preview.name,destination:preview.destination,diff:preview.diff,expiresAt:preview.expiresAt};
  }
  async preview(chatId:string,name:string,content:string,baseHash:string|null,owner?:string) {
    const chat=this.assertWritable(chatId),root=this.runtime.store.project(chat.projectId).path;
    parseSkill(content,name);
    const action={name:'save_skill',args:{name,content,baseHash}};
    const inspection=await this.runtime.tools.inspect({projectRoot:root,chatId,agentId:'human-skill-editor'},action);
    this.assertWritable(chatId);
    return this.publish({id:randomUUID(),chatId,scope:'project',name,owner,destination:projectSkillPath(name),modeVersion:chat.modeVersion,selectionRevision:this.runtime.skills.selection(chatId).revision,expiresAt:Date.now()+300000,status:'prepared',changes:inspection.changes!,diff:inspection.diff!});
  }
  async promotion(chatId:string,name:string,sourceRevision:string) {
    const chat=this.assertWritable(chatId),home=await this.runtime.skills.assertHome();
    const source=await this.runtime.skills.files(chatId).load('project',name);
    if(source.revision!==sourceRevision)throw new Error('Promotion source revision is stale.');
    const changes:WritePreview['changes']=[];
    for(const file of [{path:'SKILL.md',content:source.content},...source.resources]) {
      const relative=`skills/${name}/${file.path}`,before=await this.personal.read(home,relative);
      changes.push({before,after:{path:relative,content:file.content,hash:hash(file.content)}});
    }
    const diff=changes.map(c=>createTwoFilesPatch(c.before.path,c.after.path,c.before.content,c.after.content)).join('\n');
    if(Buffer.byteLength(diff)>200000)throw new Error('Promotion diff exceeds 200000 bytes.');
    this.assertWritable(chatId);
    return this.publish({id:randomUUID(),chatId,scope:'personal',name,destination:path.join(home,'skills',name),sourceRevision,modeVersion:chat.modeVersion,selectionRevision:this.runtime.skills.selection(chatId).revision,expiresAt:Date.now()+300000,status:'prepared',changes,diff});
  }
  async commit(chatId:string,id:string,destination:string,authenticated=false) {
    const {store,tools,skills}=this.runtime;
    const preview=store.getState<WritePreview|null>(`skills:write:${id}`,null);
    if(!preview || preview.chatId!==chatId || preview.status!=='prepared' || preview.destination!==destination || preview.expiresAt<Date.now())throw new Error('Skill preview is stale, consumed or unavailable. Never replay uncertain writes.');
    if(preview.scope==='personal'&&!authenticated)throw new Error('Personal promotion requires authentication.');
    const chat=this.assertWritable(chatId);
    if(chat.modeVersion!==preview.modeVersion || skills.selection(chatId).revision!==preview.selectionRevision)throw new Error('Skill preview mode or selection revision is stale.');
    return this.runtime.exclusiveProjectEdit(chat.projectId,async()=>{
      const projectRoot=store.project(chat.projectId).path,reservation=reserveMutation(projectRoot);
      let personalReservation:ReturnType<typeof reserveMutation>|undefined,claimed=false;
      try {
        const root=preview.scope==='personal'?await skills.assertHome():projectRoot;
        if(preview.scope==='personal') {
          personalReservation=reserveMutation(root);
          if(store.db.prepare("SELECT key FROM state WHERE key LIKE 'skills:write:%' AND json_extract(data,'$.scope')='personal' AND json_extract(data,'$.status') IN ('recording','unknown') LIMIT 1").get())throw new Error('A personal skill write is uncertain; inspect retained evidence. No automatic retry or reconciliation.');
          if((await skills.files(chatId).load('project',preview.name)).revision!==preview.sourceRevision)throw new Error('Promotion source changed since preview.');
        }
        for(const change of preview.changes) {
          const before=await (preview.scope==='personal'?this.personal.read(root,change.before.path):tools.read(root,change.before.path));
          if(before.hash!==change.before.hash)throw new Error('Skill destination changed since preview.');
        }
        if(preview.scope==='personal'&&(await skills.files(chatId).load('project',preview.name)).revision!==preview.sourceRevision)throw new Error('Promotion source revision became stale during destination checks.');
        // Repeat current application bindings after all awaited reads, then COMMIT intent before any effects.
        const latest=store.getState<WritePreview>(`skills:write:${id}`,preview);
        if(latest.status!=='prepared'||store.chat(chatId).mode==='plan'||store.chat(chatId).modeVersion!==preview.modeVersion||skills.selection(chatId).revision!==preview.selectionRevision)throw new Error('Skill preview changed before dispatch.');
        store.transaction(()=>{
          const latest=store.getState<WritePreview>(`skills:write:${id}`,preview);
          if(latest.status!=='prepared'||store.chat(chatId).mode==='plan'||store.chat(chatId).modeVersion!==preview.modeVersion||skills.selection(chatId).revision!==preview.selectionRevision)throw new Error('Skill preview changed at intent commit.');
          preview.status='recording';store.setState(`skills:write:${id}`,preview);
          if(preview.scope==='project')store.recordFileChange({id,projectId:chat.projectId,chatId,path:preview.changes[0].before.path,createdAt:new Date().toISOString(),status:'recording',...preview.changes[0]});
        });claimed=true;
        let result:ToolResult;
        if(preview.scope==='project')result=await tools.execute({projectRoot,chatId,agentId:preview.owner??'human-skill-editor',mutationOwner:reservation.owner},{name:'save_skill',args:{name:preview.name,content:preview.changes[0].after.content,baseHash:preview.changes[0].before.hash}});
        else {
          for(const change of preview.changes)await this.personal.save(root,change.before.path,change.after.content,change.before.hash);
          result={ok:true,output:'Personal workflow promoted by explicit human action.'};
        }
        const uncertain=(result.data as {mutation?:string;uncertain?:boolean}|undefined);
        preview.status=result.ok?'done':uncertain?.mutation==='not_started'?'rejected':'unknown';
        store.transaction(()=>{
          store.setState(`skills:write:${id}`,preview);
          if(preview.scope==='project')store.transitionFileChange(id,'recording',result.ok?'confirmed':preview.status==='rejected'?'rejected':'unknown');
          invalidateGoal(store,chatId,'Skill save or promotion requires fresh review.');
          store.event(chatId,'skill_saved',{name:preview.name,scope:preview.scope,status:preview.status,source:'human'});
        });
        if(preview.scope==='project')this.runtime.notifyFileChange(chat.projectId,preview.changes[0].before.path,'editor');
        if(!result.ok)throw new Error(result.output);
        return {ok:true,status:preview.status};
      }catch(error) {
        if(claimed)try {store.transaction(()=>{const current=store.getState<WritePreview>(`skills:write:${id}`,preview);if(current.status==='recording'){current.status='unknown';store.setState(`skills:write:${id}`,current);if(preview.scope==='project')store.transitionFileChange(id,'recording','unknown');}});if(store.getState<WritePreview>(`skills:write:${id}`,preview).status==='unknown')this.runtime.recordSkillUncertainty(chatId,id);}catch{/* retained recording claim remains non-replayable and restart links its uncertainty */}
        throw error;
      }finally{personalReservation?.release();reservation.release();}
    });
  }
}
