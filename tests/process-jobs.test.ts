import {Previews} from '../server/previews.js';
import {previewRecord,previewRecords,previewProject,previewAuthority} from '../server/preview-state.js';
import {randomUUID} from 'node:crypto';
import {rename} from 'node:fs/promises';
import {validateAction} from '../server/tool-registry.js';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {WorkspaceTools} from '../server/tools/index.js';
import {ProcessJobs,processRecords,type ProcessOrigin,type ProcessRecord} from '../server/process-jobs.js';
import {reserveMutation} from '../server/tools/mutations.js';
import {nativeReply,nativeState} from './native-fixture.js';
import type {RunState} from '../server/runtime.js';
import type {ToolContext,ToolResult} from '../shared/types.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanup.splice(0).reverse())await fn();});
function deferred<T=void>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function fixture(secrets:string[]=[],previewPort?:number) {
  const root=await mkdtemp(path.join(tmpdir(),'m25-process-'));await mkdir(path.join(root,'project'));
  const store=new Store(path.join(root,'state.sqlite')),tools=new WorkspaceTools();
  const project=store.createProject('Processes',path.join(root,'project')),chat=store.createChat(project.id,'Processes','autonomous');
  store.initializePlanning();
  const args={command:'fixture command',timeoutMs:600000,...(previewPort===undefined?{}:{previewPort})};
  const binding={claimId:randomUUID(),binding:'a'.repeat(64),sessionId:randomUUID(),expiresAt:Date.now()+30000,identity:{storageId:randomUUID(),projectId:'b'.repeat(64),imageId:'sha256:'+'c'.repeat(64),layout:'d'.repeat(64)}};
  const call=nativeReply('start_process',args).toolCalls![0];
  const state=nativeState<RunState>({frames:[{id:'architect',role:'architect',messages:[],repairs:0},{id:'coder',role:'coder',messages:[{role:'assistant',content:'',tool_calls:[call]}],repairs:0}],generation:0,steps:0,steering:[],planOnly:false,instructionsHash:null});
  store.setState(`run:${chat.id}`,state);store.setState(`native:frame:${chat.id}:coder`,state.frames[1].messages);
  const jobs=new ProcessJobs(store,tools,()=>secrets);tools.configureMutationGuard((root,owner)=>jobs.guard(root,owner));
  const origin:ProcessOrigin={projectId:project.id,chatId:chat.id,frameId:'coder',taskId:'architect',callId:call.id,commandId:'command-id',generation:0,modeVersion:store.chat(chat.id).modeVersion??0,instructionsHash:null,targets:[],approvalMode:'autonomous'};
  const setup=deferred(),finish=deferred<ToolResult>(),started=deferred();let dispatches=0,context:ToolContext|undefined;
  const execute=vi.spyOn(tools,'execute').mockImplementation(async ctx=>{context=ctx;await setup.promise;try{await ctx.prepareCommand?.();ctx.beforeCommand?.(previewPort===undefined?undefined:binding);dispatches++;started.resolve();return await finish.promise;}catch{return {ok:false,output:'Stopped before dispatch',data:{status:'not_started'}};}});
  const close=vi.spyOn(tools,'closeCommandContext').mockResolvedValue(undefined);
  cleanup.push(async()=>{setup.resolve();finish.resolve({ok:false,output:'Fixture closed',data:{cancelled:true}});await jobs.close().catch(()=>{});await tools.dispose();store.close();await rm(root,{recursive:true,force:true});});
  const start=()=>jobs.start(origin,{name:'start_process',args}).data as {id:string};
  const settle=async()=>{await jobs.drainChat(chat.id);return processRecords(store,project.id).at(-1)!;};
  return {root,project,chat,store,tools,jobs,origin,state,setup,finish,started,execute,close,start,settle,binding,get dispatches(){return dispatches;},get context(){return context;}};
}

