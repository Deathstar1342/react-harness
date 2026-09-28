import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Runtime, type RunState } from '../server/runtime.js';
import { readConfig } from '../server/config.js';
import { commandEvent } from '../server/command-events.js';
import { WorkspaceTools } from '../server/tools/index.js';
import { terminalHistory } from '../client/terminal.js';
import type { Action, AgentResponse, CommandEvent, ModelProvider, ToolContext, ToolResult, ToolService } from '../shared/types.js';

const action = (name:string,args:Record<string,unknown>={}):AgentResponse=>({version:1,type:'action',message:'',action:{name,args}});
const final:AgentResponse = {version:1,type:'final',message:'Done'};
const verdict = ()=>action('review_result',{verdict:'pass',findings:[]});
const resources: {runtime:Runtime;store:Store}[] = [];
afterEach(async()=>{for (const item of resources.splice(0)) {await item.runtime.close();item.store.close();}});
function setup(commands:Action[],execute:ToolService['execute']) {
  const store = new Store(':memory:');
  const project = store.createProject('Terminal','/workspace');
  const chat = store.createChat(project.id,'Commands','autonomous');
  const responses:AgentResponse[] = [action('delegate',{objective:'Run checks',acceptanceCriteria:['Evidence']}),...commands.flatMap(command=>[action(command.name,command.args),verdict()]),final,verdict(),final];
  const provider:ModelProvider = {models:async()=>['test'],complete:async()=>{const next=responses.shift();if (!next) throw new Error('Unexpected request');return {text:JSON.stringify(next)};}};
  const tools:ToolService = {inspect:async()=>({effect:'execute',risk:'elevated',description:'Command'}),execute,read:async(_root,path)=>({path,content:'',hash:null}),list:async()=>[],save:async()=>{throw new Error('Unexpected write');},setDirty:()=>{},dispose:async()=>{}};
  const runtime = new Runtime(store,provider,tools,readConfig({}),{instructions:()=>'',parse:text=>JSON.parse(text)});
  resources.push({runtime,store});
  return {store,chat,runtime};
}
const command = (text:string):Action=>({name:'run_shell',args:{command:text}});
const lifecycle = (store:Store,chatId:string)=>store.events(chatId).filter(event=>event.type==='command').map(event=>event.data as CommandEvent);

