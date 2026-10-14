import { afterEach, describe, expect, it, vi } from 'vitest';
import { Runtime, type RunState } from '../server/runtime.js';
import { roleInstructions } from '../server/prompts.js';
import { goalOf, goalInput, goalRevisionInput, parseGoalCommand, recordGoalEvidence } from '../server/goals.js';
import { orchestrationFixture, call, complete, pass, stateOf, testResult, type Input, type Reply } from './orchestration-fixture.js';
import { nativeState } from './native-fixture.js';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { PlanPanel } from '../client/Panels.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(phases=1) {const t=await orchestrationFixture(phases);cleanups.push(t.close);return t;}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const inspect=()=>call('read_file',{path:'result.txt'});
const finish=():Reply[]=>[complete(),inspect(),pass()];
const delegate=(t:Fixture,phase=1,extra:Record<string,unknown>={}):Reply=>input=>{
  const goal=stateOf(input).goal;
  return t.delegate(phase,{goal:{goalId:goal.id,goalRevision:goal.revision,criterionIds:goal.criteria.map((c:{id:string})=>c.id)},...extra});
};
const request=(extra:Record<string,unknown>={}):Reply=>(input:Input)=>{
  const {goal,plan,modeVersion}=stateOf(input);
  return call('request_goal_completion',{goalId:goal.id,goalRevision:goal.revision,planId:plan.id,planVersion:plan.version,modeVersion,reviewEventIds:goal.reviews.map((r:{eventId:number})=>r.eventId),...extra});
};
const goal=(t:Fixture)=>goalOf(t.store,t.chat.id)!;
const ask=()=>call('ask_user',{question:'Please inspect this concrete result before continuing.'});
const run=(t:Fixture)=>t.run('/goal Deliver every phase\n- Inspect and review every required phase');

