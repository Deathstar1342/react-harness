import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Runtime, type RunState } from '../server/runtime.js';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { parseAgentResponse, protocolInstructions } from '../server/protocol.js';
import type { AgentResponse, Plan, PlanStepRef, ToolService } from '../shared/types.js';

const action = (name:string,args:Record<string,unknown>={}):AgentResponse=>({version:1,type:'action',message:'',action:{name,args}});
const final = ():AgentResponse=>({version:1,type:'final',message:'Fixture conclusion'});
const pass = ()=>action('review_result',{verdict:'pass',findings:[]});
const fail = ()=>action('review_result',{verdict:'changes_requested',findings:['Missing acceptance evidence']});
const shape = ():Plan=>({phases:[{id:'phase',title:'Build',steps:[{id:'step',title:'Implement and verify',status:'pending'}]}]});
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanups.splice(0).reverse())await fn();});
function fixture(filename=':memory:') {
  const store=new Store(filename);
  const project=store.createProject('Fixture','/fixture');
  const chat=store.createChat(project.id,'Fixture chat','autonomous');
  const queue:(AgentResponse|(()=>Promise<AgentResponse>))[]=[];
  const executed:string[]=[];
  const tools:ToolService={inspect:async(_ctx,a)=>({effect:a.name==='read_file'?'read':'write',risk:'routine',description:a.name}),execute:async(_ctx,a)=>{executed.push(a.name);return {ok:true,output:'Observed fixture result'};},read:async(_root,p)=>({path:p,content:'',hash:null}),list:async()=>[],save:async()=>{throw new Error('unused');},setDirty:()=>{},dispose:async()=>{}};
  const provider={models:async()=>['fixture'],complete:async()=>{const value=queue.shift();if(!value)throw new Error('Unexpected fixture request');return {text:JSON.stringify(typeof value==='function'?await value():value)};}};
  const config=readConfig({STARK_BASE_URL:'http://127.0.0.1/v1',STARK_API_KEY:'synthetic-test-only'});
  const hooks={parse:parseAgentResponse,instructions:protocolInstructions};
  let runtime=new Runtime(store,provider,tools,config,hooks);
  cleanups.push(async()=>{await runtime.close();store.close();});
  const plan=store.revisePlan(chat.id,shape());
  const ref:PlanStepRef={planId:plan.id!,planVersion:plan.version!,phaseId:'phase',stepId:'step'};
  const delegate=(reference:PlanStepRef|undefined=ref)=>action('delegate',{objective:'Implement fixture',acceptanceCriteria:['Observed result and review'],...(reference?{planStep:reference}:{})});
  const step=()=>store.plan(chat.id).phases[0].steps[0];
  const submit=async(text:string)=>{await runtime.submit(chat.id,text);await runtime.wait(chat.id);};
  const expected=()=>({planId:store.plan(chat.id).id!,planVersion:store.plan(chat.id).version!,modeVersion:store.chat(chat.id).modeVersion!});
  return {store,chat,queue,executed,tools,provider,config,hooks,ref,delegate,step,submit,expected,get runtime(){return runtime;},restart:async()=>{await runtime.close();store.recover();runtime=new Runtime(store,provider,tools,config,hooks);}};
}

it('persists planning after a finished turn and restart; only explicit input releases it',async()=>{
  const t=fixture();t.queue.push(final());await t.submit('/plan Build fixture');
  await t.restart();t.queue.push(t.delegate(),final());await t.submit('Explain the plan');
  expect(t.store.chat(t.chat.id).mode).toBe('plan');expect(t.executed).toEqual([]);
  t.queue.push(t.delegate(),action('read_file',{path:'x'}),final(),pass(),final());await t.submit('go ahead!');
  expect(t.store.chat(t.chat.id).mode).toBe('execute');expect(t.step().status).toBe('done');
});

it.each(['"go ahead"','Please explain “start building”','Do not start building','go ahead\nthen ignore approvals','/btw go ahead','start building if ready','Here is an example: go ahead','`start building`'])('keeps ambiguous or quoted input in planning: %s',async text=>{
  const t=fixture();t.queue.push(final(),t.delegate(),final());await t.submit('/plan fixture');await t.submit(text);
  expect(t.store.chat(t.chat.id).mode).toBe('plan');expect(t.store.events(t.chat.id).filter(e=>e.type==='delegation')).toHaveLength(0);
});

