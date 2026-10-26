import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {Runtime,type RunState} from '../server/runtime.js';
import {readConfig} from '../server/config.js';
import {recoveryView,RECOVERY_LIMITS} from '../server/recovery.js';
import {createApp} from '../server/app.js';
import {TransportAuth} from '../server/transport-auth.js';
import {InstallService} from '../server/installs.js';
import {createGoal,goalOf,saveGoal} from '../server/goals.js';
import {nativeReply,nativeState} from './native-fixture.js';
import {fakeHelper} from './install-fixture.js';
import type {Action,CompletionResult,ToolService} from '../shared/types.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanup.splice(0).reverse())await fn();});
const action:Action={name:'run_shell',args:{command:'synthetic modifying command'}};
const logical=(store:Store)=>JSON.stringify(['projects','chats','messages','events','state','approvals','test_reports','file_changes','install_requests'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'m33-recovery-'));await mkdir(path.join(root,'project'));
  let store=new Store(path.join(root,'state.sqlite'));const project=store.createProject('Recovery',path.join(root,'project')),chat=store.createChat(project.id,'Restart evidence','autonomous');store.initializePlanning();
  const config=readConfig({HARNESS_DATA_DIR:path.join(root,'data'),HARNESS_WORKSPACE_ROOT:path.join(root,'workspace'),STARK_BASE_URL:'http://127.0.0.1:1/private-endpoint',STARK_API_KEY:'private-provider-sentinel'});
  const tools:ToolService={inspect:async()=>({effect:'execute',risk:'elevated',description:'Synthetic tool'}),execute:vi.fn(async()=>({ok:true,output:'private-output-sentinel',data:{exitCode:0,output:'private-output-sentinel'}})),read:async(_root,path)=>({path,content:'',hash:null}),list:async()=>[],save:async()=>{throw new Error('No writes');},setDirty:()=>{},dispose:async()=>{}};
  const runtimes:Runtime[]=[];
  const runtime=(responses:CompletionResult[]=[])=>{const complete=vi.fn(async()=>responses.shift()??{text:'Stopped',finishReason:'stop'});const runtime=new Runtime(store,{models:async()=>[],complete},tools,config,{instructions:()=>''});runtimes.push(runtime);return {runtime,complete};};
  const restart=async()=>{for(const r of runtimes.splice(0))await r.close();store.close();store=new Store(path.join(root,'state.sqlite'));store.recover();};
  cleanup.push(async()=>{for(const r of runtimes)await r.close();store.close();await rm(root,{recursive:true,force:true});});
  const seed=(stage:'prepared'|'executing'|'done',result?:unknown)=>{
    const state=nativeState<RunState>({frames:[{id:'coder-original',role:'coder',messages:[],repairs:0,pending:{id:randomUUID(),stage,action,...(result?{result:result as never}:{})}}],generation:2,steps:1,steering:[],planOnly:false});store.setState(`run:${chat.id}`,state);store.updateChat(chat.id,{status:'running'});return state;
  };
  return {root,project,chat,config,tools,runtime,restart,seed,get store(){return store;},read:()=>recoveryView(store,chat.id)};
}

