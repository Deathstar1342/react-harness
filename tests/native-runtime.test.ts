import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { Runtime, type Frame, type RunState } from '../server/runtime.js';
import { readConfig } from '../server/config.js';
import { protocolInstructions } from '../server/protocol.js';
import { validateNativeHistory } from '../server/provider.js';
import type { CompletionResult, ModelMessage, ToolService } from '../shared/types.js';
import { nativeReply, nativeState } from './native-fixture.js';

const resources:{store:Store;runtime:Runtime}[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const t of resources.splice(0)){await t.runtime.close();t.store.close();}});
const end=()=>nativeReply('submit_completion',{summary:'Observed evidence and limitations.'});
const delegate=()=>nativeReply('delegate',{objective:'Inspect a file',acceptanceCriteria:['Read actual evidence']});
const verdict=()=>nativeReply('review_result',{verdict:'pass',findings:['Actual read evidence recorded']});
function fixture(replies:CompletionResult[]) {
  const store=new Store(':memory:');const project=store.createProject('Native fixture','/workspace');const chat=store.createChat(project.id,'Native','autonomous');
  const requests:ModelMessage[][]=[];
  const tools:ToolService={inspect:vi.fn<ToolService['inspect']>(async()=>({effect:'read',risk:'routine',description:'Read evidence'})),execute:vi.fn(async()=>({ok:true,output:'Observed file'})),read:async(_root,path)=>({path,content:'',hash:null}),list:async()=>[],save:async()=>{throw new Error('No write');},setDirty(){},dispose:async()=>{}};
  const provider={models:async()=>[],complete:vi.fn(async(input:any)=>{validateNativeHistory(input.messages);requests.push(structuredClone(input.messages));const reply=replies.shift();if(!reply)throw new Error('Unexpected provider request');return reply;})};
  const runtime=new Runtime(store,provider,tools,readConfig({}),{instructions:protocolInstructions});resources.push({store,runtime});
  const run=async()=>{await runtime.submit(chat.id,'Inspect a file');await runtime.wait(chat.id);};
  return {store,chat,runtime,tools,provider,requests,run};
}
function batch(...replies:CompletionResult[]):CompletionResult {return {text:'',finishReason:'tool_calls',toolCalls:replies.flatMap(r=>r.toolCalls??[])};}