describe('durable owned process lifecycle (portable synthetic executor)',()=>{
  it.each(['pause','steering','mode','guidance','approval','goal'])('revalidates %s after held setup and never dispatches stale authorization',async kind=>{
    const t=await fixture();t.start();await Promise.resolve();
    if(kind==='pause'){t.store.updateChat(t.chat.id,{status:'paused'});t.jobs.stopChat(t.chat.id);}
    if(kind==='steering'){t.store.setState(`run:${t.chat.id}`,{...t.state,generation:1,steering:['new requirement']});t.jobs.stopChat(t.chat.id);}
    if(kind==='mode')t.store.updateChat(t.chat.id,{mode:'plan',modeVersion:1});
    if(kind==='guidance')await writeFile(path.join(t.project.path,'AGENTS.md'),'new guidance');
    if(kind==='approval')t.store.updateChat(t.chat.id,{approvalMode:'review'});
    if(kind==='goal')t.store.setState(`run:${t.chat.id}`,{...t.state,generation:1});
    t.setup.resolve();expect((await t.settle()).status).toBe('not_started');expect(t.dispatches).toBe(0);
    expect(()=>t.jobs.assertIdle(t.project.id)).not.toThrow();
  });
  it('commits claim before dispatch, bounds output and cursor, and rejects ownership/cross-chat access',async()=>{
    const t=await fixture(),handle=t.start();
    expect(processRecords(t.store,t.project.id)[0]).toMatchObject({status:'starting',dispatched:false,callId:t.origin.callId});
    expect(()=>t.jobs.start(t.origin,{name:'start_process',args:{command:'second'}})).toThrow('mutation');
    t.setup.resolve();await t.started.promise;
    expect(processRecords(t.store,t.project.id)[0].status).toBe('running');
    t.context!.onOutput!('é'.repeat(40000));
    const output=await t.jobs.observe(handle.id,t.chat.id,['coder'],0,8);
    expect(Buffer.byteLength(output.output)).toBe(8);expect(output.endOffset).toBe(64000);expect(output.truncated).toBe(true);
    await expect(t.jobs.observe(handle.id,t.chat.id,['other'])).rejects.toThrow('belong');
    await expect(t.jobs.observe(handle.id,'other',['coder'])).rejects.toThrow('belong');
    await expect(t.jobs.cancel(handle.id,t.chat.id,'other')).rejects.toThrow('another');
    await expect(t.jobs.observe(handle.id,t.chat.id,['coder'],1)).rejects.toThrow('UTF-8');
    t.finish.resolve({ok:true,output:'ignored duplicate',data:{exitCode:0,output:'ignored duplicate'}});
    expect((await t.settle()).status).toBe('completed');expect(t.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(processRecords(t.store,t.project.id))).not.toContain('ignored duplicate');
    expect(()=>t.jobs.assertIdle(t.project.id)).not.toThrow();
  });
  it('requires namespace cleanup before releasing the mutation reservation',async()=>{
    const t=await fixture(),drain=deferred();t.close.mockImplementation(()=>drain.promise);t.start();t.setup.resolve();await t.started.promise;
    t.finish.resolve({ok:true,output:'',data:{exitCode:0}});await Promise.resolve();await Promise.resolve();
    await expect(t.tools.save(t.project.path,'blocked','x',null)).rejects.toThrow('mutation');
    drain.resolve();expect((await t.settle()).status).toBe('completed');
    expect(await t.tools.save(t.project.path,'allowed','x',null)).toMatchObject({content:'x'});
  });
  it('serializes both start-versus-editor race orders using the shared private reservation',async()=>{
    const t=await fixture();
    const editor=reserveMutation(t.project.path);
    expect(()=>t.start()).toThrow('mutation');expect(processRecords(t.store,t.project.id)).toHaveLength(0);editor.release();
    t.start();await expect(t.tools.save(t.project.path,'file','manual',null)).rejects.toThrow();
    t.jobs.stopChat(t.chat.id);t.setup.resolve();await t.settle();expect(t.dispatches).toBe(0);
    expect(await t.tools.save(t.project.path,'file','manual',null)).toMatchObject({content:'manual'});
  });
  it.each(['claim','dispatch','result'])('retains durable no-replay semantics after %s COMMIT failure',async point=>{
    const t=await fixture(),exec=t.store.db.exec.bind(t.store.db);let armed=point==='claim';
    const fault=vi.spyOn(t.store.db,'exec').mockImplementation(sql=>{if(sql==='COMMIT'&&armed){armed=false;throw new Error('Injected process COMMIT fault');}return exec(sql);});
    if(point==='claim'){expect(()=>t.start()).toThrow('COMMIT');expect(processRecords(t.store,t.project.id)).toHaveLength(0);expect(t.execute).not.toHaveBeenCalled();return;}
    t.start();if(point==='dispatch')armed=true;t.setup.resolve();
    if(point==='result'){await t.started.promise;armed=true;t.finish.resolve({ok:true,output:'',data:{exitCode:0}});}
    const outcome=await t.settle();expect(outcome.status).toBe(point==='dispatch'?'not_started':'uncertain');
    expect(t.dispatches).toBe(point==='dispatch'?0:1);fault.mockRestore();
    t.store.recover();expect(t.dispatches).toBe(point==='dispatch'?0:1);
    if(point==='result')expect(()=>t.jobs.assertIdle(t.project.id)).toThrow('uncertain');
  });
  it('retains restart uncertainty without adopting a process or replaying a resolved start call',async()=>{
    const t=await fixture();const handle=t.start();await Promise.resolve();t.store.recover();
    expect(processRecords(t.store,t.project.id)[0].status).toBe('uncertain');
    t.setup.resolve();await t.settle();expect(t.dispatches).toBe(0);
    // Recovery cannot be downgraded by a late callback from an obsolete backend.
    expect((await t.jobs.observe(handle.id,t.chat.id,['coder'])).status).toBe('uncertain');
  });
  it('redacts backend keys across split output chunks without storing a duplicate raw result',async()=>{
    const t=await fixture(['backend-secret-fixture']);const handle=t.start();t.setup.resolve();await t.started.promise;
    t.context!.onOutput!('before backend-se');t.context!.onOutput!('cret-fixture after');
    t.finish.resolve({ok:true,output:'backend-secret-fixture',data:{exitCode:0,output:'backend-secret-fixture'}});await t.settle();
    expect((await t.jobs.observe(handle.id,t.chat.id,['coder'])).output).toBe('before [redacted] after');
    expect(JSON.stringify(t.store.events(t.chat.id))).not.toContain('backend-secret-fixture');
    expect(JSON.stringify(processRecords(t.store))).not.toContain('backend-secret-fixture');
  });
  it('does not release ownership or accept exit zero when namespace cleanup is unconfirmed',async()=>{
    const t=await fixture();t.close.mockRejectedValue(new Error('Injected namespace cleanup failure'));
    t.start();t.setup.resolve();await t.started.promise;t.finish.resolve({ok:true,output:'',data:{exitCode:0}});
    await expect(t.jobs.drainChat(t.chat.id)).rejects.toThrow('retain backend ownership');
    expect(processRecords(t.store)[0].status).toBe('uncertain');
    await expect(t.tools.save(t.project.path,'forbidden','x',null)).rejects.toThrow();
    await expect(t.jobs.close()).rejects.toThrow('retain backend ownership');
  });
  it('rejects unsupported dispatch hooks before creating a process claim',async()=>{
    const t=await fixture();Object.defineProperty(t.tools,'processLifecycle',{value:undefined});
    expect(()=>t.start()).toThrow('unavailable');expect(processRecords(t.store)).toHaveLength(0);expect(t.execute).not.toHaveBeenCalled();
  });
});