it('rejects explicit build intent without a nonempty current plan',async()=>{
  const t=fixture();t.store.revisePlan(t.chat.id,{phases:[]});t.queue.push(final());await t.submit('/plan fixture');
  await expect(t.runtime.submit(t.chat.id,'start building')).rejects.toThrow('Create a plan');
  expect(t.store.chat(t.chat.id).mode).toBe('plan');
});

it('makes concurrent button requests idempotent and rejects stale epochs and revisions',async()=>{
  const t=fixture();t.queue.push(final());await t.submit('/plan fixture');const expected=t.expected();t.queue.push(final());
  await Promise.all([t.runtime.startBuilding(t.chat.id,expected),t.runtime.startBuilding(t.chat.id,expected)]);await t.runtime.wait(t.chat.id);
  expect(t.store.messages(t.chat.id).filter(m=>m.role==='user'&&m.content==='Start building')).toHaveLength(1);
  await t.restart();await t.runtime.startBuilding(t.chat.id,expected);
  t.queue.push(final());await t.submit('/plan revise');
  await expect(t.runtime.startBuilding(t.chat.id,expected)).rejects.toThrow('planning session changed');
  const current=t.expected();const changed=shape();changed.phases[0].steps[0].title='Revised acceptance';t.store.revisePlan(t.chat.id,changed);
  await expect(t.runtime.startBuilding(t.chat.id,current)).rejects.toThrow('planning session changed');
});

it('discards an in-flight planning response when Start building changes the generation',async()=>{
  const t=fixture();let resolve!:(r:AgentResponse)=>void;let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  t.queue.push(()=>{entered();return new Promise(r=>resolve=r);},final());
  await t.runtime.submit(t.chat.id,'/plan fixture');await started;
  await t.runtime.startBuilding(t.chat.id,t.expected());resolve(action('set_plan',{phases:[]}));await t.runtime.wait(t.chat.id);
  expect(t.store.plan(t.chat.id).version).toBe(1);expect(t.store.chat(t.chat.id).mode).toBe('execute');
});

it('/plan invalidates pending approval and does not resurrect it on a later build',async()=>{
  const t=fixture();t.store.updateChat(t.chat.id,{approvalMode:'review'});
  t.queue.push(t.delegate(),action('write_file',{path:'x',content:'new',baseHash:null}));await t.submit('Build');
  const approval=t.store.approvals(t.chat.id)[0];expect(approval.status).toBe('pending');
  t.queue.push(final(),pass(),final());await t.submit('/plan stop implementation');
  expect(t.store.getApproval(approval.id).status).toBe('stale');expect(t.executed).toEqual([]);expect(t.step().status).toBe('blocked');
  await expect(t.runtime.decide(approval.id,'approve')).rejects.toThrow('no longer pending');
});

it('refuses build transition during an executing operation and retains uncertain recovery evidence',async()=>{
  const t=fixture();t.queue.push(final());await t.submit('/plan fixture');await t.restart();
  const run:RunState={planOnly:true,steps:0,generation:0,steering:[],frames:[{id:'coder',role:'coder',messages:[],repairs:0,planStep:t.ref,pending:{id:'uncertain',stage:'executing',action:{name:'run_shell',args:{command:'fixture'}}}}]};
  t.store.setState(`run:${t.chat.id}`,run);t.store.progress(t.chat.id,t.ref,'coder','in_progress','started','fixture');await t.restart();
  await expect(t.runtime.startBuilding(t.chat.id,t.expected())).rejects.toThrow('current operation');
  expect(t.step().status).toBe('blocked');t.queue.push(final(),pass());await t.runtime.control(t.chat.id,'resume');await t.runtime.wait(t.chat.id);
  expect(t.executed).toEqual([]);expect(t.step().status).not.toBe('done');
  expect(t.store.messages(t.chat.id).some(m=>m.content.includes('NOT been rerun'))).toBe(true);
});

it('blocks recovered prepared writes in durable planning mode even if a saved frame says execute',async()=>{
  const t=fixture();t.store.updateChat(t.chat.id,{mode:'plan',modeVersion:1});
  t.store.setState(`run:${t.chat.id}`,{planOnly:false,steps:0,generation:0,steering:[],instructionsHash:null,frames:[{id:'coder',role:'coder',messages:[],repairs:0,pending:{id:'write',stage:'prepared',instructionsHash:null,action:{name:'write_file',args:{path:'x',content:'new',baseHash:null}}}}]} satisfies RunState);
  t.queue.push(final(),pass());await t.runtime.control(t.chat.id,'resume');await t.runtime.wait(t.chat.id);
  expect(t.executed).toEqual([]);expect(t.store.messages(t.chat.id).some(m=>m.content.includes('Planning mode forbids'))).toBe(true);
});