describe('native runtime execution and evidence',()=>{
  it.each(['missing-id','changed-action','missing-original','already-resolved','wrong-order'])('refuses %s durable dispatch before effects',async kind=>{
    const t=fixture([]);const state=nativeState<RunState>({frames:[{id:'frame',role:'coder',messages:[],repairs:0,pending:{id:'operation',stage:'prepared',action:{name:'run_shell',args:{command:'never execute'}}}}],steering:[],generation:0,steps:0,planOnly:false});
    const frame=state.frames[0];
    if(kind==='missing-id')delete frame.pending!.callId;
    if(kind==='changed-action')frame.pending!.action.args.command='changed';
    if(kind==='missing-original')frame.messages=[];
    if(kind==='already-resolved')frame.messages.push({role:'tool',tool_call_id:frame.pending!.callId!,content:'{}'});
    if(kind==='wrong-order')frame.queuedCalls!.unshift(nativeReply('git_status').toolCalls![0]);
    const before=structuredClone(state);
    await expect((t.runtime as any).executePending(t.chat.id,state,frame,new AbortController().signal)).rejects.toThrow(/native/i);
    expect(state).toEqual(before);expect(t.tools.inspect).not.toHaveBeenCalled();expect(t.tools.execute).not.toHaveBeenCalled();
  });
  it('serializes a complete multi-agent flow and correlates every call',async()=>{
    const t=fixture([delegate(),batch(nativeReply('read_file',{path:'a'}),nativeReply('git_status')),end(),nativeReply('read_file',{path:'a'}),verdict(),end()]);
    let active=0,max=0;vi.mocked(t.tools.execute).mockImplementation(async()=>{active++;max=Math.max(max,active);await Promise.resolve();active--;return {ok:true,output:'Observed file'};});
    await t.run();expect(max).toBe(1);expect(t.tools.execute).toHaveBeenCalledTimes(3);expect(t.store.chat(t.chat.id).status).toBe('idle');
    for(const row of t.store.db.prepare("SELECT data FROM state WHERE key LIKE 'native:frame:%'").all())validateNativeHistory(JSON.parse(String(row.data)));
    expect(t.store.events(t.chat.id).some(e=>e.type==='review')).toBe(true);
  });
  it.each(['unknown','invalid','duplicate-key','terminal-order','forbidden-role'])('rejects the entire %s batch before any effects',async kind=>{
    let bad=nativeReply('invented',{});
    if(kind==='invalid')bad=nativeReply('read_file',{path:42});
    if(kind==='duplicate-key'){bad=nativeReply('read_file');bad.toolCalls![0].function.arguments='{"path":"a","path":"b"}';}
    if(kind==='terminal-order')bad=end();
    if(kind==='forbidden-role')bad=nativeReply('write_file',{path:'a',content:'unsafe',baseHash:null});
    const reply=kind==='terminal-order'?batch(bad,nativeReply('read_file',{path:'a'})):batch(nativeReply('read_file',{path:'a'}),bad);
    const t=fixture([reply,end()]);await t.run();expect(t.tools.inspect).not.toHaveBeenCalled();expect(t.tools.execute).not.toHaveBeenCalled();
    expect(t.requests[1].filter(m=>m.role==='tool')).toHaveLength(2);validateNativeHistory(t.requests[1]);
  });
  it('rejects duplicate identities before persistence or effects',async()=>{
    const call=nativeReply('read_file',{path:'a'});const t=fixture([batch(call,call)]);await t.run();expect(t.tools.execute).not.toHaveBeenCalled();expect(t.store.chat(t.chat.id).status).toBe('error');expect(t.store.getState(`native:ids:${t.chat.id}`,[])).toEqual([]);
  });
  it('continues internal coder and critic prose without treating it as completion',async()=>{
    const t=fixture([delegate(),{text:'Inspecting now',finishReason:'stop'},nativeReply('read_file',{path:'a'}),end(),{text:'Reviewing evidence',finishReason:'stop'},verdict(),end()]);await t.run();expect(t.store.chat(t.chat.id).status).toBe('idle');expect(t.store.events(t.chat.id).filter(e=>e.type==='review')).toHaveLength(1);expect(t.tools.execute).toHaveBeenCalledTimes(1);
  });
  it('bounds internal text-only nonprogress with an actionable pause',async()=>{
    const t=fixture([delegate(),...Array.from({length:3},()=>({text:'Working',finishReason:'stop'}))]);await t.run();expect(t.store.chat(t.chat.id).status).toBe('paused');expect(t.provider.complete).toHaveBeenCalledTimes(4);expect(t.store.messages(t.chat.id).at(-1)?.content).toContain('Work remains unaccepted');expect(t.store.events(t.chat.id).filter(e=>e.type==='review')).toHaveLength(0);
  });
  it('steering after the first call closes remaining calls as not started',async()=>{
    const t=fixture([batch(nativeReply('read_file',{path:'a'}),nativeReply('read_file',{path:'b'})),end()]);
    vi.mocked(t.tools.execute).mockImplementationOnce(async()=>{await t.runtime.submit(t.chat.id,'/btw Preserve remaining files');return {ok:true,output:'First read completed'};});
    await t.run();expect(t.tools.execute).toHaveBeenCalledTimes(1);const messages=t.requests.at(-1)!;validateNativeHistory(messages);expect(messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content))).toMatchObject([{ok:true},{ok:false,data:{status:'not_started'}}]);
  });
  it.each(['after-write','before-commit'])('rolls back native intake and cached state on %s failure',async point=>{
    const t=fixture([delegate()]);let armed=false;
    const write=t.store.setState.bind(t.store),exec=t.store.db.exec.bind(t.store.db);
    vi.spyOn(t.store,'setState').mockImplementation((key,value)=>{write(key,value);if(key.startsWith('native:ids:')){armed=true;if(point==='after-write')throw new Error('Injected state failure');}});
    vi.spyOn(t.store.db,'exec').mockImplementation(sql=>{if(sql==='COMMIT'&&armed&&point==='before-commit'){armed=false;throw new Error('Injected commit failure');}return exec(sql);});
    await t.run();const durable=t.store.getState<RunState>(`run:${t.chat.id}`,null!);const cached=(t.runtime as any).runs.get(t.chat.id);
    expect(cached).toEqual(durable);expect(durable.frames).toHaveLength(1);expect(durable.frames[0].queuedCalls).toBeUndefined();expect(t.store.getState(`native:ids:${t.chat.id}`,[])).toEqual([]);expect(t.store.events(t.chat.id).filter(e=>e.type==='delegation')).toHaveLength(0);expect(t.tools.execute).not.toHaveBeenCalled();
  });
  it.each(['set_plan','delegate','review','review_result','submit_completion'].flatMap(name=>['after-write','before-commit'].map(point=>[name,point])))('rolls back %s and native result/history together at %s',(name,point)=>{
    const args=name==='set_plan'?{phases:[{id:'p',title:'P',steps:[]}]}:name==='delegate'?{objective:'Read',acceptanceCriteria:['Read evidence']}:name==='review'?{focus:'Evidence'}:name==='review_result'?{verdict:'pass',findings:[]}:{summary:'Complete frame'};
    const reply=nativeReply(name,args),call=reply.toolCalls![0];const t=fixture([]);
    const frame:Frame={id:'frame',role:name==='review_result'?'critic':'architect',messages:[{role:'assistant',content:'',tool_calls:[call]}],queuedCalls:[call],repairs:0};
    const state:RunState={frames:[frame],steering:[],generation:0,steps:0,planOnly:false};t.store.setState(`run:${t.chat.id}`,state);const before=structuredClone(state),plan=t.store.plan(t.chat.id),events=t.store.events(t.chat.id);
    const write=t.store.setState.bind(t.store);vi.spyOn(t.store,'setState').mockImplementation((key,value)=>{write(key,value);if(point==='after-write'&&key.startsWith('native:frame:'))throw new Error('Injected write failure');});
    const exec=t.store.db.exec.bind(t.store.db);vi.spyOn(t.store.db,'exec').mockImplementation(sql=>{if(sql==='COMMIT'&&point==='before-commit')throw new Error('Injected commit failure');return exec(sql);});
    expect(()=>(t.runtime as any).controlAction(t.chat.id,state,frame,call,{name,args})).toThrow();expect(state).toEqual(before);expect(t.store.getState(`run:${t.chat.id}`,null)).toEqual(before);expect(t.store.plan(t.chat.id)).toEqual(plan);expect(t.store.events(t.chat.id)).toEqual(events);expect(t.store.getState(`native:result:${t.chat.id}:frame:${call.id}`,null)).toBeNull();
  });
  it('recovery is atomic and idempotent and never replays executing effects',()=>{
    const t=fixture([]);const state=nativeState<RunState>({frames:[{id:'frame',role:'coder',messages:[],repairs:0,pending:{id:'operation',stage:'executing',action:{name:'run_shell',args:{command:'never replay'}}}}],steering:[],generation:0,steps:0,planOnly:false});
    const second=nativeReply('read_file',{path:'a'}).toolCalls![0];(state.frames[0].messages[0] as any).tool_calls.push(second);state.frames[0].queuedCalls!.push(second);t.store.setState(`run:${t.chat.id}`,state);
    const exec=t.store.db.exec.bind(t.store.db);const spy=vi.spyOn(t.store.db,'exec').mockImplementation(sql=>{if(sql==='COMMIT')throw new Error('Injected commit failure');return exec(sql);});expect(()=>t.store.recover()).toThrow();expect(t.store.getState(`run:${t.chat.id}`,null)).toEqual(state);spy.mockRestore();
    t.store.recover();const first=t.store.getState(`run:${t.chat.id}`,null);t.store.recover();expect(t.store.getState(`run:${t.chat.id}`,null)).toEqual(first);expect(t.tools.execute).not.toHaveBeenCalled();
  });
});
