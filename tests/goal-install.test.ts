import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { roleInstructions } from '../server/prompts.js';
import { goalOf, type InstallRecoveryReceipt } from '../server/goals.js';
import { orchestrationFixture, call, complete, pass, stateOf } from './orchestration-fixture.js';
import { fakeHelper } from './install-fixture.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(goal=true) {
  const t=await orchestrationFixture();cleanups.push(t.close);await t.seed();
  const {helper,records}=fakeHelper(),execute=helper.execute.getMockImplementation()!;
  helper.execute.mockImplementation(async decision=>{await execute(decision);throw new Error('Lost reply after remote success');});
  const app=await createApp({config:readConfig({STARK_BASE_URL:'http://127.0.0.1:1',STARK_API_KEY:'synthetic'}),store:t.store,provider:t.provider,tools:t.tools,hooks:{instructions:roleInstructions},packageHelper:async()=>helper});
  cleanups.push(()=>app.app.close());app.installs.update({policy:'auto',revision:0});
  t.replies.push(call('recommend_packages',{packages:[{name:'hello'}],reason:'Synthetic dependency'}));if(!goal)t.replies.push(complete());
  await app.runtime.submit(t.chat.id,goal?'/goal Deliver all\n- Inspect required files':'Inspect dependency');await app.runtime.wait(t.chat.id);
  const install=t.store.installs()[0];expect(install.state).toBe('uncertain');expect(helper.execute).toHaveBeenCalledTimes(1);
  return {...t,...app,helper,records,install};
}
const goal=(t:Awaited<ReturnType<typeof fixture>>)=>goalOf(t.store,t.chat.id)!;

it('resolves only the original install gate through explicit authenticated recovery, then completes without replay',async()=>{
  const t=await fixture();expect(goal(t).status).toBe('blocked');const originalIds=goal(t).uncertainEventIds;
  await t.installs.recover(t.install.id,false);
  expect(goal(t).status).toBe('blocked');expect(goal(t).resolvedUncertainties??[]).toHaveLength(0);
  t.replies.push(input=>{const g=stateOf(input).goal;return t.delegate(1,{goal:{goalId:g.id,goalRevision:g.revision,criterionIds:g.criteria.map((c:{id:string})=>c.id)}});},call('read_file',{path:'result.txt'}),complete(),call('read_file',{path:'result.txt'}),pass(),input=>{const {goal:g,plan,modeVersion}=stateOf(input);return call('request_goal_completion',{goalId:g.id,goalRevision:g.revision,planId:plan.id,planVersion:plan.version,modeVersion,reviewEventIds:g.reviews.map((r:{eventId:number})=>r.eventId)});});
  await t.runtime.control(t.chat.id,'resume');await t.runtime.wait(t.chat.id);
  expect(goal(t).status).toBe('completed');expect(goal(t).uncertainEventIds).toEqual(originalIds);expect(goal(t).resolvedUncertainties).toHaveLength(1);expect(t.helper.execute).toHaveBeenCalledTimes(1);
});

it('recognizes an already explicitly reconciled historical install when creating a goal',async()=>{
  const t=await fixture(false);await t.installs.recover(t.install.id,false);
  t.replies.push(call('ask_user',{question:'Review the remaining requirements.'}));await t.runtime.submit(t.chat.id,'/goal Inspect files');await t.runtime.wait(t.chat.id);
  expect(goal(t).status).toBe('waiting_for_user');expect(goal(t).uncertainEventIds).toHaveLength(1);expect(goal(t).resolvedUncertainties).toHaveLength(1);expect(t.helper.execute).toHaveBeenCalledTimes(1);
});

it.each(['target','preview','request','event','current-target','current-preview','current-state'] as const)('rejects mismatched %s reconciliation bindings on Resume',async mismatch=>{
  const t=await fixture();await t.installs.recover(t.install.id,false);
  const key=`install-reconciliation:${t.install.id}`,receipt=t.store.getState<InstallRecoveryReceipt>(key,null!);
  if(mismatch==='target')receipt.targetKey='different target';if(mismatch==='preview')receipt.previewDigest='different preview';if(mismatch==='request')receipt.installId='different request';if(mismatch==='event')receipt.eventId=999999;
  t.store.setState(key,receipt);
  const current=t.store.install(t.install.id);
  if(mismatch==='current-target')t.store.saveInstall({...current,settings:{...current.settings,target:{...current.settings.target!,id:'f'.repeat(64)}}});
  if(mismatch==='current-preview')t.store.saveInstall({...current,previewDigest:'f'.repeat(64)});
  if(mismatch==='current-state')t.store.saveInstall({...current,state:'uncertain',recoveryRequired:true});
  await expect(t.runtime.control(t.chat.id,'resume')).rejects.toThrow('uncertain');expect(t.helper.execute).toHaveBeenCalledTimes(1);expect(goal(t).completion).toBeUndefined();
});