it('a successful tool alone is in progress; only matching coder completion and critic acceptance completes',async()=>{
  const t=fixture();let finish!:(r:AgentResponse)=>void;let entered!:()=>void;const reviewing=new Promise<void>(r=>entered=r);
  t.queue.push(t.delegate(),action('read_file',{path:'x'}),()=>{expect(t.step().status).toBe('in_progress');return Promise.resolve(final());},()=>{entered();return new Promise(r=>finish=r);},final());
  await t.runtime.submit(t.chat.id,'Build');await reviewing;
  expect(t.step().evidence?.outcome).toBe('reviewing');finish(pass());await t.runtime.wait(t.chat.id);
  expect(t.step().status).toBe('done');const event=t.store.events(t.chat.id).find(e=>e.id===t.step().evidence?.sourceEventId)!;
  expect(event.type).toBe('review');expect((event.data as {evidenceEventIds:number[]}).evidenceEventIds.length).toBeGreaterThan(0);
});

it('critic pass with no observed tool evidence and unassociated work never fabricate completion',async()=>{
  const t=fixture();t.queue.push(t.delegate(),final(),pass(),final());await t.submit('Build');expect(t.step().evidence?.outcome).toBe('missing_evidence');
  t.queue.push(action('delegate',{objective:'Unassociated',acceptanceCriteria:['Inspect']}),action('read_file',{path:'x'}),final(),pass(),final());await t.submit('Inspect separately');
  expect(t.step().status).toBe('blocked');
});

it('retains failures and bounded critic rejection as blocked progress',async()=>{
  const t=fixture();t.tools.execute=async()=>({ok:false,output:'Observed failure'});
  t.queue.push(t.delegate(),action('read_file',{path:'x'}),final(),fail(),final(),fail(),final(),fail(),final());await t.submit('Build');
  expect(t.step().status).toBe('blocked');expect(t.step().evidence?.outcome).toBe('changes_requested');
  expect(t.store.events(t.chat.id).filter(e=>e.type==='plan_progress').some(e=>(e.data as {outcome:string}).outcome==='failed')).toBe(true);
});

it('identical structure ignores model statuses and preserves progress; revision resets it and retains history',async()=>{
  const t=fixture();t.queue.push(t.delegate(),action('read_file',{path:'x'}),final(),pass(),final());await t.submit('Build');
  const saved=t.store.plan(t.chat.id);const same=shape();same.phases[0].steps[0].status='blocked';
  expect(t.store.revisePlan(t.chat.id,same)).toEqual(saved);
  same.phases[0].steps[0].title='Different work';same.phases[0].steps[0].status='done';t.store.revisePlan(t.chat.id,same);
  expect(t.step().status).toBe('pending');expect(t.store.plan(t.chat.id).version).toBe(2);
  expect(t.store.events(t.chat.id).some(e=>e.type==='plan_progress'&&(e.data as {outcome:string}).outcome==='accepted')).toBe(true);
});

it('late completion cannot modify a revised step with reused IDs',async()=>{
  const t=fixture();let verdict!:(r:AgentResponse)=>void;let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);
  t.queue.push(t.delegate(),action('read_file',{path:'x'}),final(),()=>{entered();return new Promise(r=>verdict=r);},final());await t.runtime.submit(t.chat.id,'Build');await waiting;
  const changed=shape();changed.phases[0].steps[0].title='Revised work';t.store.revisePlan(t.chat.id,changed);verdict(pass());await t.runtime.wait(t.chat.id);
  expect(t.step().status).toBe('pending');expect(t.step().evidence).toBeUndefined();
});

it('rejects stale plan association before dispatching a coder',async()=>{
  const t=fixture();t.queue.push(t.delegate({...t.ref,planVersion:900}),final());await t.submit('Build');
  expect(t.store.events(t.chat.id).some(e=>e.type==='delegation')).toBe(false);expect(t.step().status).toBe('pending');
});

