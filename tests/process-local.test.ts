import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {WorkspaceTools} from '../server/tools/index.js';
import {ProcessJobs,processRecords,type ProcessOrigin} from '../server/process-jobs.js';
import {nativeReply} from './native-fixture.js';
import type {RunState} from '../server/runtime.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(command:string,timeoutMs=10000,beforeStart?:(tools:WorkspaceTools,store:Store)=>void) {
  const root=await mkdtemp(path.join(tmpdir(),'m25-real-process-')),projectRoot=path.join(root,'project');await mkdir(projectRoot);
  const store=new Store(path.join(root,'state.sqlite')),tools=new WorkspaceTools();
  const project=store.createProject('Real Linux process',projectRoot),chat=store.createChat(project.id,'Process','autonomous');store.initializePlanning();
  const action={name:'start_process',args:{command,timeoutMs}},call=nativeReply(action.name,action.args).toolCalls![0];
  const state:RunState={frames:[{id:'architect',role:'architect',messages:[],repairs:0},{id:'coder',role:'coder',messages:[{role:'assistant',content:'',tool_calls:[call]}],repairs:0}],generation:0,steps:0,steering:[],planOnly:false,instructionsHash:null};
  store.setState(`run:${chat.id}`,state);store.setState(`native:frame:${chat.id}:coder`,state.frames[1].messages);
  const jobs=new ProcessJobs(store,tools);tools.configureMutationGuard((root,owner)=>jobs.guard(root,owner));
  const origin:ProcessOrigin={projectId:project.id,chatId:chat.id,frameId:'coder',taskId:'architect',callId:call.id,commandId:'real-command',generation:0,modeVersion:store.chat(chat.id).modeVersion??0,instructionsHash:null,targets:[],approvalMode:'autonomous'};
  cleanup.push(async()=>{await jobs.close();await tools.dispose();store.close();await rm(root,{recursive:true,force:true});});
  beforeStart?.(tools,store);
  const handle=jobs.start(origin,action).data as {id:string};
  return {root,project,chat,store,tools,jobs,handle,state};
}
describe('actual local command lifecycle',()=>{
  it('starts, streams bounded output, observes completion and drains the owned command before releasing mutation',async()=>{
    const t=await fixture(`node -e "process.stdout.write('ready'); setTimeout(()=>{require('fs').writeFileSync('proof.txt','actual');process.stdout.write('done');},100)"`);
    expect(processRecords(t.store,t.project.id)[0].status).toBe('starting');
    await expect(t.tools.save(t.project.path,'no-race','manual',null)).rejects.toThrow();
    await t.jobs.drainChat(t.chat.id);
    const result=await t.jobs.observe(t.handle.id,t.chat.id,['coder']);
    expect(result).toMatchObject({status:'completed',exitCode:0,output:'readydone'});
    expect(await readFile(path.join(t.project.path,'proof.txt'),'utf8')).toBe('actual');
    await expect(t.tools.save(t.project.path,'after','safe',null)).resolves.toMatchObject({content:'safe'});
  },20000);
  it('cancels an actually dispatched command and retains prior effects without executing later work',async()=>{
    const t=await fixture(`node -e "require('fs').writeFileSync('prior.txt','prior');process.stdout.write('ready');setTimeout(()=>require('fs').writeFileSync('later.txt','forbidden'),30000)"`,60000);
    for(let i=0;i<200&&!processRecords(t.store,t.project.id)[0].output.includes('ready');i++)await new Promise(resolve=>setTimeout(resolve,25));
    expect(processRecords(t.store,t.project.id)[0].status).toBe('running');
    expect(await t.jobs.cancel(t.handle.id,t.chat.id,'coder')).toMatchObject({status:'interrupted'});
    expect(await readFile(path.join(t.project.path,'prior.txt'),'utf8')).toBe('prior');
    expect((await t.tools.read(t.project.path,'later.txt')).hash).toBeNull();
    expect(t.jobs.blockers(t.project.id,'coder').join(' ')).toContain('interrupted');
  },20000);
  it('times out an owned local command',async()=>{
    const t=await fixture('node -e "setTimeout(()=>{},30000)"',200);
    await t.jobs.drainChat(t.chat.id);
    expect(await t.jobs.observe(t.handle.id,t.chat.id,['coder'])).toMatchObject({status:'interrupted'});
  },20000);
  it('never passes backend credentials into the child environment',async()=>{
    const prior=process.env.STARK_API_KEY;process.env.STARK_API_KEY='m25-backend-only-fixture';
    try{
      const t=await fixture(`node -e "process.stdout.write(process.env.STARK_API_KEY??'unset')"`);await t.jobs.drainChat(t.chat.id);
      const result=await t.jobs.observe(t.handle.id,t.chat.id,['coder']);expect(result).toMatchObject({status:'completed',output:'unset'});
    }finally{if(prior===undefined)delete process.env.STARK_API_KEY;else process.env.STARK_API_KEY=prior;}
  },20000);
  it.each(['pause','steering','mode'])('rechecks %s after command preparation was held',async kind=>{
    let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
    const t=await fixture('mkdir must-not-exist',10000,tools=>{
      const execute=tools.execute.bind(tools);
      vi.spyOn(tools,'execute').mockImplementation((context,action)=>{
        const prepare=context.prepareCommand;
        return execute({...context,prepareCommand:async()=>{entered();await gate;await prepare?.();}},action);
      });
    });
    await ready;
    if(kind==='pause'){t.store.updateChat(t.chat.id,{status:'paused'});t.jobs.stopChat(t.chat.id);}
    if(kind==='steering')t.store.setState(`run:${t.chat.id}`,{...t.state,generation:1,steering:['new input']});
    if(kind==='mode')t.store.updateChat(t.chat.id,{mode:'plan',modeVersion:1});
    release();await t.jobs.drainChat(t.chat.id);
    expect(processRecords(t.store,t.project.id)[0].status).toBe('not_started');expect((await t.tools.read(t.project.path,'must-not-exist')).hash).toBeNull();
  },20000);
  it('prevents actual command dispatch when the final running-intent COMMIT fails',async()=>{
    const t=await fixture('mkdir must-not-exist',10000,(_tools,store)=>{
      let armed=false;const write=store.setState.bind(store),exec=store.db.exec.bind(store.db);
      vi.spyOn(store,'setState').mockImplementation((key,value)=>{write(key,value);if(key.startsWith('process-job:')&&(value as {status?:string}).status==='running')armed=true;});
      vi.spyOn(store.db,'exec').mockImplementation(sql=>{if(sql==='COMMIT'&&armed){armed=false;throw new Error('Injected dispatch COMMIT fault');}return exec(sql);});
    });
    await t.jobs.drainChat(t.chat.id);expect(processRecords(t.store,t.project.id)[0].status).toBe('not_started');expect((await t.tools.read(t.project.path,'must-not-exist')).hash).toBeNull();
  },20000);
});
