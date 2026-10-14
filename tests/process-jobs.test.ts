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
async function fixture(secrets:string[]=[]) {
  const root=await mkdtemp(path.join(tmpdir(),'m25-process-'));await mkdir(path.join(root,'project'));
  const store=new Store(path.join(root,'state.sqlite')),tools=new WorkspaceTools();
  const project=store.createProject('Processes',path.join(root,'project')),chat=store.createChat(project.id,'Processes','autonomous');
  store.initializePlanning();
  const call=nativeReply('start_process',{command:'fixture command',timeoutMs:600000}).toolCalls![0];
  const state=nativeState<RunState>({frames:[{id:'architect',role:'architect',messages:[],repairs:0},{id:'coder',role:'coder',messages:[{role:'assistant',content:'',tool_calls:[call]}],repairs:0}],generation:0,steps:0,steering:[],planOnly:false,instructionsHash:null});
  store.setState(`run:${chat.id}`,state);store.setState(`native:frame:${chat.id}:coder`,state.frames[1].messages);
  const jobs=new ProcessJobs(store,tools,()=>secrets);tools.configureMutationGuard((root,owner)=>jobs.guard(root,owner));
  const origin:ProcessOrigin={projectId:project.id,chatId:chat.id,frameId:'coder',taskId:'architect',callId:call.id,commandId:'command-id',generation:0,modeVersion:store.chat(chat.id).modeVersion??0,instructionsHash:null,targets:[],approvalMode:'autonomous'};
  const setup=deferred(),finish=deferred<ToolResult>(),started=deferred();let dispatches=0,context:ToolContext|undefined;
  const execute=vi.spyOn(tools,'execute').mockImplementation(async ctx=>{context=ctx;await setup.promise;try{await ctx.prepareCommand?.();ctx.beforeCommand?.();dispatches++;started.resolve();return await finish.promise;}catch{return {ok:false,output:'Stopped before dispatch',data:{status:'not_started'}};}});
  const close=vi.spyOn(tools,'closeCommandContext').mockResolvedValue(undefined);
  cleanup.push(async()=>{setup.resolve();finish.resolve({ok:false,output:'Fixture closed',data:{cancelled:true}});await jobs.close().catch(()=>{});await tools.dispose();store.close();await rm(root,{recursive:true,force:true});});
  const start=()=>jobs.start(origin,{name:'start_process',args:{command:'fixture command',timeoutMs:600000}}).data as {id:string};
  const settle=async()=>{await jobs.drainChat(chat.id);return processRecords(store,project.id).at(-1)!;};
  return {root,project,chat,store,tools,jobs,origin,state,setup,finish,started,execute,close,start,settle,get dispatches(){return dispatches;},get context(){return context;}};
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