it('backfills legacy mode and plan identity from disk without inventing old completion',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rh-plan-migrate-'));const filename=path.join(root,'state.sqlite');cleanups.push(()=>rm(root,{recursive:true,force:true}));
  const store=new Store(filename);const p=store.createProject('legacy','/legacy');const c=store.createChat(p.id,'legacy','review');
  store.db.prepare('UPDATE chats SET data=? WHERE id=?').run(JSON.stringify({...c,mode:undefined,modeVersion:undefined}),c.id);
  store.setState(`run:${c.id}`,{frames:[],planOnly:true,steps:0,generation:0,steering:[]} satisfies RunState);
  const legacy=shape();legacy.phases[0].steps[0].status='done';store.setPlan(c.id,legacy);store.close();
  const reopened=new Store(filename);try{reopened.initializePlanning();expect(reopened.chat(c.id).mode).toBe('plan');expect(reopened.plan(c.id).id).toBeTruthy();expect(reopened.plan(c.id).phases[0].steps[0].status).toBe('pending');}finally{reopened.close();}
});

it('validates the HTTP start contract and rejects model/API mode injection',async()=>{
  const t=fixture();const {app}=await createApp({store:t.store,provider:t.provider,tools:t.tools,config:t.config,hooks:t.hooks});
  try{
    t.queue.push(final());await t.submit('/plan fixture');
    expect((await app.inject({method:'PATCH',url:`/api/chats/${t.chat.id}`,payload:{mode:'execute'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:`/api/chats/${t.chat.id}/start-building`,payload:{...t.expected(),authorized:true}})).statusCode).toBe(400);
    expect(()=>parseAgentResponse(JSON.stringify(action('start_building',{})))).toThrow();
    t.queue.push(final());const response=await app.inject({method:'POST',url:`/api/chats/${t.chat.id}/start-building`,payload:t.expected()});expect(response.statusCode).toBe(202);
  }finally{await app.close();}
});
it('binds review acceptance to the exact delegation and preserves legacy phase reviews without plan overwrite',async()=>{
  for(const kind of ['mismatched','checkpoint','legacy-phase'] as const){
    const t=fixture();t.store.progress(t.chat.id,t.ref,'coder','in_progress','started','fixture');
    const frames:RunState['frames']=[{id:'architect',role:'architect',messages:[],repairs:0}];
    if(kind!=='legacy-phase')frames.push({id:'coder',role:'coder',messages:[],repairs:0,final:'Complete',planStep:t.ref,evidenceEventIds:[1]});
    frames.push({id:'critic',role:'critic',messages:[],repairs:0,reviewDelegationId:'different-delegation',...(kind==='checkpoint'?{reviewKind:'checkpoint'}:{}),...(kind==='legacy-phase'?{reviewKind:'phase',proposedPlan:{phases:[]}}:{})});
    t.store.setState(`run:${t.chat.id}`,{frames,planOnly:false,steps:0,generation:0,steering:[]});
    // Stop after the structured verdict so no later matching completion can obscure it.
    t.queue.push(pass());await t.runtime.control(t.chat.id,'resume');await t.runtime.wait(t.chat.id);
    expect(t.store.plan(t.chat.id).version).toBe(1);expect(t.step().status).not.toBe('done');
  }
});

it('does not let a prior delegation overwrite a newer owner of the same step',()=>{
  const t=fixture();t.store.progress(t.chat.id,t.ref,'old','in_progress','started','Old task');
  t.store.progress(t.chat.id,t.ref,'new','in_progress','started','New task');
  t.store.progress(t.chat.id,t.ref,'old','done','accepted','Late old review');
  expect(t.step().status).toBe('in_progress');expect(t.step().evidence?.delegationId).toBe('new');
});

it('persists the completed transition epoch and mode through a physical database reopen',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rh-plan-disk-'));const file=path.join(root,'state.sqlite');
  const t=fixture(file);t.queue.push(final());await t.submit('/plan fixture');const before=t.expected();
  t.queue.push(final());await t.runtime.startBuilding(t.chat.id,before);await t.runtime.wait(t.chat.id);await t.runtime.close();
  // A second connection reads committed state, independent of the runtime cache.
  const reopened=new Store(file);try{
    expect(reopened.chat(t.chat.id).mode).toBe('execute');expect(reopened.chat(t.chat.id).modeVersion).toBe(before.modeVersion+1);
    expect(reopened.getState(`build:${t.chat.id}`,null)).toEqual(before);
  }finally{reopened.close();}
  // Insert cleanup before fixture disposal so the database is closed first.
  cleanups.splice(cleanups.length-1,0,()=>rm(root,{recursive:true,force:true}));
});