describe('M24 durable goals with synthetic provider and real runtime/store/files',()=>{
  it('continues an eight-phase goal after a phase-two end and accepts only the final explicit evidence request',async()=>{
    const t=await fixture(8);await t.seed();
    for(let phase=1;phase<=8;phase++) {
      t.replies.push(delegate(t,phase),inspect(),...finish());
      if(phase===2)t.replies.push(complete(),input=>{
        expect(stateOf(input).readiness.remainingSteps).toBe(6);
        expect(stateOf(input).goal.status).toBe('running');
        return {text:'A premature status update.',finishReason:'stop'};
      });
    }
    t.replies.push(request());await run(t);
    expect(goal(t).status).toBe('completed');expect(goal(t).reviews).toHaveLength(8);
    expect(t.store.plan(t.chat.id).phases.every(phase=>phase.steps[0].status==='done')).toBe(true);
    expect(t.store.chat(t.chat.id).status).toBe('idle');expect(t.replies).toHaveLength(0);
    expect(t.store.events(t.chat.id).filter(event=>event.type==='goal_completed')).toHaveLength(1);
  });

  it.each(['unsupported','goal','plan','mode','ids'] as const)('rejects %s completion without manufacturing success',async kind=>{
    const t=await fixture();await t.seed();
    if(kind!=='unsupported')t.replies.push(delegate(t),inspect(),...finish());
    t.replies.push(request(kind==='goal'?{goalRevision:999}:kind==='plan'?{planVersion:999}:kind==='mode'?{modeVersion:999}:{reviewEventIds:[999]}),ask());await run(t);
    expect(goal(t).status).toBe('waiting_for_user');expect(goal(t).completion).toBeUndefined();
    expect(t.store.events(t.chat.id).some(event=>event.type==='goal_completed')).toBe(false);
  });

  it.each(['removed','renamed','same-id-shrink'] as const)('preserves original scope across model %s edits',async edit=>{
    const t=await fixture(2);await t.seed();
    const phases=structuredClone(t.plan.phases);
    if(edit==='removed')phases.pop();else if(edit==='renamed')phases[1].steps[0].title='Pretend completed';else phases[1].steps=[];
    t.replies.push(call('set_plan',{phases}),request({reviewEventIds:[999]}),ask());await run(t);
    expect(goal(t).requiredSteps.some(step=>step.title==='Deliver phase 2')).toBe(true);
    expect(goal(t).status).toBe('waiting_for_user');expect(goal(t).completion).toBeUndefined();
  });

  it('bounds repeated prose and preserves quotas through restart; resume explicitly renews them',async()=>{
    const t=await fixture();for(let i=0;i<16;i++)t.replies.push({text:'Still thinking.',finishReason:'stop'});
    await run(t);expect(goal(t).status).toBe('paused');expect(goal(t).budget.turns).toBe(16);
    expect(t.requests).toHaveLength(16);const before=structuredClone(goal(t).budget);
    t.store.recover();expect(goal(t).budget).toEqual(before);
    const restored=new Runtime(t.store,t.provider,t.tools,t.config,{instructions:roleInstructions});
    await new Promise(resolve=>setTimeout(resolve,10));expect(t.requests).toHaveLength(16);
    t.replies.push(ask());await restored.control(t.chat.id,'resume');await restored.wait(t.chat.id);
    expect(goal(t).status).toBe('waiting_for_user');expect(goal(t).budget.turns).toBe(1);await restored.close();
  });

  it('waits for explicit approval without resetting the goal budget',async()=>{
    const t=await fixture();await t.seed();t.store.updateChat(t.chat.id,{approvalMode:'review'});
    const file=await t.tools.read(t.root,'result.txt');
    t.replies.push(delegate(t),call('write_file',{path:'result.txt',baseHash:file.hash,content:'Approved change'}),...finish(),request());
    await run(t);expect(goal(t).status).toBe('waiting_for_approval');const turns=goal(t).budget.turns;
    const approval=t.store.approvals(t.chat.id).find(item=>item.status==='pending')!;
    await t.runtime.decide(approval.id,'approve');await t.runtime.wait(t.chat.id);
    expect(goal(t).status).toBe('completed');expect(goal(t).budget.turns).toBeGreaterThan(turns);
  });

  it('planning stores intent and requires Start building before goal delegation',async()=>{
    const t=await fixture();await t.seed();t.replies.push({text:'Plan ready.',finishReason:'stop'});await t.run('/plan Inspect every phase');
    t.replies.push(delegate(t),{text:'Awaiting Start building.',finishReason:'stop'});await run(t);
    expect(goal(t).status).toBe('waiting_for_user');expect(t.executed).toHaveLength(0);
    t.replies.push(delegate(t),inspect(),...finish(),request());
    await t.runtime.startBuilding(t.chat.id,{planId:t.plan.id!,planVersion:t.plan.version!,modeVersion:t.store.chat(t.chat.id).modeVersion!});await t.runtime.wait(t.chat.id);
    expect(goal(t).status).toBe('completed');
  });

  it('rejects final evidence after a manual file change without trusting prior PASS',async()=>{
    const t=await fixture();await t.seed();t.replies.push(delegate(t),inspect(),...finish(),async input=>{await t.seed('result.txt','Manual edit');return (request() as (input:Input)=>ReturnType<typeof call>)(input);},ask());
    await run(t);expect(goal(t).status).toBe('waiting_for_user');expect(goal(t).completion).toBeUndefined();
    expect(t.store.messages(t.chat.id).some(message=>message.content.includes('stale or scope is unknown'))).toBe(true);
  });

  it('retains failed checks across popped frames, unrelated assignments and unchanged human revisions',async()=>{
    const t=await fixture(2);await t.seed();t.commandResults.push(testResult('failed'));
    t.replies.push(delegate(t),call('run_tests',{command:'full suite'}),...finish(),...finish(),...finish(),delegate(t,2),inspect(),...finish(),ask());await run(t);
    expect(goal(t).verificationBlockers.join(' ')).toContain('failed verification');
    const previous=goal(t);t.replies.push(ask());
    await t.runtime.setGoal(t.chat.id,{objective:previous.objective,acceptanceCriteria:previous.criteria.map(item=>item.text)},{expectedRevision:previous.revision,reason:'Retain all requirements and continue'});await t.runtime.wait(t.chat.id);
    expect(goal(t).criteria[0].id).toBe(previous.criteria[0].id);
    expect(goal(t).verificationBlockers.join(' ')).toContain('failed verification');
  });

  it('preserves uncertain shell outcomes across restart, new goal revisions and explicit resume',async()=>{
    const t=await fixture();await t.seed();t.commandResults.push({ok:false,output:'Lost command reply',data:{uncertain:true}});
    t.replies.push(delegate(t),call('run_shell',{command:'possibly changed source'}));await run(t);
    expect(goal(t).status).toBe('blocked');expect(goal(t).uncertainEventIds).toHaveLength(1);
    t.store.recover();await expect(t.runtime.control(t.chat.id,'resume')).rejects.toThrow('uncertain');
    await t.runtime.setGoal(t.chat.id,{objective:'Revised intent',acceptanceCriteria:['New criterion']},{expectedRevision:1,reason:'Explicit changed intent'});
    expect(goal(t).status).toBe('blocked');expect(t.executed.filter(item=>item.name==='run_shell')).toHaveLength(1);
  });

  it('allows explicit human observational criteria with historical read evidence, but no model downgrade',async()=>{
    const t=await fixture();t.replies.push(delegate(t,1,{evidenceKind:'observation'}),call('list_files',{}),complete(),call('list_files',{}),pass(),request());
    await t.run('/goal Inspect the empty directory\n- [observation] Report the observed directory entries');
    expect(goal(t).status).toBe('completed');
    const second=await fixture();second.replies.push(delegate(second,1,{evidenceKind:'observation'}),ask());await run(second);
    expect(goal(second).status).toBe('waiting_for_user');expect(second.executed).toHaveLength(0);
  });

  it.each(['write','commit'] as const)('rolls back goal creation and human provenance after a %s fault',async point=>{
    const t=await fixture();const before=t.store.detail(t.chat.id);
    const set=t.store.setState.bind(t.store),exec=t.store.db.exec.bind(t.store.db);let armed=true;
    vi.spyOn(t.store,'setState').mockImplementation((key,value)=>{if(point==='write'&&armed&&key.startsWith('goal:')){armed=false;throw new Error('injected goal write');}set(key,value);});
    vi.spyOn(t.store.db,'exec').mockImplementation(sql=>{if(point==='commit'&&armed&&sql==='COMMIT'){armed=false;throw new Error('injected goal commit');}exec(sql);});
    await expect(run(t)).rejects.toThrow('injected goal');
    expect(t.store.detail(t.chat.id)).toEqual(before);expect(t.requests).toHaveLength(0);
  });

  it('validates explicit syntax, bounds and duplicate/ambiguous identities',()=>{
    expect(parseGoalCommand('/goal Build it\n- Pass all checks')).toMatchObject({objective:'Build it',acceptanceCriteria:['Pass all checks']});
    expect(()=>parseGoalCommand('/goal')).toThrow();expect(()=>parseGoalCommand('/goal Build\n- [observation]')).toThrow();
    expect(goalInput.safeParse({objective:'Build',acceptanceCriteria:['A','A']}).success).toBe(false);
    expect(goalRevisionInput.safeParse({objective:'Build',acceptanceCriteria:['A'],observationCriteria:[1],expectedRevision:1,reason:'Change'}).success).toBe(false);
    expect(parseGoalCommand('/goal Inspect\n- [observation]suffix')).toMatchObject({acceptanceCriteria:['[observation]suffix'],observationCriteria:[]});
  });

  it.each(['write','commit'] as const)('rolls back completion, native results and cached state on a %s fault',async point=>{
    const t=await fixture();await t.seed();t.replies.push(delegate(t),inspect(),...finish(),ask());await run(t);
    const input=t.requests.at(-1)!,reply=(request() as (input:Input)=>ReturnType<typeof call>)(input),nativeCall=reply.toolCalls![0];
    const state=t.store.getState<RunState>(`run:${t.chat.id}`,null!);state.frames[0].messages.push({role:'assistant',content:'',tool_calls:[nativeCall]});state.frames[0].queuedCalls=[nativeCall];
    const current=goal(t);current.status='running';t.store.setState(`goal:${t.chat.id}`,current);t.store.setState(`run:${t.chat.id}`,state);(t.runtime as any).runs.set(t.chat.id,state);
    const before=structuredClone(state),beforeGoal=goal(t),events=t.store.events(t.chat.id),set=t.store.setState.bind(t.store),exec=t.store.db.exec.bind(t.store.db);let armed=false;
    vi.spyOn(t.store,'setState').mockImplementation((key,value)=>{set(key,value);if(key.startsWith('goal:')&&(value as any).status==='completed'){armed=true;if(point==='write')throw new Error('injected completion write');}});
    vi.spyOn(t.store.db,'exec').mockImplementation(sql=>{if(point==='commit'&&armed&&sql==='COMMIT')throw new Error('injected completion commit');exec(sql);});
    await expect((t.runtime as any).completeGoal(t.chat.id,state,state.frames[0],nativeCall,{name:'request_goal_completion',args:JSON.parse(nativeCall.function.arguments)},new AbortController().signal)).rejects.toThrow('injected completion');
    expect(state).toEqual(before);expect(goal(t)).toEqual(beforeGoal);expect(t.store.events(t.chat.id)).toEqual(events);expect(t.store.getState(`run:${t.chat.id}`,null)).toEqual(before);
  });

  it.each(['write','commit'] as const)('rolls back human revision provenance and protected scope on a %s fault',async point=>{
    const t=await fixture();t.replies.push(ask());await run(t);const before=t.store.detail(t.chat.id),state=t.store.getState(`run:${t.chat.id}`,null);
    const set=t.store.setState.bind(t.store),exec=t.store.db.exec.bind(t.store.db);let armed=false;
    vi.spyOn(t.store,'setState').mockImplementation((key,value)=>{set(key,value);if(key.startsWith('goal:')){armed=true;if(point==='write')throw new Error('injected revision write');}});
    vi.spyOn(t.store.db,'exec').mockImplementation(sql=>{if(point==='commit'&&armed&&sql==='COMMIT')throw new Error('injected revision commit');exec(sql);});
    await expect(t.runtime.setGoal(t.chat.id,{objective:'New scope',acceptanceCriteria:['New requirement']},{expectedRevision:1,reason:'Explicit new scope'})).rejects.toThrow('injected revision');
    expect(t.store.detail(t.chat.id)).toEqual(before);expect(t.store.getState(`run:${t.chat.id}`,null)).toEqual(state);expect((t.runtime as any).runs.get(t.chat.id)).toEqual(state);
  });

  it.each(['write','commit'] as const)('recovers goal uncertainty atomically on a %s fault and never launches it',async point=>{
    const t=await fixture();t.replies.push(ask());await run(t);
    const state=nativeState<RunState>({frames:[{id:'lost',role:'coder',repairs:0,messages:[],pending:{id:'lost-shell',stage:'executing',action:{name:'run_shell',args:{command:'uncertain effect'}}}}],steering:[],generation:0,steps:7,planOnly:false});
    t.store.setState(`run:${t.chat.id}`,state);t.store.updateChat(t.chat.id,{status:'running'});const current=goal(t);current.status='running';t.store.setState(`goal:${t.chat.id}`,current);
    const before=t.store.detail(t.chat.id),set=t.store.setState.bind(t.store),exec=t.store.db.exec.bind(t.store.db);let armed=false;
    const write=vi.spyOn(t.store,'setState').mockImplementation((key,value)=>{set(key,value);if(key.startsWith('goal:')){armed=true;if(point==='write')throw new Error('injected recovery write');}});
    const commit=vi.spyOn(t.store.db,'exec').mockImplementation(sql=>{if(point==='commit'&&armed&&sql==='COMMIT')throw new Error('injected recovery commit');exec(sql);});
    expect(()=>t.store.recover()).toThrow('injected recovery');expect(t.store.detail(t.chat.id)).toEqual(before);expect(t.store.getState(`run:${t.chat.id}`,null)).toEqual(state);
    write.mockRestore();commit.mockRestore();t.store.recover();expect(goal(t).status).toBe('blocked');const recovered=goal(t);t.store.recover();expect(goal(t)).toEqual(recovered);
    const restored=new Runtime(t.store,t.provider,t.tools,t.config,{instructions:roleInstructions});expect(t.executed).toHaveLength(0);await expect(restored.control(t.chat.id,'resume')).rejects.toThrow('uncertain');await restored.close();
  });

  it.each(['pause','steer','revision','plan'] as const)('rejects completion when %s arrives during its fresh scope await',async change=>{
    const t=await fixture();await t.seed();let entered!:()=>void,release!:()=>void,armed=false,blocked=false;
    const ready=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve),read=t.tools.read.bind(t.tools);
    vi.spyOn(t.tools,'read').mockImplementation(async(root,filename)=>{if(armed&&!blocked&&filename==='result.txt'){blocked=true;entered();await wait;}return read(root,filename);});
    t.replies.push(delegate(t),inspect(),...finish(),input=>{armed=true;return (request() as (input:Input)=>ReturnType<typeof call>)(input);});
    await t.runtime.submit(t.chat.id,'/goal Deliver all\n- Review all required scope');await ready;
    let pause:Promise<void>|undefined;
    if(change==='pause')pause=t.runtime.control(t.chat.id,'pause');
    else if(change==='steer'){t.replies.push(ask());await t.runtime.submit(t.chat.id,'/btw Preserve the current file');}
    else if(change==='revision'){t.replies.push(ask());await t.runtime.setGoal(t.chat.id,{objective:'Revised goal',acceptanceCriteria:['New criterion']},{expectedRevision:1,reason:'Explicit revised criterion'});}
    else {t.replies.push(ask());t.store.revisePlan(t.chat.id,{phases:[{id:'new',title:'New phase',steps:[{id:'new',title:'New required step',status:'pending'}]}]});}
    release();await pause;await t.runtime.wait(t.chat.id);
    expect(goal(t).completion).toBeUndefined();expect(goal(t).status).toBe(change==='pause'?'paused':'waiting_for_user');
  });

  it('keeps mixed failed obligations when one criterion survives removal/reorder and plan remapping',async()=>{
    const t=await fixture();await t.seed();t.commandResults.push(testResult('failed'));
    t.replies.push(delegate(t),call('run_tests',{command:'full suite'}),...finish(),...finish(),...finish(),ask());await t.run('/goal Deliver\n- A\n- B\n- C');
    const old=goal(t);t.store.revisePlan(t.chat.id,{phases:[{id:'phase-1',title:'Renamed',steps:[{id:'step-1',title:'Remapped',status:'pending'}]}]});
    t.replies.push(ask());await t.runtime.setGoal(t.chat.id,{objective:'Deliver',acceptanceCriteria:['C','A']},{expectedRevision:1,reason:'Remove B explicitly; retain A and C'});await t.runtime.wait(t.chat.id);
    expect(goal(t).criteria.map(item=>item.id)).toEqual([old.criteria[2].id,old.criteria[0].id]);expect(goal(t).verificationBlockers.join(' ')).toContain('failed verification');
    expect(goal(t).superseded[0].criteria.map(item=>item.text)).toEqual(['A','B','C']);
  });

  it('does not resume a paused goal on btw steering or replay its obsolete native queue',async()=>{
    const t=await fixture();t.replies.push(ask());await run(t);await t.runtime.control(t.chat.id,'pause');const count=t.requests.length;
    await t.runtime.submit(t.chat.id,'/btw Preserve manual edits');await t.runtime.wait(t.chat.id);expect(t.requests).toHaveLength(count);expect(goal(t).status).toBe('paused');
    t.replies.push(ask());await t.runtime.control(t.chat.id,'resume');await t.runtime.wait(t.chat.id);expect(goal(t).status).toBe('waiting_for_user');
  });

  it('uses strict normalized HTTP contracts and renders durable scope/blocked reasons safely',async()=>{
    const t=await fixture();const config=readConfig({STARK_BASE_URL:'http://127.0.0.1:1',STARK_API_KEY:'synthetic'});
    const {app,runtime}=await createApp({config,store:t.store,provider:t.provider,tools:t.tools,hooks:{instructions:roleInstructions}});cleanups.push(()=>app.close());
    const url=`/api/chats/${t.chat.id}/goal`;t.replies.push(ask());
    const created=await app.inject({method:'POST',url,payload:{objective:'  Observe  ',acceptanceCriteria:['  <entries>  '],observationCriteria:[0]}});expect(created.statusCode).toBe(202);await runtime.wait(t.chat.id);
    expect(goal(t).objective).toBe('Observe');expect(goal(t).criteria[0]).toMatchObject({text:'<entries>',evidenceKind:'observation'});
    expect((await app.inject({method:'PATCH',url,payload:{objective:'New',acceptanceCriteria:['New'],expectedRevision:99,reason:'Stale'}})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url,payload:{objective:'New',acceptanceCriteria:['New'],observationCriteria:[0,0]}})).statusCode).toBe(400);
    const fetched=await app.inject({method:'GET',url});expect(fetched.json().goal.status).toBe('waiting_for_user');
    const html=renderToStaticMarkup(createElement(PlanPanel,{plan:t.plan,goal:goal(t),chatId:t.chat.id}));expect(html).toContain('&lt;entries&gt;');expect(html).toContain('waiting for user');expect(html).toContain('historical observation');expect(html).toContain('Revise goal scope');expect(html).not.toContain('acceptanceEvidence');
  });

  it.each([false,true])('retains architect-origin helper uncertainty from its actual settled native result (overflow=%s)',async overflow=>{
    const t=await fixture();t.replies.push(ask());await run(t);
    if(overflow){const prior=goal(t);prior.uncertainEventIds=Array.from({length:100},(_,i)=>10000+i);t.store.setState(`goal:${t.chat.id}`,prior);}
    const state=nativeState<RunState>({frames:[{id:'architect-install',role:'architect',repairs:0,messages:[],pending:{id:'install',stage:'done',action:{name:'recommend_packages',args:{packages:[{name:'hello'}],reason:'Fixture need'}},result:{ok:false,output:'Helper outcome uncertain',data:{state:'uncertain',recoveryRequired:true}}}}],steering:[],generation:0,steps:0,planOnly:false});
    t.store.setState(`run:${t.chat.id}`,state);(t.runtime as any).runs.set(t.chat.id,state);
    await (t.runtime as any).executePending(t.chat.id,state,state.frames[0],new AbortController().signal);
    expect(goal(t).uncertainEventIds).toHaveLength(overflow?100:1);if(overflow)expect(goal(t).uncertaintyOverflow).toBe(true);await expect(t.runtime.control(t.chat.id,'resume')).rejects.toThrow('uncertain');
  });

  it('retains an explicit blocked overflow instead of silently accepting truncated uncertainty/evidence',async()=>{
    const t=await fixture();t.replies.push(ask());await run(t);
    t.store.transaction(()=>recordGoalEvidence(t.store,t.chat.id,{id:'overflow',role:'coder',repairs:0,messages:[],acceptanceEvidence:{checks:[],uncertainEventIds:Array.from({length:101},(_,i)=>i+1),overflow:true}}));
    expect(goal(t).uncertainEventIds).toHaveLength(100);expect(goal(t).uncertaintyOverflow).toBe(true);expect(goal(t).evidenceOverflow).toBe(true);
    await expect(t.runtime.control(t.chat.id,'resume')).rejects.toThrow('uncertain');
  });

  it('does not accept observation evidence after an attempted actual write',async()=>{
    const t=await fixture();await t.seed();const file=await t.tools.read(t.root,'result.txt');
    t.replies.push(delegate(t,1,{evidenceKind:'observation'}),call('write_file',{path:'result.txt',baseHash:file.hash,content:'Observed assignment attempted mutation'}),...finish(),...finish(),...finish(),request({reviewEventIds:[999]}),ask());
    await t.run('/goal Inspect\n- [observation] Report historical file contents');
    expect(goal(t).completion).toBeUndefined();expect(goal(t).reviews).toHaveLength(0);
  });
});