describe('bounded read-only recovery projection, actual disk SQLite and Runtime',()=>{
  it('preserves a real Runtime proposal across reopen without dispatch and never mutates on observation',async()=>{
    const t=await fixture();t.store.updateChat(t.chat.id,{approvalMode:'review'});
    const {runtime}=t.runtime([nativeReply('delegate',{objective:'Run a synthetic command',acceptanceCriteria:['Retain evidence']}),nativeReply(action.name,action.args)]);
    await runtime.submit(t.chat.id,'Original human assignment');await runtime.wait(t.chat.id);
    expect(t.store.approvals(t.chat.id).some(a=>a.status==='pending')).toBe(true);expect(t.tools.execute).not.toHaveBeenCalled();
    await t.restart();const before=logical(t.store),view=t.read();
    expect(view.entries.some(e=>e.status==='not_started'&&e.callId&&e.frameId)).toBe(true);
    expect(view.humanMessageIds).toEqual([t.store.messages(t.chat.id).find(m=>m.role==='user')!.id]);
    expect(t.read().revision).toBe(view.revision);expect(logical(t.store)).toBe(before);expect(t.tools.execute).not.toHaveBeenCalled();
  });
  it('retains lost modifying-dispatch uncertainty after disk restart and observation never retries it',async()=>{
    const t=await fixture();vi.mocked(t.tools.execute).mockRejectedValue(new Error('Lost reply after modifying dispatch'));
    const {runtime}=t.runtime([nativeReply('delegate',{objective:'Run command',acceptanceCriteria:['Evidence']}),nativeReply(action.name,action.args)]);
    await runtime.submit(t.chat.id,'Run');await runtime.wait(t.chat.id);expect(t.tools.execute).toHaveBeenCalledTimes(1);
    await t.restart();const before=logical(t.store),view=t.read();
    expect(view.entries.some(e=>e.status==='uncertain'&&e.commandId&&e.evidence.length)).toBe(true);
    t.read();expect(logical(t.store)).toBe(before);expect(t.tools.execute).toHaveBeenCalledTimes(1);
  });
  it('keeps real completed command exit evidence and never leaks output/arguments/private frames',async()=>{
    const t=await fixture();const {runtime}=t.runtime([nativeReply('delegate',{objective:'Run',acceptanceCriteria:['Evidence']}),nativeReply(action.name,action.args)]);
    await runtime.submit(t.chat.id,'Human private-assignment-sentinel');await runtime.wait(t.chat.id);await t.restart();
    const view=t.read(),entry=view.entries.find(e=>e.label==='run_shell');expect(entry?.status).toBe('completed');expect(entry?.evidence.length).toBeGreaterThan(0);
    const text=JSON.stringify(view);for(const secret of ['private-output-sentinel','synthetic modifying command','private-provider-sentinel','private-endpoint','private-assignment-sentinel','tool_calls','acceptanceEvidence'])expect(text).not.toContain(secret);
  });
  it('shows owned running then restart-uncertain process records without adopting/cancelling anything',async()=>{
    const t=await fixture(),state=t.seed('executing'),pending=state.frames[0].pending!,id=randomUUID(),now=new Date().toISOString();
    t.store.setState(`process-job:${id}`,{id,projectId:t.project.id,chatId:t.chat.id,frameId:'coder-original',commandId:pending.id,callId:pending.callId,status:'running',createdAt:now,updatedAt:now,dispatched:true,generation:2,output:'private-process-output'});
    expect(t.read().entries.find(e=>e.processId===id)?.status).toBe('running');await t.restart();const before=logical(t.store);
    expect(t.read().entries.find(e=>e.processId===id)?.status).toBe('uncertain');expect(logical(t.store)).toBe(before);expect(t.tools.execute).not.toHaveBeenCalled();
  });
  it('preserves paused/blocked goals, exact original human provenance and pending-plan uncertainty',async()=>{
    const t=await fixture(),human=t.store.message(t.chat.id,'user','Original private goal');
    t.store.revisePlan(t.chat.id,{phases:[{id:'phase',title:'Private scope',steps:[{id:'step',title:'Private testcase',status:'pending'}]}]});
    createGoal(t.store,t.chat.id,{objective:'Private objective',acceptanceCriteria:['Private testcase']},human.id);t.seed('executing');await t.restart();
    const before=logical(t.store),view=t.read();expect(view.goal).toMatchObject({status:'blocked',humanMessageId:human.id});expect(view.goal?.uncertainEventIds.length).toBeGreaterThan(0);
    expect(view.entries.find(e=>e.kind==='plan')?.status).toBe('unknown');expect(JSON.stringify(view)).not.toContain('Private testcase');expect(logical(t.store)).toBe(before);
    const goal=goalOf(t.store,t.chat.id)!;goal.status='paused';saveGoal(t.store,t.chat.id,goal);expect(t.read().goal?.status).toBe('paused');
    const {runtime}=t.runtime();await expect(runtime.control(t.chat.id,'resume')).rejects.toThrow('unresolved uncertain effects');
  });
  it('reads retained install recovery without expiry, helper calls or generic uncertainty clearing',async()=>{
    const t=await fixture(),fake=fakeHelper(),service=new InstallService(t.store,'critic',async()=>nativeReply('install_decision',{decision:'approve',reason:'Fixture'}),async()=>fake.helper);
    const item=service.create(randomUUID(),t.chat.id,'install-frame','architect',0,{packages:[{name:'hello'}],reason:'Private install rationale'});
    t.store.saveInstall({...item,state:'dispatching',expiresAt:Date.now()-1});await service.close();await t.restart();
    const restored=new InstallService(t.store,'critic',async()=>{throw new Error('No model');},async()=>{throw new Error('No helper');});
    const before=logical(t.store),view=t.read(),entry=view.entries.find(e=>e.installId===item.id);expect(entry?.status).toBe('uncertain');expect(entry?.destination).toBe('installs');expect(entry?.evidence.length).toBeGreaterThan(0);
    expect(logical(t.store)).toBe(before);expect(fake.helper.status).not.toHaveBeenCalled();expect(fake.helper.reconcile).not.toHaveBeenCalled();await restored.close();
  });
  it('correlates duplicate native call IDs by original frame and refuses missing native identity',async()=>{
    const t=await fixture(),state=t.seed('prepared'),first=state.frames[0],call=first.messages.find(m=>m.role==='assistant')!;
    const other=structuredClone(first);other.id='different-frame';other.pending!.id=randomUUID();other.pending!.stage='executing';state.frames.push(other);t.store.setState(`run:${t.chat.id}`,state);t.store.updateChat(t.chat.id,{status:'paused'});
    let view=t.read();expect(view.entries.find(e=>e.frameId===first.id)?.status).toBe('not_started');expect(view.entries.find(e=>e.frameId===other.id)?.status).toBe('uncertain');
    state.frames[0].messages.push(call);t.store.setState(`run:${t.chat.id}`,state);view=t.read();expect(view.entries.find(e=>e.frameId===first.id)?.status).toBe('unknown');
  });
  it('uses unambiguous tuple identities even when original IDs contain delimiters',async()=>{
    const t=await fixture();t.store.event(t.chat.id,'command',{agentId:'a:command:b',commandId:'c',action,status:'uncertain'});t.store.event(t.chat.id,'command',{agentId:'a',commandId:'b:command:c',action,status:'completed',exitCode:0});
    const view=t.read();expect(view.entries.find(e=>e.frameId==='a:command:b')?.status).toBe('uncertain');expect(view.entries.find(e=>e.frameId==='a')?.status).toBe('completed');
  });
  it('keeps conflicts, missing exit evidence and out-of-order uncertainty honest',async()=>{
    const t=await fixture(),frame='frame',commandId=randomUUID();
    const source={agentId:frame,commandId,action,status:'uncertain'};
    t.store.event(t.chat.id,'command',source);t.store.event(t.chat.id,'command',{...source,status:'completed',exitCode:0});
    t.store.event(t.chat.id,'tool',{agentId:'other-frame',commandId:randomUUID(),action,result:{ok:true,output:'success prose'}});
    const view=t.read();expect(view.entries.find(e=>e.frameId===frame)?.status).toBe('uncertain');expect(view.entries.find(e=>e.frameId==='other-frame')?.status).toBe('unknown');
  });
  it('marks legacy correlation and original output truncation without treating either as success',async()=>{
    const t=await fixture();t.store.event(t.chat.id,'tool_output',{output:'PRIVATE_LEGACY_OUTPUT'});t.store.event(t.chat.id,'command',{agentId:'f',commandId:'c',action,status:'uncertain',truncated:true});
    const view=t.read();expect(view.coverage.find(c=>c.source==='legacy output')?.unavailable).toBe(1);expect(view.entries.find(e=>e.commandId==='c')).toMatchObject({status:'uncertain',outputTruncated:true});expect(JSON.stringify(view)).not.toContain('PRIVATE_LEGACY_OUTPUT');
  });
  it('does not let a later running status replace original exact-command uncertainty',async()=>{
    const t=await fixture(),source={agentId:'original-frame',commandId:'original-command',action};
    t.store.event(t.chat.id,'command',{...source,status:'uncertain'});t.store.event(t.chat.id,'command',{...source,status:'running'});
    expect(t.read().entries.find(e=>e.commandId==='original-command')?.status).toBe('uncertain');
  });
  it.each([{uncertain:true},{recoveryRequired:true},{cancelled:true},{timedOut:true},{shellReset:true},{exitCode:0},{state:'uncertain'}])('refuses contradictory recovered native non-dispatch result %j',async indicators=>{
    const t=await fixture(),call=nativeReply('read_file',{path:'fixture'}).toolCalls![0];
    t.store.setState(`run:${t.chat.id}`,{planOnly:false,generation:0,steps:0,steering:[],frames:[{id:'exact-frame',role:'coder',repairs:0,messages:[{role:'assistant',content:'',tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:JSON.stringify({ok:false,data:{status:'not_started',...indicators}})}]}]});
    expect(t.read().entries.find(e=>e.callId===call.id)?.status).toBe('uncertain');
  });
  it('cannot hide a conflicting duplicate native result behind an earlier not_started result',async()=>{
    const t=await fixture(),call=nativeReply('read_file',{path:'fixture'}).toolCalls![0];
    t.store.setState(`run:${t.chat.id}`,{planOnly:false,generation:0,steps:0,steering:[],frames:[{id:'frame',role:'coder',repairs:0,messages:[{role:'assistant',content:'',tool_calls:[call]},...([{ok:false,data:{status:'not_started'}},{ok:true,data:{}}]).map(result=>({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)}))]}]});
    expect(t.read().entries.find(e=>e.callId===call.id)?.status).toBe('uncertain');
  });
  it('retains install uncertainty until an existing exact trusted reconciliation receipt, never a generic state edit',async()=>{
    const t=await fixture(),fake=fakeHelper(),service=new InstallService(t.store,'critic',async()=>nativeReply('install_decision',{decision:'approve',reason:'Fixture'}),async()=>fake.helper);
    service.update({policy:'auto',revision:service.settings().revision});
    const execute=fake.helper.execute.getMockImplementation()!;fake.helper.execute.mockImplementationOnce(async decision=>{await execute(decision);throw new Error('Lost install reply');});
    const item=service.create(randomUUID(),t.chat.id,'exact-install-frame','architect',0,{packages:[{name:'hello'}],reason:'Fixture dependency'});
    await service.advance(item.id,()=>true,new AbortController().signal);expect(t.read().entries.find(e=>e.installId===item.id)?.status).toBe('uncertain');
    const uncertain=t.store.install(item.id);t.store.saveInstall({...uncertain,state:'succeeded',recoveryRequired:false});expect(t.read().entries.find(e=>e.installId===item.id)?.status).toBe('uncertain');
    t.store.saveInstall({...uncertain,state:'pending',recoveryRequired:false});expect(t.read().entries.find(e=>e.installId===item.id)?.status).toBe('uncertain');
    t.store.saveInstall(uncertain);fake.helper.reconcile.mockImplementationOnce(async id=>structuredClone(fake.records.get(id)!));await service.recover(item.id,true);expect(t.read().entries.find(e=>e.installId===item.id)?.status).toBe('completed');
    const receipt=t.store.getState<Record<string,unknown>>(`install-reconciliation:${item.id}`,{});
    for(const patch of [{previewDigest:'wrong'},{targetKey:'wrong'},{eventId:999999},{chatId:'foreign-chat'},{healthy:false}]){t.store.setState(`install-reconciliation:${item.id}`,{...receipt,...patch});expect(t.read().entries.find(e=>e.installId===item.id)?.status).toBe('uncertain');}
    t.store.setState(`install-reconciliation:${item.id}`,receipt);expect(t.read().entries.find(e=>e.installId===item.id)?.status).toBe('completed');expect(fake.helper.execute).toHaveBeenCalledTimes(1);expect(fake.helper.reconcile).toHaveBeenCalledTimes(1);await service.close();
  });
  it('bounds long histories and record bytes before parsing, and tolerates malformed/foreign records',async()=>{
    const t=await fixture();
    for(let i=0;i<515;i++)t.store.event(t.chat.id,'tool',{agentId:`f${i}`,commandId:`c${i}`,action:{name:'read_file',args:{path:'private'}},result:{ok:true}});
    t.store.event(t.chat.id,'command',{agentId:'large',commandId:'large',private:'PRIVATE_SENTINEL'.repeat(20000),status:'completed',exitCode:0});
    t.store.setState(`run:${t.chat.id}`,{private:'PRIVATE_SENTINEL'.repeat(200000)});
    t.store.db.prepare('INSERT INTO state VALUES (?,?)').run('process-job:malformed','{PRIVATE_MALFORMED_SENTINEL');
    t.store.setState('process-job:foreign',{id:'foreign',chatId:t.chat.id,projectId:'foreign-project',frameId:'foreign-frame',status:'completed',private:'PRIVATE_FOREIGN_SENTINEL'});
    const view=t.read();expect(view.entries.length).toBeLessThanOrEqual(RECOVERY_LIMITS.entries);expect(view.coverage.find(c=>c.source==='events')?.truncated).toBe(true);expect(view.coverage.find(c=>c.source==='entries')?.truncated).toBe(true);
    expect(view.coverage.find(c=>c.source==='run')?.unavailable).toBe(1);expect(view.coverage.find(c=>c.source==='processes')?.unavailable).toBe(2);expect(JSON.stringify(view)).not.toContain('PRIVATE_');
  });
  it('includes every projected version/coverage change in observational revision',async()=>{
    const t=await fixture();const first=t.read();expect(t.read().revision).toBe(first.revision);
    t.store.updateChat(t.chat.id,{mode:'plan',modeVersion:4});expect(t.read().revision).not.toBe(first.revision);
    const second=t.read();t.store.setState(`run:${t.chat.id}`,{private:'x'.repeat(RECOVERY_LIMITS.runBytes+1)});expect(t.read().latestEventId).toBe(second.latestEventId);expect(t.read().revision).not.toBe(second.revision);
  });
  it('uses existing authentication/Host/Origin and rejects unknown inputs without raw parse leaks',async()=>{
    const t=await fixture(),auth=new TransportAuth('recovery-test');
    const {app}=await createApp({config:t.config,store:t.store,tools:t.tools,provider:{models:async()=>[],complete:async()=>{throw new Error('No provider');}},hooks:{instructions:()=>''},transportAuth:auth});
    try{
      const url=`/api/chats/${t.chat.id}/recovery`,headers={authorization:`Bearer ${auth.token}`};
      expect((await app.inject(url)).statusCode).toBe(401);expect((await app.inject({url,headers:{...headers,host:'attacker.example'}})).statusCode).toBe(403);expect((await app.inject({url,headers:{...headers,origin:'https://attacker.example'}})).statusCode).toBe(403);
      const before=logical(t.store),one=await app.inject({url,headers}),two=await app.inject({url,headers});expect(one.statusCode).toBe(200);expect(two.json().revision).toBe(one.json().revision);expect(logical(t.store)).toBe(before);expect(one.headers['cache-control']).toBe('no-store');
      expect((await app.inject({url:url+'?reconcile=true',headers})).statusCode).toBe(400);expect((await app.inject({url:'/api/chats/missing/recovery',headers})).statusCode).toBe(404);
      t.store.db.prepare('UPDATE chats SET data=? WHERE id=?').run('{PRIVATE_BAD_CHAT_SENTINEL',t.chat.id);
      const invalid=await app.inject({url,headers});expect(invalid.statusCode).toBe(404);expect(invalid.body).not.toContain('PRIVATE_BAD_CHAT_SENTINEL');
      // Restore before normal app shutdown, which intentionally uses ordinary loaders.
      t.store.db.prepare('UPDATE chats SET data=? WHERE id=?').run(JSON.stringify({...t.chat,mode:'execute',modeVersion:0}),t.chat.id);
    }finally{await app.close();}
  });
});
