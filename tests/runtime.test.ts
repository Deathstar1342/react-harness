import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { Runtime, type RunState } from '../server/runtime.js';
import { readConfig } from '../server/config.js';
import type { Action, AgentResponse, ModelProvider, ToolService } from '../shared/types.js';

const action = (name: string,args: Record<string,unknown> = {}): AgentResponse => ({version:1,type:'action',message:'',action:{name,args}});
const final = (message = 'Done'): AgentResponse => ({version:1,type:'final',message});
const delegate = () => action('delegate',{objective:'Change the label',acceptanceCriteria:['Preserve manual edits']});
const verdict = () => action('review_result',{verdict:'pass',findings:[]});
const stores: Store[] = [];
afterEach(()=>{for (const store of stores.splice(0)) store.close();});
function setup(responses: Array<AgentResponse | (()=>Promise<AgentResponse>)>,mode: 'review'|'balanced'|'autonomous' = 'review') {
  const store = new Store(':memory:'); stores.push(store);
  const project = store.createProject('Test','/workspace');
  const chat = store.createChat(project.id,'New chat',mode);
  const executed: Action[] = [];
  let current = 'old';
  const tools: ToolService = {
    inspect:async(_ctx,request)=>({effect:request.name === 'read_file' ? 'read' : 'write',risk:'routine',description:'Change label',before:current,after:'new',diff:`${current}->new`}),
    execute:async(_ctx,request)=>{executed.push(request);return {ok:true,output:'changed'};},
    read:async()=>({path:'label.txt',content:current,hash:current}),list:async()=>[],
    save:async()=>({path:'label.txt',content:'',hash:''}),setDirty:()=>{},dispose:async()=>{},
  };
  const provider: ModelProvider = { models:async()=>['test'],complete:async()=> {
    const next = responses.shift(); if (!next) throw new Error('Unexpected extra model request');
    return {text:JSON.stringify(typeof next === 'function' ? await next() : next)};
  }};
  const config = readConfig({STARK_BASE_URL:'http://127.0.0.1/v1',STARK_API_KEY:'test'});
  const hooks = {parse:(text: string)=>JSON.parse(text) as AgentResponse,instructions:()=> 'JSON'};
  const runtime = new Runtime(store,provider,tools,config,hooks);
  return {store,chat,executed,runtime,tools,provider,config,hooks,change:()=>{current='manual';}};
}