describe('durable terminal command evidence',()=>{
  it('atomically records starts/outcomes and correlates sequential commands in one persistent shell',async()=>{
    const t=setup([command('first'),command('second')],async(ctx,request)=>{
      ctx.onOutput?.(`${request.args.command} output`);
      return {ok:request.args.command==='first',output:'tool prose',data:{output:`${request.args.command} output`,exitCode:request.args.command==='first'?0:7}};
    });
    const observed:string[]=[];
    t.store.changes.on(t.chat.id,event=>{
      if(event.type!=='command') return;
      const data=event.data as CommandEvent;
      const run=t.store.getState<RunState>(`run:${t.chat.id}`,null as never);
      expect(run.frames.find(frame=>frame.id===data.agentId)?.pending?.stage).toBe(data.status==='running'?'executing':'done');
      observed.push(data.status);
    });
    await t.runtime.submit(t.chat.id,'Run checks');await t.runtime.wait(t.chat.id);
    expect(observed).toEqual(['running','completed','running','failed']);
    const events=t.store.events(t.chat.id), history=terminalHistory(events,t.chat.id);
    expect(history.unassociated).toEqual([]);
    expect(history.commands.map(c=>c.output)).toEqual(['first output','second output']);
    expect(new Set(history.commands.map(c=>c.commandId)).size).toBe(2);
    expect(new Set(history.commands.map(c=>c.sessionId))).toEqual(new Set(['coder-primary']));
    expect(history.commands[1].lifecycle?.exitCode).toBe(7);
  });
  it('records a stop request as running until a real outcome arrives and ignores late output',async()=>{
    let entered!:()=>void, release!:(value:ToolResult)=>void, output:ToolContext['onOutput'];
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const t=setup([command('long')],async ctx=>{output=ctx.onOutput;entered();return new Promise(resolve=>{release=resolve;});});
    await t.runtime.submit(t.chat.id,'Run');await started;
    const stopping=t.runtime.control(t.chat.id,'interrupt');
    expect(lifecycle(t.store,t.chat.id).at(-1)?.status).toBe('running');
    release({ok:false,output:'Stopped',data:{output:'partial',cancelled:true,shellReset:true,error:'Stopped'}});
    await stopping;
    expect(lifecycle(t.store,t.chat.id).at(-1)).toMatchObject({status:'interrupted',cancelled:true,output:'partial'});
    const count=t.store.events(t.chat.id).length;output?.('too late');expect(t.store.events(t.chat.id)).toHaveLength(count);
  });
  it('preserves a completed result even when interrupt was requested before it arrived',async()=>{
    let entered!:()=>void, release!:(value:ToolResult)=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const t=setup([command('short')],async()=>{entered();return new Promise(resolve=>{release=resolve;});});
    await t.runtime.submit(t.chat.id,'Run');await started;
    const stopping=t.runtime.control(t.chat.id,'pause');
    release({ok:true,output:'',data:{output:'',exitCode:0}});await stopping;
    expect(lifecycle(t.store,t.chat.id).at(-1)).toMatchObject({status:'completed',exitCode:0,output:''});
  });
  it('marks a thrown tool outcome uncertain rather than claiming cancellation or completion',async()=>{
    const t=setup([command('modifies')],async ctx=>{ctx.onOutput?.('written before disconnect');throw new Error('Connection lost after dispatch');});
    await t.runtime.submit(t.chat.id,'Run');await t.runtime.wait(t.chat.id);
    expect(lifecycle(t.store,t.chat.id).at(-1)).toMatchObject({status:'uncertain',message:'Tool reported a problem: Connection lost after dispatch'});
    expect(terminalHistory(t.store.events(t.chat.id),t.chat.id).commands[0].output).toBe('written before disconnect');
    expect(lifecycle(t.store,t.chat.id).filter(event=>event.status==='running')).toHaveLength(1);
    t.store.recover();await t.runtime.control(t.chat.id,'resume');await t.runtime.wait(t.chat.id);
    expect(lifecycle(t.store,t.chat.id).filter(event=>event.status==='running')).toHaveLength(1);
  });
  it('publishes restart uncertainty once before resume, preserves stage, and never reruns legacy execution',async()=>{
    let executions=0;
    const t=setup([],async()=>{executions++;return {ok:true,output:''};});
    const state:RunState={planOnly:false,steps:0,generation:0,steering:[],frames:[{id:'old-coder',shellId:'coder-primary',role:'coder',messages:[],repairs:0,pending:{id:'old-command',stage:'executing',action:command('do not repeat')}}]};
    t.store.setState(`run:${t.chat.id}`,state);t.store.updateChat(t.chat.id,{status:'paused'});
    t.store.event(t.chat.id,'tool_output',{agentId:'old-coder',output:'legacy uncorrelated'});
    t.store.recover();t.store.recover();
    expect(lifecycle(t.store,t.chat.id)).toHaveLength(1);
    expect(t.store.getState<RunState>(`run:${t.chat.id}`,state).frames[0].pending?.stage).toBe('executing');
    expect(lifecycle(t.store,t.chat.id)[0]).toMatchObject({commandId:'old-command',status:'uncertain',shellReset:true});
    await t.runtime.control(t.chat.id,'resume');await t.runtime.wait(t.chat.id);
    t.store.recover();expect(lifecycle(t.store,t.chat.id)).toHaveLength(1);expect(executions).toBe(0);
    expect(terminalHistory(t.store.events(t.chat.id),t.chat.id).unassociated).toHaveLength(1);
  });
  it('keeps done results across recovery and reports actual event-history omission',()=>{
    const t=setup([],async()=>({ok:true,output:''}));
    const state:RunState={planOnly:false,steps:0,generation:0,steering:[],frames:[{id:'coder',role:'coder',messages:[],repairs:0,pending:{id:'done',stage:'done',action:command('done'),result:{ok:true,output:'',data:{exitCode:0}}}}]};
    t.store.setState(`run:${t.chat.id}`,state);t.store.recover();
    expect(lifecycle(t.store,t.chat.id)).toEqual([]);
    const original=t.store.detail(t.chat.id).events.length;
    for(let i=original;i<1000;i++)t.store.event(t.chat.id,'delta',{});
    expect(t.store.detail(t.chat.id).eventsTruncated).toBe(false);
    t.store.event(t.chat.id,'delta',{});
    expect(t.store.detail(t.chat.id)).toMatchObject({eventsTruncated:true,events:expect.any(Array)});
    expect(t.store.detail(t.chat.id).events).toHaveLength(1000);
  });
  it('keeps the recovery marker durable across actual SQLite close and reopen',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'terminal-restart-'));
    const filename=path.join(root,'state.sqlite');let store=new Store(filename);
    try {
      const project=store.createProject('Restart',root),chat=store.createChat(project.id,'Restart','autonomous');
      const frame={id:'coder',role:'coder' as const,messages:[],repairs:0,pending:{id:'interrupted',stage:'executing' as const,action:command('once')}};
      store.setState(`run:${chat.id}`,{planOnly:false,steps:0,generation:0,steering:[],frames:[frame]} satisfies RunState);
      store.event(chat.id,'command',commandEvent(frame,frame.pending));
      store.event(chat.id,'tool_output',{commandId:'interrupted',agentId:'coder',sessionId:'coder',output:'durable partial'});
      store.close();store=new Store(filename);store.recover();
      expect(lifecycle(store,chat.id).map(event=>event.status)).toEqual(['running','uncertain']);
      store.close();store=new Store(filename);store.recover();
      expect(lifecycle(store,chat.id).map(event=>event.status)).toEqual(['running','uncertain']);
      expect(terminalHistory(store.detail(chat.id).events,chat.id).commands[0].output).toBe('durable partial');
    } finally {store.close();await rm(root,{recursive:true,force:true});}
  });
  it('carries run_tests command evidence and keeps its structured report',async()=>{
    const report={id:'report',runner:'pytest',command:'pytest',createdAt:'',status:'error' as const,tests:[],output:'Fresh JUnit report missing',exitCode:0};
    const t=setup([{name:'run_tests',args:{command:'pytest'}}],async ctx=>{ctx.onOutput?.('console');return {ok:false,output:report.output,data:{output:'console',exitCode:0,testReport:report}};});
    await t.runtime.submit(t.chat.id,'Test');await t.runtime.wait(t.chat.id);
    expect(lifecycle(t.store,t.chat.id).at(-1)).toMatchObject({status:'completed',exitCode:0,output:'console',message:'Tool reported a problem: Fresh JUnit report missing'});
    expect(t.store.detail(t.chat.id).tests).toEqual([report]);
  });
});