it('does not accept unhealthy helper success or manual install status without a validated receipt',async()=>{
  const t=await fixture();t.records.get(t.install.id)!.reconciliation={healthy:false,matches:true,packages:[]};
  await expect(t.installs.recover(t.install.id,false)).rejects.toThrow('unavailable');expect(t.store.install(t.install.id).state).toBe('uncertain');
  t.store.saveInstall({...t.store.install(t.install.id),state:'succeeded',recoveryRequired:false,reconciliation:{healthy:true,matches:true,packages:[]}});
  await expect(t.runtime.control(t.chat.id,'resume')).rejects.toThrow('uncertain');expect(t.helper.execute).toHaveBeenCalledTimes(1);
});

it.each(['receipt-write','receipt-commit','goal-write','goal-commit'] as const)('rolls back %s faults without resolving or replaying an install',async point=>{
  const t=await fixture(),set=t.store.setState.bind(t.store),exec=t.store.db.exec.bind(t.store.db);let armed=false;
  if(point.startsWith('goal'))await t.installs.recover(t.install.id,false);
  const before=goal(t),install=t.store.install(t.install.id),events=t.store.events(t.chat.id);
  const write=vi.spyOn(t.store,'setState').mockImplementation((key,value)=>{set(key,value);if(key===(point.startsWith('goal')?`goal:${t.chat.id}`:`install-reconciliation:${t.install.id}`)){armed=true;if(point.endsWith('write'))throw new Error('Injected durable write');}});
  const commit=vi.spyOn(t.store.db,'exec').mockImplementation(sql=>{if(armed&&point.endsWith('commit')&&sql==='COMMIT')throw new Error('Injected durable COMMIT');exec(sql);});
  await expect(point.startsWith('goal')?t.runtime.control(t.chat.id,'resume'):t.installs.recover(t.install.id,false)).rejects.toThrow();
  expect(goal(t)).toEqual(before);expect(t.store.install(t.install.id)).toEqual(install);expect(t.store.events(t.chat.id)).toEqual(events);expect(t.helper.execute).toHaveBeenCalledTimes(1);
  write.mockRestore();commit.mockRestore();
  if(point.startsWith('receipt'))await t.installs.recover(t.install.id,false);
  t.replies.push(call('ask_user',{question:'Remaining scope needs human review.'}));await t.runtime.control(t.chat.id,'resume');await t.runtime.wait(t.chat.id);expect(goal(t).status).toBe('waiting_for_user');expect(t.helper.execute).toHaveBeenCalledTimes(1);
});

it('keeps generic shell uncertainty blocked while resolving exact install references after restart',async()=>{
  const t=await fixture();const shell=t.store.event(t.chat.id,'tool',{agentId:'shell',action:{name:'run_shell'},result:{ok:false,data:{uncertain:true}}});
  const current=goal(t);current.uncertainEventIds.push(shell.id);t.store.setState(`goal:${t.chat.id}`,current);t.store.recover();
  await t.installs.recover(t.install.id,false);await expect(t.runtime.control(t.chat.id,'resume')).rejects.toThrow('uncertain');
  expect(goal(t).resolvedUncertainties!.length).toBeGreaterThan(0);expect(goal(t).uncertainEventIds).toContain(shell.id);expect(t.helper.execute).toHaveBeenCalledTimes(1);
});

it('rejects a current local install change while an explicit recovery reply is in flight',async()=>{
  const t=await fixture(),status=t.helper.status.getMockImplementation()!;let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
  t.helper.status.mockImplementation(async id=>{const result=await status(id);entered();await wait;return result;});
  const recovery=t.installs.recover(t.install.id,false);await ready;
  t.store.saveInstall({...t.store.install(t.install.id),previewDigest:'f'.repeat(64)});release();
  await expect(recovery).rejects.toThrow('unavailable');expect(t.store.getState(`install-reconciliation:${t.install.id}`,null)).toBeNull();expect(t.helper.execute).toHaveBeenCalledTimes(1);
});