describe('durable architect orchestration',()=> {
  it('waits for approval, executes once, reviews the coder, and completes through the architect',async()=> {
    const t = setup([delegate(),action('write_file',{path:'label.txt',content:'new',baseHash:'old'}),final('Changed label'),verdict(),final('Change reviewed')]);
    await t.runtime.submit(t.chat.id,'Change the label'); await t.runtime.wait(t.chat.id);
    expect(t.store.chat(t.chat.id).status).toBe('awaiting_approval'); expect(t.executed).toEqual([]);
    const approval = t.store.approvals(t.chat.id)[0]; expect(approval.inspection.diff).toBe('old->new');
    await t.runtime.decide(approval.id,'approve'); await t.runtime.wait(t.chat.id);
    expect(t.executed.map(item=>item.name)).toEqual(['write_file']);
    expect(t.store.chat(t.chat.id).status).toBe('idle');
    expect(t.store.messages(t.chat.id).at(-1)?.role).toBe('architect');
    expect(t.store.events(t.chat.id).some(event=>event.type==='review')).toBe(true);
    await expect(t.runtime.decide(approval.id,'approve')).rejects.toThrow('no longer pending');
  });
  it('invalidates an approved edit if the reviewed file changed',async()=> {
    const t = setup([delegate(),action('write_file',{path:'label.txt',content:'new',baseHash:'old'}),final('Could not apply stale edit'),verdict(),final()]);
    await t.runtime.submit(t.chat.id,'Change it'); await t.runtime.wait(t.chat.id);
    const approval = t.store.approvals(t.chat.id)[0];t.change();
    await t.runtime.decide(approval.id,'approve');await t.runtime.wait(t.chat.id);
    expect(t.executed).toEqual([]);expect(t.store.getApproval(approval.id).status).toBe('stale');
  });
  it('enforces plan-only and architect permissions even if the model asks to mutate',async()=> {
    const t = setup([action('write_file',{path:'x',content:'oops',baseHash:null}),delegate(),final('A plan only')],'autonomous');
    await t.runtime.submit(t.chat.id,'/plan Build this');await t.runtime.wait(t.chat.id);
    expect(t.executed).toEqual([]);expect(t.store.approvals(t.chat.id)).toEqual([]);
    expect(t.store.chat(t.chat.id).status).toBe('idle');
  });
  it('delivers steering and discards an in-flight stale model proposal',async()=> {
    let deliver!: (value:AgentResponse)=>void;
    let entered!: ()=>void; const started = new Promise<void>(resolve=>{entered=resolve;});
    const t = setup([()=>{entered();return new Promise(resolve=>{deliver=resolve;});},final('Following the new scope')]);
    await t.runtime.submit(t.chat.id,'Original task');await started;
    await t.runtime.submit(t.chat.id,'/btw Stop changing labels');
    deliver(delegate());await t.runtime.wait(t.chat.id);
    expect(t.executed).toEqual([]);
    expect(t.store.events(t.chat.id).filter(event=>event.type==='delegation')).toEqual([]);
    expect(t.store.events(t.chat.id).filter(event=>event.type==='steering').map(event=>(event.data as {delivered:boolean}).delivered)).toEqual([false,true]);
  });
  it('recovers an uncertain action without executing it again',async()=> {
    const t = setup([verdict(),final('Inspected remaining work'),verdict(),final()]);
    const state: RunState = {planOnly:false,steps:1,generation:0,steering:[],frames:[
      {id:'architect',role:'architect',messages:[],repairs:0},
      {id:'coder',role:'coder',messages:[],repairs:0,pending:{id:'operation',stage:'executing',action:{name:'run_shell',args:{command:'a modifying command'}}}},
    ]};
    t.store.setState(`run:${t.chat.id}`,state); t.store.updateChat(t.chat.id,{status:'interrupted'});
    await t.runtime.control(t.chat.id,'resume'); await t.runtime.wait(t.chat.id);
    expect(t.executed).toEqual([]);
    expect(t.store.messages(t.chat.id).some(message=>message.role==='tool' && message.content.includes('NOT been rerun'))).toBe(true);
    expect(t.store.chat(t.chat.id).status).toBe('idle');
  });
  it('can resume a persisted pending approval in a new runtime',async()=> {
    const t = setup([delegate(),action('write_file',{path:'x',content:'new',baseHash:null}),final(),verdict(),final()]);
    await t.runtime.submit(t.chat.id,'Build');await t.runtime.wait(t.chat.id);await t.runtime.close();
    const next = new Runtime(t.store,t.provider,t.tools,t.config,t.hooks);
    await next.decide(t.store.approvals(t.chat.id)[0].id,'approve');await next.wait(t.chat.id);
    expect(t.executed).toHaveLength(1);expect(t.store.chat(t.chat.id).status).toBe('idle');
  });
  it('bounds critic repair cycles and reports failure to the architect',async()=> {
    const fail = ()=>action('review_result',{verdict:'changes_requested',findings:['Missing verification']});
    const t = setup([delegate(),final(),fail(),final(),fail(),final(),fail(),final('Unresolved verification remains')]);
    await t.runtime.submit(t.chat.id,'Build');await t.runtime.wait(t.chat.id);
    expect(t.store.chat(t.chat.id).status).toBe('idle');
    expect(t.store.events(t.chat.id).filter(event=>event.type==='review')).toHaveLength(3);
    expect(t.store.messages(t.chat.id).at(-1)?.content).toBe('Unresolved verification remains');
  });
  it('reviews a newly completed plan step before accepting its status',async()=> {
    const plan = {phases:[{id:'phase',title:'Build',steps:[{id:'step',title:'Implement',status:'done'}]}]};
    const t = setup([action('set_plan',plan),action('review_result',{verdict:'changes_requested',findings:['No implementation evidence']}),final('Work remains')]);
    await t.runtime.submit(t.chat.id,'Build it');await t.runtime.wait(t.chat.id);
    expect(t.store.plan(t.chat.id)).toEqual({phases:[]});
    expect(t.store.events(t.chat.id).filter(event=>event.type==='review')).toHaveLength(1);
    expect(t.store.chat(t.chat.id).status).toBe('idle');
  });
  it('notifies active agents of manual file edits and invalidates pending approvals',async()=> {
    const t = setup([delegate(),action('write_file',{path:'label.txt',content:'new',baseHash:'old'}),final('Preserved manual edit'),verdict(),final()]);
    await t.runtime.submit(t.chat.id,'Build it');await t.runtime.wait(t.chat.id);
    const approval = t.store.approvals(t.chat.id)[0];
    t.runtime.notifyFileChange(t.chat.projectId,'label.txt','editor');
    expect(t.store.getApproval(approval.id).status).toBe('stale');
    await t.runtime.wait(t.chat.id);
    expect(t.executed).toEqual([]);
    expect(t.store.chat(t.chat.id).status).toBe('idle');
    expect(t.store.events(t.chat.id).some(event=>event.type==='steering')).toBe(true);
  });
});