describe('outcome normalization',()=>{
  const frame={id:'coder',role:'coder' as const};const pending={id:'cmd',action:command('check')};
  it.each([
    [{ok:true,output:'success prose'},'uncertain'],
    [{ok:false,output:'PTY unavailable'},'uncertain'],
    [{ok:false,output:'',data:{output:'',exitCode:0,shellReset:true,error:'Shell died'}},'uncertain'],
    [{ok:false,output:'',data:{output:'',timedOut:true,shellReset:true,error:'Timeout'}},'interrupted'],
  ] as [ToolResult,string][])('does not fabricate exit evidence for %j',(result,status)=>{
    const event=commandEvent(frame,pending,result);expect(event.status).toBe(status);expect(event.exitCode).toBeUndefined();
  });
  it('bounds output and diagnostic text and retains original tool truncation',()=>{
    expect(commandEvent(frame,pending,{ok:true,output:'',data:{output:'x'.repeat(70_000),exitCode:0}})).toMatchObject({output:'x'.repeat(64_000),truncated:true});
    expect(commandEvent(frame,pending,{ok:true,output:'',data:{output:'small',exitCode:0,truncated:true}}).truncated).toBe(true);
  });
  it.skipIf(process.platform!=='linux')('uses real PTY exit, empty output, and truncation evidence',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'terminal-evidence-'));const tools=new WorkspaceTools({maxOutputBytes:10});
    const ctx={projectRoot:root,chatId:'chat',agentId:'agent'};
    try {
      const empty=await tools.execute(ctx,command('true'));
      expect(commandEvent(frame,pending,empty)).toMatchObject({status:'completed',exitCode:0,output:''});
      const nonzero=await tools.execute(ctx,command('printf abcdefghijklmnop; false'));
      expect(commandEvent(frame,pending,nonzero)).toMatchObject({status:'failed',exitCode:1,truncated:true});
    } finally {await tools.dispose();await rm(root,{recursive:true,force:true});}
  });
});