describe('M35 exact preview process admission (portable disk SQLite and doubled transport)',()=>{
  it('validates the approved port in the complete native action and excludes worker control ports',()=>{
    for(const previewPort of [true,1,3128,65536,'3000'])expect(()=>validateAction({name:'start_process',args:{command:'server',previewPort}})).toThrow();
    expect(validateAction({name:'start_process',args:{command:'server',previewPort:3001}}).args.previewPort).toBe(3001);
  });
  it('commits the private exact worker binding and projects bounded metadata without full state reads',async()=>{
    const t=await fixture([],3001),handle=t.start();t.setup.resolve();await t.started.promise;
    expect(t.context?.previewPort).toBe(3001);expect(processRecords(t.store)[0].workerBinding).toEqual(t.binding);
    const full=vi.spyOn(t.store,'getState').mockImplementation(()=>{throw new Error('Full state materialization refused by test');});
    const project=vi.spyOn(t.store,'project').mockImplementation(()=>{throw new Error('Full project materialization refused by test');});
    expect(t.jobs.previewBinding(t.project.id,handle.id).binding).toEqual(t.binding);
    const previews=new Previews(t.store,t.jobs,true);const list=previews.list(t.project.id);expect(list.entries[0]).toMatchObject({port:3001,status:'starting'});
    const view=previews.open(t.project.id,handle.id);expect(view.processId).toBe(handle.id);expect(JSON.stringify({list,view})).not.toContain(t.binding.binding);expect(t.dispatches).toBe(1);
    full.mockRestore();project.mockRestore();previews.shutdown();
  });
  it('denies stale root, current mode/generation/guidance/skills/steering and foreign project bindings',async()=>{
    const t=await fixture([],3001),handle=t.start();t.setup.resolve();await t.started.promise;
    for(const update of [{generation:1},{instructionsHash:'e'.repeat(64)},{skillsHash:'f'.repeat(64)},{steering:['new requirement']},{frames:[]}]){
      t.store.setState('run:'+t.chat.id,{...t.state,...update});expect(()=>t.jobs.previewBinding(t.project.id,handle.id)).toThrow();t.store.setState('run:'+t.chat.id,t.state);
    }
    expect(()=>t.jobs.previewBinding(randomUUID(),handle.id)).toThrow();
    t.store.updateChat(t.chat.id,{mode:'plan',modeVersion:1});expect(()=>t.jobs.previewBinding(t.project.id,handle.id)).toThrow();t.store.updateChat(t.chat.id,{mode:'execute',modeVersion:0});
    await rename(t.project.path,t.project.path+'-retained');await mkdir(t.project.path);expect(()=>t.jobs.previewBinding(t.project.id,handle.id)).toThrow(/identity|stale/);
  });
  it('rejects unknown/oversized private evidence before parsing and cannot hide it as no preview',async()=>{
    const t=await fixture([],3001),handle=t.start();t.setup.resolve();await t.started.promise;
    const record=processRecords(t.store)[0],run=t.store.getState('run:'+t.chat.id,null);
    for(const raw of ['{broken',JSON.stringify({...record,padding:'x'.repeat(262145)})]){
      t.store.db.prepare('UPDATE state SET data=? WHERE key=?').run(raw,'process-job:'+handle.id);expect(()=>previewRecords(t.store,t.project.id)).toThrow();expect(()=>t.jobs.previewBinding(t.project.id,handle.id)).toThrow();
    }
    t.store.setState('process-job:'+handle.id,record);
    t.store.setState('run:'+t.chat.id,{...t.state,padding:'x'.repeat(2097153)});expect(()=>previewAuthority(t.store,t.project.id,handle.id)).toThrow();t.store.setState('run:'+t.chat.id,run);
  });
  it('rejects source-key/embedded IDs, registered root disagreement and duplicates in original private JSON',async()=>{
    const t=await fixture([],3001),handle=t.start();t.setup.resolve();await t.started.promise;
    const processKey='process-job:'+handle.id,runKey='run:'+t.chat.id;
    const processRaw=String(t.store.db.prepare('SELECT data FROM state WHERE key=?').get(processKey)!.data),runRaw=String(t.store.db.prepare('SELECT data FROM state WHERE key=?').get(runKey)!.data);
    const chatRaw=String(t.store.db.prepare('SELECT data FROM chats WHERE id=?').get(t.chat.id)!.data),projectRaw=String(t.store.db.prepare('SELECT data FROM projects WHERE id=?').get(t.project.id)!.data);
    const substituted=JSON.parse(processRaw);substituted.id=randomUUID();t.store.setState(processKey,substituted);expect(()=>previewRecord(t.store,handle.id)).toThrow(/key/);expect(()=>previewRecords(t.store,t.project.id)).toThrow(/identity/);
    for(const raw of [processRaw.replace('"generation":0','"generation":0,"generation":1'),processRaw.replace('"previewPort":3001','"previewPort":3001,"previewPort":3128'),processRaw.replace('"storageId":','"layout":"e", "storageId":')]){
      t.store.db.prepare('UPDATE state SET data=? WHERE key=?').run(raw,processKey);expect(()=>previewRecord(t.store,handle.id)).toThrow();expect(()=>previewRecords(t.store,t.project.id)).toThrow();
    }
    t.store.db.prepare('UPDATE state SET data=? WHERE key=?').run(processRaw,processKey);
    for(const raw of [runRaw.replace('"generation":0','"generation":0,"generation":1'),runRaw.replace('"id":"coder"','"id":"coder","id":"foreign"'),runRaw.replace('"messages":[]','"messages":[],"messages":[{"content":"hidden"}]')]){
      t.store.db.prepare('UPDATE state SET data=? WHERE key=?').run(raw,runKey);expect(()=>previewAuthority(t.store,t.project.id,handle.id)).toThrow();
    }
    t.store.db.prepare('UPDATE state SET data=? WHERE key=?').run(runRaw,runKey);
    t.store.db.prepare('UPDATE chats SET data=? WHERE id=?').run(chatRaw.replace('"modeVersion":0','"modeVersion":0,"modeVersion":1'),t.chat.id);expect(()=>previewAuthority(t.store,t.project.id,handle.id)).toThrow();t.store.db.prepare('UPDATE chats SET data=? WHERE id=?').run(chatRaw,t.chat.id);
    t.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(projectRaw),path:t.root}),t.project.id);expect(()=>previewProject(t.store,t.project.id)).toThrow();
    t.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(projectRaw.replace('"id":','"path":"substituted","id":'),t.project.id);expect(()=>previewProject(t.store,t.project.id)).toThrow();t.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(projectRaw,t.project.id);
  });
  it('bounds and closes exact response pages, exposes no capability and never retries a lost open',async()=>{
    const t=await fixture([],3001),handle=t.start();t.setup.resolve();await t.started.promise;const ops:string[]=[];
    let lose=false;const body=Buffer.from('owned preview');
    const transport={sessionId:t.binding.sessionId,storageId:t.binding.identity.storageId,request:async(op:string,input:unknown)=>{
      const value=input as Record<string,unknown>;ops.push(op);expect(value.claimId).toBe(t.binding.claimId);expect(value.binding).toBe(t.binding.binding);
      if(op==='preview_open'){if(lose)throw new Error('Accepted reply lost');return {handle:responseId,status:200,contentType:'text/html; charset=utf-8',totalBytes:body.length};}
      if(op==='preview_read')return {handle:responseId,offset:0,nextOffset:body.length,totalBytes:body.length,data:body.toString('base64')};
      if(op==='preview_close')return {handle:responseId,closed:true};throw new Error('Unknown request');
    }};const responseId=randomUUID(),previews=new Previews(t.store,t.jobs,true,async()=>transport),view=previews.open(t.project.id,handle.id);
    expect(await previews.resource(t.project.id,view.id,'/')).toEqual({status:200,contentType:'text/html; charset=utf-8',body:body.toString('base64')});expect(ops).toEqual(['preview_open','preview_read','preview_close']);expect(previews.list(t.project.id).entries[0].status).toBe('ready');
    lose=true;await expect(previews.resource(t.project.id,view.id,'/')).rejects.toThrow('unavailable');expect(ops.filter(op=>op==='preview_open')).toHaveLength(2);expect(t.dispatches).toBe(1);expect(()=>t.jobs.assertIdle(t.project.id)).toThrow();previews.shutdown();
  });
  it('revokes late resource data on renderer close and on cancellation without releasing the writer early',async()=>{
    const t=await fixture([],3001),handle=t.start();t.setup.resolve();await t.started.promise;const held=deferred<unknown>(),responseId=randomUUID();
    const transport={sessionId:t.binding.sessionId,storageId:t.binding.identity.storageId,request:async(op:string)=>{if(op==='preview_open')return held.promise;if(op==='preview_close')return {handle:responseId,closed:true};throw new Error('Late data must not be read');}};
    const previews=new Previews(t.store,t.jobs,true,async()=>transport),view=previews.open(t.project.id,handle.id),resource=previews.resource(t.project.id,view.id,'/');await Promise.resolve();previews.close(t.project.id,view.id);
    held.resolve({handle:responseId,status:200,contentType:'text/html',totalBytes:0});await expect(resource).rejects.toThrow('unavailable');expect(()=>t.jobs.assertIdle(t.project.id)).toThrow();
    t.jobs.stopChat(t.chat.id);expect(()=>t.jobs.previewBinding(t.project.id,handle.id)).toThrow();previews.shutdown();
  });
});
