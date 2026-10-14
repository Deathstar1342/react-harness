import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {orchestrationFixture,call,complete,pass,stateOf} from './orchestration-fixture.js';
import {processRecords} from '../server/process-jobs.js';
import {goalOf} from '../server/goals.js';
import {validateNativeHistory} from '../server/provider.js';
import type {RunState} from '../server/runtime.js';
import type {ToolContext,ToolResult} from '../shared/types.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanups.splice(0).reverse())await fn();});
async function fixture(){const t=await orchestrationFixture();cleanups.push(t.close);await t.seed();return t;}
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

describe('M25 real runtime/SQLite policy boundaries with synthetic model/process',()=>{
  it.each([...['outcome','native'].flatMap(boundary=>['setup','running','completed'].map(phase=>({boundary,phase,secondary:''}))),...['cleanup','error-record'].map(secondary=>({boundary:'native',phase:'running',secondary}))])('drains ownership after outer $boundary COMMIT failure at $phase ($secondary) without replay or false acceptance',async({boundary,phase,secondary})=>{
    const t=await fixture(),started=deferred(),cleanup=deferred(),release=deferred();let dispatches=0,faulted=false;
    const originalFailure=new Error(`Injected outer ${boundary} COMMIT fault`);
    if(secondary==='cleanup')cleanups[cleanups.length-1]=async()=>{await t.runtime.close().catch(()=>{});await t.tools.dispose?.();t.store.close();await rm(t.root,{recursive:true,force:true});};
    vi.spyOn(t.tools,'execute').mockImplementation(async context=>{
      if(phase==='setup')await new Promise<void>(resolve=>{context.signal!.addEventListener('abort',()=>resolve(),{once:true});if(context.signal!.aborted)resolve();});
      try{await context.prepareCommand!();context.beforeCommand!();dispatches++;started.resolve();}
      catch{return {ok:false,output:'Not started',data:{status:'not_started'}};}
      if(phase==='completed')return {ok:true,output:'Observed exit',data:{exitCode:0}};
      await writeFile(path.join(t.root,'effect.txt'),'Effect before runtime failure');
      await new Promise<void>(resolve=>{context.signal!.addEventListener('abort',()=>resolve(),{once:true});if(context.signal!.aborted)resolve();});
      return {ok:false,output:'Stopped after runtime failure',data:{cancelled:true}};
    });
    vi.spyOn(t.tools,'closeCommandContext').mockImplementation(async()=>{cleanup.resolve();if(phase!=='completed')await release.promise;if(secondary==='cleanup')throw new Error('Secondary cleanup failure');});
    // Hold the native handler's return at an actual async boundary, so both
    // already-dispatched and still-setting-up processes reach the outer COMMIT.
    const seam=t.runtime as unknown as {processAction:(...args:unknown[])=>Promise<ToolResult>};
    const action=seam.processAction.bind(t.runtime);
    vi.spyOn(seam,'processAction').mockImplementation(async(...args)=>{const result=await action(...args);if(phase!=='setup')await started.promise;if(phase==='completed')await t.runtime.processes.drainChat(t.chat.id);return result;});
    const exec=t.store.db.exec.bind(t.store.db);
    vi.spyOn(t.store.db,'exec').mockImplementation(sql=>{
      if(sql==='COMMIT'&&!faulted){
        const job=processRecords(t.store)[0],run=t.store.getState<RunState|null>(`run:${t.chat.id}`,null);
        const pending=run?.frames.find(frame=>frame.id===job?.frameId)?.pending;
        const ready=job&&(boundary==='outcome'?pending?.stage==='done':t.store.getState(`native:result:${t.chat.id}:${job.frameId}:${job.callId}`,null)!==null);
        if(ready){faulted=true;throw originalFailure;}
      }
      if(sql==='COMMIT'&&faulted&&secondary==='error-record'&&t.store.chat(t.chat.id).status==='error')throw new Error('Secondary error-record COMMIT failure');
      return exec(sql);
    });
    t.replies.push(t.delegate(),call('start_process',{command:'synthetic outer failure'}));
    await t.runtime.submit(t.chat.id,'Exercise process failure');
    await cleanup.promise;
    if(phase!=='completed'){
      expect(()=>t.runtime.processes.assertIdle(t.chat.projectId)).toThrow('mutation');
      await expect(t.tools.save(t.root,'blocked','no',null)).rejects.toThrow('mutation');
      expect(t.store.chat(t.chat.id).status).not.toBe('error');
    }
    const wait=t.runtime.wait(t.chat.id);release.resolve();
    if(secondary==='error-record')await expect(wait).rejects.toBe(originalFailure);else await wait;
    expect(faulted).toBe(true);
    if(secondary!=='error-record'){
      expect(t.store.chat(t.chat.id).status).toBe('error');expect(t.store.messages(t.chat.id).at(-1)?.content).toContain(originalFailure.message);
    }
    if(secondary==='cleanup'){
      expect(t.store.messages(t.chat.id).at(-1)?.content).toContain('Owned process cleanup failed');expect(()=>t.runtime.processes.assertIdle(t.chat.projectId)).toThrow('mutation');
    }
    const job=processRecords(t.store)[0];expect(job.status).toBe(secondary==='cleanup'?'uncertain':phase==='setup'?'not_started':phase==='running'?'interrupted':'completed');
    expect(dispatches).toBe(phase==='setup'?0:1);expect(t.store.plan(t.chat.id).phases[0].steps[0].status).not.toBe('completed');
    if(phase==='running'){expect(await readFile(path.join(t.root,'effect.txt'),'utf8')).toContain('before runtime failure');expect(t.runtime.processes.blockers(t.chat.projectId,job.frameId)).not.toHaveLength(0);}
    const run=t.store.getState<RunState>(`run:${t.chat.id}`,null!);expect(run.frames.find(frame=>frame.id===job.frameId)?.pending?.callId).toBe(job.callId);
    t.store.recover();expect(processRecords(t.store)[0]).toMatchObject({id:job.id,callId:job.callId,status:job.status});expect(dispatches).toBe(phase==='setup'?0:1);
    for(const request of t.requests)validateNativeHistory(request.messages);
  });
  it('maintains AGENTS through architect approval and never writes a planning draft',async()=>{
    const t=await fixture();t.store.updateChat(t.chat.id,{approvalMode:'review'});
    const maintenance=call('maintain_instructions',{path:'AGENTS.md',baseHash:null,edits:[{startLine:1,deleteCount:0,text:'Structure: src contains implementation.\nCommands: npm test\n'}]});
    t.replies.push(maintenance,{text:'Guidance retained.',finishReason:'stop'});
    await t.run();const approval=t.store.approvals(t.chat.id)[0];
    expect(approval.action.name).toBe('maintain_instructions');expect((await t.tools.read(t.root,'AGENTS.md')).hash).toBeNull();
    await t.runtime.decide(approval.id,'approve');await t.runtime.wait(t.chat.id);
    expect(await readFile(path.join(t.root,'AGENTS.md'),'utf8')).toContain('Commands: npm test');
    expect(t.store.fileChanges(t.store.chat(t.chat.id).projectId)[0].status).toBe('confirmed');
    const before=await t.tools.read(t.root,'AGENTS.md');
    t.replies.push(call('maintain_instructions',{path:'AGENTS.md',baseHash:before.hash,edits:[{startLine:1,deleteCount:1,text:'forbidden'}]}),{text:'Draft only.',finishReason:'stop'});
    await t.runtime.submit(t.chat.id,'/plan Draft guidance');await t.runtime.wait(t.chat.id);
    expect((await t.tools.read(t.root,'AGENTS.md')).hash).toBe(before.hash);
  });
  it('invalidates a rename approval when destination ancestor instructions change and enforces both path scopes',async()=>{
    const t=await fixture();await mkdir(path.join(t.root,'dest'));await writeFile(path.join(t.root,'dest','AGENTS.md'),'Preserve destination conventions');
    const before=await t.tools.read(t.root,'result.txt');t.store.updateChat(t.chat.id,{approvalMode:'review'});
    const delegate=t.delegate(1,{paths:['result.txt','dest']});
    // New nested guidance invalidates the first proposal; the refreshed call is explicit.
    t.replies.push(delegate,t.delegate(1,{paths:['result.txt','dest']}),call('rename_file',{path:'result.txt',destination:'dest/result.txt',baseHash:before.hash}),complete(),pass(),complete());
    await t.run();const approval=t.store.approvals(t.chat.id).find(item=>item.status==='pending')!;expect(approval).toBeDefined();
    await writeFile(path.join(t.root,'dest','AGENTS.md'),'Changed applicable rules');
    await expect(t.runtime.decide(approval.id,'approve')).rejects.toMatchObject({statusCode:409});await t.runtime.wait(t.chat.id);
    expect((await t.tools.read(t.root,'result.txt')).hash).toBe(before.hash);expect((await t.tools.read(t.root,'dest/result.txt')).hash).toBeNull();
    expect(t.store.getApproval(approval.id).status).toBe('stale');
  });
  it('requires approval before a process claim, blocks mutations/completion while active, then preserves native correlation',async()=>{
    const t=await fixture();t.store.updateChat(t.chat.id,{approvalMode:'review'});
    const finish=deferred<ToolResult>(),started=deferred();let context:ToolContext|undefined;
    const execute=t.tools.execute.bind(t.tools);
    vi.spyOn(t.tools,'execute').mockImplementation(async(ctx,action)=>{if(action.name!=='run_shell')return execute(ctx,action);context=ctx;await ctx.prepareCommand!();ctx.beforeCommand!();started.resolve();return finish.promise;});
    vi.spyOn(t.tools,'closeCommandContext').mockResolvedValue(undefined);
    t.replies.push(t.delegate(),call('start_process',{command:'synthetic long process'}),async()=>{await started.promise;return call('patch_file',{path:'result.txt',baseHash:(await t.tools.read(t.root,'result.txt')).hash,edits:[{startLine:1,deleteCount:1,text:'forbidden'}]});},complete(),async()=>{finish.resolve({ok:true,output:'',data:{exitCode:0}});await t.runtime.processes.drainChat(t.chat.id);return complete();},call('read_file',{path:'result.txt'}),pass(),complete());
    await t.run();expect(processRecords(t.store)).toHaveLength(0);const approval=t.store.approvals(t.chat.id)[0];expect(approval.action.name).toBe('start_process');
    await t.runtime.decide(approval.id,'approve');await t.runtime.wait(t.chat.id);
    expect(processRecords(t.store)[0].status).toBe('completed');expect(context?.mutationOwner).toBeTypeOf('symbol');
    expect(await readFile(path.join(t.root,'result.txt'),'utf8')).toBe('Original observed file');
    expect(t.store.messages(t.chat.id).filter(message=>message.role==='tool'&&!message.metadata?.ok).map(message=>message.content).join('\n')).toContain('mutation');
    for(const request of t.requests)validateNativeHistory(request.messages);
  });
  it('links explicit pause to a held process setup without dispatch or orphaning the start result',async()=>{
    const t=await fixture(),setup=deferred(),claimed=deferred(),provider=deferred();let dispatched=0;
    vi.spyOn(t.tools,'execute').mockImplementation(async context=>{claimed.resolve();await setup.promise;try{await context.prepareCommand!();context.beforeCommand!();dispatched++;return {ok:true,output:'',data:{exitCode:0}};}catch{return {ok:false,output:'Not started',data:{status:'not_started'}};}});
    vi.spyOn(t.tools,'closeCommandContext').mockResolvedValue(undefined);
    t.replies.push(t.delegate(),call('start_process',{command:'never run'}),async()=>{await provider.promise;return complete();});
    await t.runtime.submit(t.chat.id,'Inspect long process');await claimed.promise;
    const pause=t.runtime.control(t.chat.id,'pause');setup.resolve();provider.resolve();await pause;
    expect(dispatched).toBe(0);expect(processRecords(t.store)[0].status).toBe('not_started');
    const run=t.store.getState<RunState>(`run:${t.chat.id}`,null!);for(const frame of run.frames)validateNativeHistory(frame.messages);
  });
});
