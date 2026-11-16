import {afterEach,expect,it,vi} from 'vitest';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {NativeStateCheck,type NativeObservation} from '../server/native-state-check.js';
import type {NativeBindPolicy} from '../server/native-bind-policy.js';
const peers:Worker[]=[];const observers:NativeStateCheck[]=[];
afterEach(async()=>{for(const check of observers.splice(0))check.close();await Promise.all(peers.splice(0).map(peer=>peer.terminate()));vi.resetModules();});
async function peer(){
 const control=new SharedArrayBuffer(16),words=new Int32Array(control),descriptor:NativeObservation={protocol:'abyssus-worker-v1',sessionId:randomUUID(),storageId:randomUUID(),launchId:randomUUID(),key:'a'.repeat(64),phase:'controller',transport:'tcp',host:'127.0.0.1',port:0};
 const worker=new Worker(new URL('./native-observation-fixture.mjs',import.meta.url),{workerData:{descriptor,control}});peers.push(worker);const [ready]=await once(worker,'message');descriptor.port=ready.port;return {descriptor,words,worker};
}
it('actual worker performs bounded authenticated observations and wrong launch permanently poisons',async()=>{
 const t=await peer(),poison=vi.fn(),check=new NativeStateCheck(t.descriptor,poison);observers.push(check);check.check();check.check();expect(check.checks).toBe(2);expect(Atomics.load(t.words,0)).toBe(2);expect(check.elapsedMs).toBeLessThan(2000);
 Atomics.store(t.words,1,3);expect(()=>check.check()).toThrow(/recovery/);expect(()=>check.check()).toThrow(/recovery/);expect(Atomics.load(t.words,0)).toBe(3);expect(poison).toHaveBeenCalled();
});
it('timeout/late reply and worker exit never acknowledge a following operation',async()=>{
 const t=await peer(),check=new NativeStateCheck(t.descriptor,()=>{});observers.push(check);Atomics.store(t.words,2,3500);expect(()=>check.check()).toThrow(/recovery/);await new Promise(resolve=>setTimeout(resolve,1100));expect(()=>check.check()).toThrow(/recovery/);expect(Atomics.load(t.words,0)).toBe(1);
 const other=new NativeStateCheck(t.descriptor,()=>{});observers.push(other);await (other as unknown as {worker:Worker}).worker.terminate();expect(()=>other.check()).toThrow(/recovery/);
},10000);
it('Store units share one entry check and final COMMIT veto rolls back without events',async()=>{
 const t=await peer(),root=mkdtempSync(path.join(tmpdir(),'native-state-')),filename=path.join(root,'state.sqlite');
 const authority=await import('../server/native-storage.js');const policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},roots:{state:root,config:path.join(root,'config'),control:path.join(root,'control'),workspace:path.join(root,'workspace')},verifyRoots:()=>{},permits:(file:string)=>file===root||file.startsWith(root+path.sep)} as unknown as NativeBindPolicy;
 authority.installNativeStorage(policy,async()=>{throw new Error('workspace authority intentionally unavailable');},t.descriptor);
 const {Store}=await import('../server/store.js');const store=new Store(filename);const project=store.createProject('Fixture',root),chat=store.createChat(project.id,'Fixture','balanced');let events=0;store.changes.on('event',()=>events++);
 try{
  let before=Atomics.load(t.words,0);store.transaction(()=>{for(let i=0;i<20;i++)store.setState('value'+i,i);expect(store.getState('value5',null)).toBe(5);});expect(Atomics.load(t.words,0)-before).toBe(2);
  before=Atomics.load(t.words,0);Atomics.store(t.words,1,before+2);
  expect(()=>store.transaction(()=>{store.setState('must-rollback',true);store.event(chat.id,'delta',{text:'never published'});})).toThrow(/recovery/);expect(events).toBe(0);
  const inspect=new DatabaseSync(filename,{readOnly:true});try{expect(inspect.prepare('SELECT data FROM state WHERE key=?').get('must-rollback')).toBeUndefined();}finally{inspect.close();}
  expect(()=>store.getState('value5',null)).toThrow(/recovery/);
 }finally{store.close();}
});

it('async gate expiry poisons the private-state worker without a renewed database observation',async()=>{
 const t=await peer(),root=mkdtempSync(path.join(tmpdir(),'native-poison-')),filename=path.join(root,'state.sqlite');let clock=Date.now();const date=vi.spyOn(Date,'now').mockImplementation(()=>clock);
 const authority=await import('../server/native-storage.js');const policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},roots:{state:root,config:path.join(root,'config'),control:path.join(root,'control'),workspace:path.join(root,'workspace')},verifyRoots:()=>{},permits:()=>true} as unknown as NativeBindPolicy;
 authority.installNativeStorage(policy,async()=>({...policy.record,gateId:'c'.repeat(64),issuedAt:clock,expiresAt:clock+1000}),t.descriptor);
 const {Store}=await import('../server/store.js');const store=new Store(filename),before=Atomics.load(t.words,0);
 try{await authority.runNativeOperation(()=>{clock+=1001;expect(()=>authority.assertNativePath('/abyssus')).toThrow(/freshness/);});expect(()=>store.setState('forbidden',true)).toThrow(/recovery/);expect(Atomics.load(t.words,0)).toBe(before);}finally{store.close();date.mockRestore();}
});

it('streaming private-state callbacks after eleven seconds use new bounded units without workspace authority',async()=>{
 const t=await peer(),root=mkdtempSync(path.join(tmpdir(),'native-long-')),filename=path.join(root,'state.sqlite');
 const authority=await import('../server/native-storage.js');const policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},roots:{state:root,config:path.join(root,'config'),control:path.join(root,'control'),workspace:path.join(root,'workspace')},verifyRoots:()=>{},permits:()=>true} as unknown as NativeBindPolicy;
 authority.installNativeStorage(policy,async()=>{throw new Error('No workspace scope granted');},t.descriptor);
 const {Store}=await import('../server/store.js'),{nativeOutputBuffer}=await import('../server/native-output-buffer.js');const store=new Store(filename),project=store.createProject('Long stream',root),chat=store.createChat(project.id,'Long stream','balanced');
 try{
  let before=Atomics.load(t.words,0);const start=performance.now(),buffer=nativeOutputBuffer(text=>store.event(chat.id,'delta',{text}));for(let i=0;i<1000;i++)buffer.write('x');buffer.flush();
  expect(Atomics.load(t.words,0)-before).toBeLessThanOrEqual(2);expect(performance.now()-start).toBeLessThan(1000);
  await new Promise(resolve=>setTimeout(resolve,11000));before=Atomics.load(t.words,0);
  store.transaction(()=>{store.setState('later-callback','recorded');store.event(chat.id,'delta',{text:'later'});});expect(Atomics.load(t.words,0)-before).toBe(2);
  expect(store.getState('later-callback',null)).toBe('recorded');expect(()=>authority.assertNativePath('/workspace/project',false)).toThrow(/freshness/);
 }finally{store.close();}
},20000);


it.each([false,true])('completed import after eleven seconds starts one exact redemption phase; lost reply=%s is not replayed',async lost=>{
 const t=await peer(),root=mkdtempSync(path.join(tmpdir(),'native-copy-')),workspace=path.join(root,'workspace'),projectId=randomUUID();mkdirSync(workspace);const folder=path.join(workspace,projectId);mkdirSync(folder);
 let clock=Date.now();const date=vi.spyOn(Date,'now').mockImplementation(()=>clock),hostDirname=path.dirname.bind(path),dirname=process.platform==='win32'?vi.spyOn(path.posix,'dirname').mockImplementation(hostDirname):undefined,absolute=process.platform==='win32'?vi.spyOn(path.posix,'isAbsolute').mockReturnValue(true):undefined,normalize=process.platform==='win32'?vi.spyOn(path.posix,'normalize').mockImplementation(value=>value):undefined;
 const authority=await import('../server/native-storage.js'),policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},roots:{state:root,config:path.join(root,'config'),control:path.join(root,'control'),workspace:path.join(root,'workspace')},verifyRoots:()=>{},permits:()=>true} as unknown as NativeBindPolicy;
 const check=vi.fn(async()=>({...policy.record,gateId:'e'.repeat(64),issuedAt:clock,expiresAt:clock+10000}));authority.installNativeStorage(policy,check,t.descriptor);
 const {Store}=await import('../server/store.js'),{ProjectTransfers}=await import('../server/project-transfers.js'),store=new Store(path.join(root,'state.sqlite'));const identity=lstatSync(folder,{bigint:true}),ops:string[]=[];
 const receipt={id:randomUUID(),kind:'import',project:projectId,phase:'succeeded',code:'COMPLETE',residue:false,manifestDigest:'a'.repeat(64),files:1,bytes:4,excludedCount:0,excluded:[],history:false,storageId:t.descriptor.storageId,sessionId:t.descriptor.sessionId,identity:[identity.dev.toString(),identity.ino.toString()]};
 const client={storageId:t.descriptor.storageId,sessionId:t.descriptor.sessionId,request:async(op:string)=>{authority.assertNativeDispatch(op);ops.push(op);if(op==='transfer_begin'){clock+=11001;return receipt;}if(op==='transfer_receipt'){if(lost)throw new Error('lost redeemed reply');return receipt;}throw new Error('unexpected dispatch');}};
 const service=new ProjectTransfers(store,{} as never,{} as never,async()=>client,workspace),code='9'.repeat(64);
 try{
  const importing=authority.runNativeOperation(()=>service.import('Long copy',code,new AbortController().signal));
  if(lost){await expect(importing).rejects.toThrow('lost redeemed reply');expect(store.projects()).toHaveLength(0);}else{expect((await importing).project.path).toBe(folder);expect(store.projects()).toHaveLength(1);}
  expect(check).toHaveBeenCalledTimes(2);expect(ops).toEqual(['transfer_begin','transfer_receipt']);
  await expect(service.import('Retry',code,new AbortController().signal)).rejects.toThrow('already consumed');expect(ops).toHaveLength(2);
 }finally{store.close();date.mockRestore();absolute?.mockRestore();normalize?.mockRestore();dirname?.mockRestore();}
});

it('target grants bind exact Unicode targets and refuse root-only or changed digest replies',async()=>{
 for(const mode of [0,1,2]){
  const t=await peer(),check=new NativeStateCheck(t.descriptor,()=>{});observers.push(check);Atomics.store(t.words,3,mode);
  const targets=[{root:'state' as const,relative:'profile/café.sqlite',kind:'sqlite' as const,mode:'existing' as const}];
  if(mode===0){check.check(targets);expect(check.checks).toBe(1);}else{expect(()=>check.check(targets)).toThrow(/recovery/);expect(()=>check.check()).toThrow(/recovery/);}
 }
});
it('invalid private selectors never reach the host and an unmapped private Store poisons authority',async()=>{
 const t=await peer(),check=new NativeStateCheck(t.descriptor,()=>{});observers.push(check);
 for(const relative of ['../escape','CONIN$','COM¹.txt','a:stream','a/../b','a\\b'])expect(()=>check.check([{root:'state',relative,kind:'file',mode:'existing'}])).toThrow();
 expect(Atomics.load(t.words,0)).toBe(0);
 const authority=await import('../server/native-storage.js'),root=mkdtempSync(path.join(tmpdir(),'native-unmapped-'));
 const policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},roots:{state:root,config:root+'/config',control:root+'/control',workspace:root+'/workspace'},verifyRoots:()=>{},permits:()=>true} as unknown as NativeBindPolicy;
 authority.installNativeStorage(policy,async()=>{},t.descriptor);
 expect(()=>authority.nativePrivateUnit(()=>authority.nativePrivatePath(path.join(tmpdir(),'outside.sqlite'),true))).toThrow(/outside/);
 expect(()=>authority.nativePrivateUnit(()=>{})).toThrow(/recovery/);expect(Atomics.load(t.words,0)).toBe(0);
});
it.each(['capture','restore'])('checkpoint actual disk SQLite exact native target final COMMIT veto; phase=%s',async phase=>{
 const t=await peer(),root=mkdtempSync(path.join(realpathSync(tmpdir()),'native-checkpoint-')),state=path.join(root,'state'),workspace=path.join(root,'workspace'),projectRoot=path.join(workspace,randomUUID());mkdirSync(state);mkdirSync(projectRoot,{recursive:true});
 const dirname=process.platform==='win32'?vi.spyOn(path.posix,'dirname').mockImplementation(path.dirname.bind(path)):undefined,absolute=process.platform==='win32'?vi.spyOn(path.posix,'isAbsolute').mockImplementation(path.isAbsolute.bind(path)):undefined,normalize=process.platform==='win32'?vi.spyOn(path.posix,'normalize').mockImplementation(value=>value):undefined;
 const authority=await import('../server/native-storage.js'),policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},roots:{state,config:path.join(root,'config'),control:path.join(root,'control'),workspace},verifyRoots:()=>{},permits:()=>true} as unknown as NativeBindPolicy;
 authority.installNativeStorage(policy,async()=>({...policy.record,gateId:'a'.repeat(64),issuedAt:Date.now(),expiresAt:Date.now()+10000}),t.descriptor);
 const {Store}=await import('../server/store.js'),{Runtime}=await import('../server/runtime.js'),{WorkspaceTools}=await import('../server/tools/index.js'),{Checkpoints}=await import('../server/checkpoints.js'),{readConfig}=await import('../server/config.js'),fs=await import('node:fs/promises');
 const filename=path.join(state,'state.sqlite'),store=new Store(filename),project=store.createProject('Native checkpoints',projectRoot),chat=store.createChat(project.id,'Human boundary','review'),tools=new WorkspaceTools(),runtime=new Runtime(store,{models:async()=>[],complete:async()=>{throw new Error('No provider');}},tools,readConfig({HARNESS_DATA_DIR:state,HARNESS_WORKSPACE_ROOT:workspace}),{instructions:()=>''}),service=new Checkpoints(store,runtime);
 await new Promise(resolve=>setTimeout(resolve,30));
 const requests:{body:{targets:{root:string;relative:string;kind:string;mode:string}[]}}[]=[];t.worker.on('message',value=>{if(value.request)requests.push(value.request);});await new Promise(resolve=>setTimeout(resolve,30));requests.length=0;
 try{
  await fs.writeFile(path.join(projectRoot,'a.ts'),'before');
  let checkpoint:Awaited<ReturnType<typeof service.capture>>|undefined,preview:Awaited<ReturnType<typeof service.preview>>|undefined;
  if(phase==='restore'){checkpoint=await service.capture(project.id,{chatId:chat.id,label:'Native original'});await fs.writeFile(path.join(projectRoot,'a.ts'),'after');preview=await service.preview(project.id,checkpoint.id,{chatId:chat.id});}
  const original=store.transaction.bind(store);vi.spyOn(store,'transaction').mockImplementation(fn=>original(()=>{
   const value=fn();
   if(phase==='capture'||store.db.prepare("SELECT 1 FROM state WHERE key LIKE 'checkpoint-restore:v1:%' AND json_extract(data,'$.status')='done'").get())Atomics.store(t.words,1,Atomics.load(t.words,0)+1);
   return value;
  }));
  if(phase==='capture')await expect(service.capture(project.id,{chatId:chat.id,label:'Veto'})).rejects.toThrow(/recovery/);
  else await expect(service.restore(project.id,checkpoint!.id,{chatId:chat.id,previewToken:preview!.previewToken,revision:preview!.revision,confirmation:'restore-files'})).rejects.toThrow(/recovery/);
  expect(await fs.readFile(path.join(projectRoot,'a.ts'),'utf8')).toBe('before');
  const inspect=new DatabaseSync(filename,{readOnly:true});try{
   if(phase==='capture')expect(inspect.prepare("SELECT 1 FROM state WHERE key LIKE 'checkpoint:v1:%'").get()).toBeUndefined();
   else{const row=inspect.prepare("SELECT data FROM state WHERE key LIKE 'checkpoint-restore:v1:%'").get();expect(JSON.parse(String(row!.data)).status).toBe('claiming');expect(inspect.prepare("SELECT status FROM file_changes").get()!.status).toBe('recording');}
  }finally{inspect.close();}
  await new Promise(resolve=>setTimeout(resolve,30));expect(requests.length).toBeGreaterThan(1);for(const request of requests)expect(request.body.targets).toEqual([{root:'state',relative:'state.sqlite',kind:'sqlite',mode:'existing'}]);
  expect(()=>store.setState('checkpoint:forbidden',true)).toThrow(/recovery/);
 }finally{vi.restoreAllMocks();await runtime.close().catch(()=>{});await tools.dispose();store.close();dirname?.mockRestore();absolute?.mockRestore();normalize?.mockRestore();}
},30000);


it.each(['projection','commit'])('M35 bounded preview uses exact private observer and retains poison after %s fault',async phase=>{
 const t=await peer(),root=mkdtempSync(path.join(realpathSync(tmpdir()),'native-preview-')),state=path.join(root,'state'),workspace=path.join(root,'workspace'),projectRoot=path.join(workspace,randomUUID());mkdirSync(state);mkdirSync(projectRoot,{recursive:true});
 const dirname=process.platform==='win32'?vi.spyOn(path.posix,'dirname').mockImplementation(path.dirname.bind(path)):undefined,absolute=process.platform==='win32'?vi.spyOn(path.posix,'isAbsolute').mockImplementation(path.isAbsolute.bind(path)):undefined,normalize=process.platform==='win32'?vi.spyOn(path.posix,'normalize').mockImplementation(value=>value):undefined;
 const authority=await import('../server/native-storage.js'),policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},roots:{state,config:path.join(root,'config'),control:path.join(root,'control'),workspace},verifyRoots:()=>{},permits:()=>true} as unknown as NativeBindPolicy;
 authority.installNativeStorage(policy,async()=>({...policy.record,gateId:'c'.repeat(64),issuedAt:Date.now(),expiresAt:Date.now()+10000}),t.descriptor);
 const {Store}=await import('../server/store.js'),{previewAuthority}=await import('../server/preview-state.js'),filename=path.join(state,'state.sqlite'),store=new Store(filename),project=store.createProject('Native preview',projectRoot),chat=store.createChat(project.id,'Native bound reader','autonomous'),id=randomUUID();store.initializePlanning();
 const binding={claimId:randomUUID(),binding:'a'.repeat(64),sessionId:randomUUID(),expiresAt:Date.now()+30000,identity:{storageId:t.descriptor.storageId,projectId:'b'.repeat(64),imageId:'sha256:'+'c'.repeat(64),layout:'d'.repeat(64)}};
 const record={id,projectId:project.id,chatId:chat.id,frameId:'coder',taskId:'architect',generation:0,modeVersion:0,approvalMode:'autonomous',instructionsHash:null,rootIdentity:projectRoot,status:'running',dispatched:true,workerBinding:binding,action:{name:'start_process',args:{command:'controlled native projection fixture',previewPort:3001}}};
 store.setState('run:'+chat.id,{generation:0,planOnly:false,steering:[],instructionsHash:null,frames:[{id:'architect'},{id:'coder'}]});store.setState('process-job:'+id,record);
 try{
  expect(previewAuthority(store,project.id,id).record.id).toBe(id);
  if(phase==='projection'){Atomics.store(t.words,1,Atomics.load(t.words,0)+1);expect(()=>previewAuthority(store,project.id,id)).toThrow(/recovery/);}
  else{const missing=randomUUID();Atomics.store(t.words,1,Atomics.load(t.words,0)+2);expect(()=>store.transaction(()=>store.setState('process-job:'+missing,{...record,id:missing}))).toThrow(/recovery/);const inspect=new DatabaseSync(filename,{readOnly:true});try{expect(inspect.prepare('SELECT data FROM state WHERE key=?').get('process-job:'+missing)).toBeUndefined();}finally{inspect.close();}}
  expect(()=>previewAuthority(store,project.id,id)).toThrow(/recovery/);expect(()=>authority.assertNativeDispatch('preview_read')).toThrow(/recovery/);expect(()=>authority.assertNativeDispatch('preview_close')).toThrow(/recovery/);
 }finally{store.close();dirname?.mockRestore();absolute?.mockRestore();normalize?.mockRestore();}
});

it.each(['start','after-response'])('inspector actual native final COMMIT veto prevents continuation, phase=%s',async phase=>{
 const t=await peer(),root=mkdtempSync(path.join(tmpdir(),'native-inspector-')),filename=path.join(root,'state.sqlite');
 const authority=await import('../server/native-storage.js');const policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},roots:{state:root,config:path.join(root,'config'),control:path.join(root,'control'),workspace:path.join(root,'workspace')},verifyRoots:()=>{},permits:(file:string)=>file===root||file.startsWith(root+path.sep)} as unknown as NativeBindPolicy;
 authority.installNativeStorage(policy,async()=>{throw Error('No workspace authority');},t.descriptor);
 const {Store}=await import('../server/store.js'),{observeRequest}=await import('../server/inspector-records.js'),{inspectorView}=await import('../server/inspector.js');const store=new Store(filename),project=store.createProject('Inspector',root),chat=store.createChat(project.id,'Inspector','review');let invocations=0;
 try{if(phase==='start')Atomics.store(t.words,1,Atomics.load(t.words,0)+2);
 await expect(observeRequest(store,{chatId:chat.id,projectId:project.id,runId:'root',taskId:'frame',generation:0,ordinal:1,role:'architect',humanMessageIds:[]},{model:'model',messages:[]},async()=>{invocations++;Atomics.store(t.words,1,Atomics.load(t.words,0)+2);return {text:'Observed response',finishReason:'stop',usage:{inputTokens:7,outputTokens:2}};})).rejects.toThrow(/recovery/);
 expect(invocations).toBe(phase==='start'?0:1);expect(()=>inspectorView(store,chat.id)).toThrow(/recovery/);
 const inspect=new DatabaseSync(filename,{readOnly:true});try{const rows=inspect.prepare('SELECT data FROM inspector_requests').all();expect(rows).toHaveLength(phase==='start'?0:1);if(rows.length)expect(JSON.parse(String(rows[0].data))).toMatchObject({outcome:'pending',stage:'invoked',endedAt:null,usage:null});}finally{inspect.close();}
 }finally{store.close();}
});
it.each(['valid', 'identity', 'commit', 'coder-valid', 'coder-identity', 'delegate-commit'] as const)('native planning and Coder preparation preserve freshness and fences, case=%s', async scenario => {
  const t = await peer();
  const fs = await import('node:fs/promises');
  const {default: Fastify} = await import('fastify');
  const {nativeReply} = await import('./native-fixture.js');
  const temp = realpathSync(tmpdir()), base = mkdtempSync(path.join(temp,'native-plan-'));
  const state = path.join(base,'state'), workspace = path.join(base,'workspace');
  const root = path.join(workspace,randomUUID()), filename = path.join(state,'state.sqlite');
  mkdirSync(state);
  mkdirSync(root,{recursive:true});
  const file = 'export function greeting() { return "hello"; }\n';
  await fs.writeFile(path.join(root,'app.ts'),file);
  const identity = lstatSync(workspace,{bigint:true});
  let clock = Date.now();
  vi.spyOn(Date,'now').mockImplementation(() => clock);
  if (process.platform === 'win32') {
    // The real controller runs on Linux. Adapt only native POSIX parsing
    // for the temporary Windows fixtures, as in the other observer tests.
    vi.spyOn(path.posix,'isAbsolute').mockImplementation(path.isAbsolute.bind(path));
    vi.spyOn(path.posix,'normalize').mockImplementation(value => value);
    vi.spyOn(path.posix,'dirname').mockImplementation(path.dirname.bind(path));
  }
  const authority = await import('../server/native-storage.js');
  const policy = {
    record:{storageId:t.descriptor.storageId, launchId:t.descriptor.launchId},
    roots:{state,workspace,config:path.join(base,'config'),control:path.join(base,'control')},
    verifyRoots: () => {
      const live = lstatSync(workspace,{bigint:true});
      if (live.ino !== identity.ino || live.dev !== identity.dev) throw new Error('Workspace bind identity changed.');
    },
    permits: (input: string, privateClass: boolean) => {
      const location = privateClass ? state : workspace;
      return input === location || input.startsWith(location + path.sep);
    },
  } as unknown as NativeBindPolicy;
  const attest = vi.fn(async () => ({...policy.record,gateId:'a'.repeat(64),issuedAt:clock,expiresAt:clock+10000}));
  authority.installNativeStorage(policy,attest,t.descriptor);

  const {Store} = await import('../server/store.js');
  const {Runtime} = await import('../server/runtime.js');
  const {WorkspaceTools} = await import('../server/tools/index.js');
  const {readConfig} = await import('../server/config.js');
  const store = new Store(filename), tools = new WorkspaceTools(), app = Fastify();
  const project = store.createProject('Native planning',root);
  const ordinary = store.createChat(project.id,'Ordinary','review'), planning = store.createChat(project.id,'Plan','review');
  const read = nativeReply('read_file_range',{path:'app.ts',startLine:1,count:1});
  const absence = nativeReply('inspect_new_plan_path',{path:'new.ts'});
  const proposal = nativeReply('set_plan',{
    phases:[{id:'p',title:'Greeting',steps:[{id:'s',title:'Update greeting',status:'pending'}]}],
    admission:[{phaseId:'p',stepId:'s',task:{objective:'Update the planned greeting.'},
      sources:[{path:'app.ts',callId:read.toolCalls![0].id,symbol:'greeting'}],
      newFiles:[{path:'new.ts',callId:absence.toolCalls![0].id}],
      checks:[{method:'inspection',target:'new.ts',expected:'Check the new file defines the requested greeting.'}],
    }],
  });
  const updates: string[] = [];
  const publish = store.setPlan.bind(store);
  let attempted = false;
  let denyCoderAuthority = false;
  let delegationId: string | undefined;
  const coderPackets: string[] = [];
  if (scenario === 'coder-identity') attest.mockImplementation(async () => ({
    ...policy.record, storageId:denyCoderAuthority ? randomUUID() : policy.record.storageId,
    gateId:'a'.repeat(64),issuedAt:clock,expiresAt:clock+10000,
  }));
  if (scenario === 'commit' || scenario === 'delegate-commit' || scenario === 'coder-identity') {
    vi.spyOn(store,'setPlan').mockImplementation((chatId, plan) => {
      publish(chatId,plan);
      const startingCoder = plan.phases[0]?.steps[0].evidence?.outcome === 'started';
      if (scenario === 'coder-identity' && startingCoder) denyCoderAuthority = true;
      if (scenario === 'commit' || scenario === 'delegate-commit' && startingCoder) {
        attempted = true;
        Atomics.store(t.words,1,Atomics.load(t.words,0)+1);
      }
    });
  }
  let providerCalls = 0;
  const runtime = new Runtime(store,{models:async()=>[],complete:async request => {
    // Expire the original request scope during every provider response.
    clock += 11001;
    updates.push(...request.messages.filter(message => message.role === 'tool').map(message => message.content));
    const coder = request.messages.find(message=>message.content.startsWith('Advisory Coder context.'));
    if (coder) coderPackets.push(coder.content);
    if (providerCalls < 6) {
      expect(request.messages.some(message => message.content.startsWith('Repository overview from the start') && message.content.includes('app.ts'))).toBe(true);
    }
    switch (++providerCalls) {
      case 1: return {text:'Ordinary response.',finishReason:'stop'};
      case 2: return read;
      case 3: return absence;
      case 4:
        if (scenario === 'identity') {
          await fs.rename(workspace,workspace+'-retained');
          await fs.mkdir(root,{recursive:true});
          await fs.writeFile(path.join(root,'app.ts'),file);
        }
        return proposal;
      case 5: return {text:'Planning response.',finishReason:'stop'};
      case 6: {
        const plan = store.plan(planning.id);
        const delegation = nativeReply('delegate',{objective:'Update greeting',acceptanceCriteria:['Inspect the result'],
          paths:['app.ts','new.ts'],planStep:{planId:plan.id,planVersion:plan.version,phaseId:'p',stepId:'s'}});
        delegationId = delegation.toolCalls![0].id;
        return delegation;
      }
      case 7: return nativeReply('submit_completion',{summary:'Fixture coder complete.'});
      case 8: return nativeReply('review_result',{verdict:'pass',findings:[]});
      default: return {text:'Build fixture finished.',finishReason:'stop'};
    }
  }},tools,readConfig({HARNESS_HOME:path.join(base,'home'),HARNESS_DATA_DIR:state,HARNESS_WORKSPACE_ROOT:workspace}),{instructions:()=>''});
  authority.registerNativeStorageScope(app);
  app.post<{Params:{id:string};Body:{text:string}}>('/test-chat/:id',async request => {
    // The initial Architect snapshot likewise starts after preHandler expiry.
    clock += 11001;
    await runtime.submit(request.params.id,request.body.text);
    return {started:true};
  });
  const dispatch = (id: string, text: string) => app.inject({method:'POST',url:'/test-chat/'+id,payload:{text}});
  try {
    expect((await dispatch(ordinary.id,'Describe this repository')).statusCode).toBe(200);
    await runtime.wait(ordinary.id);
    expect(store.chat(ordinary.id).status).toBe('idle');
    expect(store.messages(ordinary.id).at(-1)?.content).toBe('Ordinary response.');
    const before = attest.mock.calls.length;

    expect((await dispatch(planning.id,'/plan Prepare the greeting change')).statusCode).toBe(200);
    const settled = runtime.wait(planning.id);
    if (scenario !== 'identity' && scenario !== 'commit') {
      await settled;
      expect(store.chat(planning.id).status).toBe('idle');
      expect(store.plan(planning.id)).toMatchObject({version:1, phases:[{steps:[{status:'pending'}]}]});
      expect(updates.some(line => JSON.parse(line).data?.planEvidenceCallId === read.toolCalls![0].id)).toBe(true);
      expect(updates.some(line => JSON.parse(line).data?.planEvidenceCallId === absence.toolCalls![0].id)).toBe(true);
      expect(await fs.readFile(path.join(root,'app.ts'),'utf8')).toBe(file);
      await expect(fs.readFile(path.join(root,'new.ts'))).rejects.toMatchObject({code:'ENOENT'});
      expect(providerCalls).toBe(5);
      if (scenario !== 'valid') {
        const plan = store.plan(planning.id), mode = store.chat(planning.id).modeVersion!;
        expect(plan.phases[0].steps[0].task?.sources[0].hash).toMatch(/^[a-f0-9]{64}$/);
        await authority.runNativeOperation(()=>runtime.startBuilding(planning.id,{planId:plan.id!,planVersion:plan.version!,modeVersion:mode}));
        const built = runtime.wait(planning.id);
        if (scenario === 'coder-valid') {
          await built;
          expect(providerCalls).toBe(9);
          expect(coderPackets).toHaveLength(1);
          expect(coderPackets[0]).toContain('return \\"hello\\"');
          expect(coderPackets[0]).toContain('"state":"planned-new"');
          expect(store.chat(planning.id).status).toBe('idle');
        } else {
          await built.catch(()=>{});
          expect(providerCalls).toBe(6);
          expect(coderPackets).toHaveLength(0);
          expect(attempted).toBe(scenario === 'delegate-commit');
          const durable = new DatabaseSync(filename,{readOnly:true});
          try {
            const result = durable.prepare("SELECT key FROM state WHERE key LIKE ?").get('%:'+delegationId);
            expect(!!result).toBe(scenario === 'coder-identity');
          } finally {durable.close();}
          expect(()=>store.setState('coder:must-not-write',true)).toThrow(/recovery/);
        }
      }
    } else {
      await settled.catch(() => {});
      expect(providerCalls).toBe(4);
      expect(attempted).toBe(scenario === 'commit');
      const durable = new DatabaseSync(filename,{readOnly:true});
      try {
        expect(durable.prepare('SELECT data FROM state WHERE key=?').get('plan:'+planning.id)).toBeUndefined();
        const rows = durable.prepare("SELECT key FROM state WHERE key LIKE ?").all('%:'+proposal.toolCalls![0].id);
        expect(rows).toHaveLength(0);
      } finally { durable.close(); }
      expect(() => store.setState('planning:must-not-write',true)).toThrow(/recovery/);
    }
    expect(attest.mock.calls.length).toBeGreaterThan(before + 4);
  } finally {
    await runtime.close().catch(()=>{});
    await app.close();
    await tools.dispose();
    store.close();
    vi.restoreAllMocks();
    if (path.dirname(base) !== temp || !path.basename(base).startsWith('native-plan-')) throw new Error('Unsafe cleanup route');
    await fs.rm(base,{recursive:true,force:true});
  }
}, 30000);

it.each(['claim','dispatch','terminal'])('M37 queue exact native observer final COMMIT veto; phase=%s',async phase=>{
 const t=await peer(),root=mkdtempSync(path.join(realpathSync(tmpdir()),'native-queue-')),state=path.join(root,'state'),workspace=path.join(root,'workspace'),projectRoot=path.join(workspace,randomUUID());mkdirSync(state);mkdirSync(projectRoot,{recursive:true});
 const dirname=process.platform==='win32'?vi.spyOn(path.posix,'dirname').mockImplementation(path.dirname.bind(path)):undefined,absolute=process.platform==='win32'?vi.spyOn(path.posix,'isAbsolute').mockImplementation(path.isAbsolute.bind(path)):undefined,normalize=process.platform==='win32'?vi.spyOn(path.posix,'normalize').mockImplementation(value=>value):undefined;
 const authority=await import('../server/native-storage.js'),policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},roots:{state,config:path.join(root,'config'),control:path.join(root,'control'),workspace},verifyRoots:()=>{},permits:()=>true} as unknown as NativeBindPolicy;
 authority.installNativeStorage(policy,async()=>({...policy.record,gateId:'a'.repeat(64),issuedAt:Date.now(),expiresAt:Date.now()+10000}),t.descriptor);
 const {Store}=await import('../server/store.js'),{Runtime}=await import('../server/runtime.js'),{WorkspaceTools}=await import('../server/tools/index.js'),{TaskQueue}=await import('../server/task-queue.js'),{readConfig}=await import('../server/config.js');
 const filename=path.join(state,'state.sqlite'),store=new Store(filename),project=store.createProject('Native queue',projectRoot),tools=new WorkspaceTools();let calls=0;
 const runtime=new Runtime(store,{models:async()=>[],complete:async()=>{calls++;return {text:'Controlled completion',finishReason:'tool_calls',toolCalls:[{id:'original_native_completion',type:'function',function:{name:'submit_completion',arguments:'{"summary":"Controlled completion"}'}}]};}},tools,readConfig({HARNESS_HOME:path.join(root,'home'),HARNESS_DATA_DIR:state,HARNESS_WORKSPACE_ROOT:workspace}),{instructions:()=>''}),queue=new TaskQueue(runtime,()=> 'review');
 try{
  queue.edit(project.id,{action:'add',expectedRevision:0,text:'First'});queue.edit(project.id,{action:'add',expectedRevision:1,text:'Second'});const v=queue.view(project.id),original=store.transaction.bind(store);let injected=false;
  vi.spyOn(store,'transaction').mockImplementation(fn=>original(()=>{const value=fn();if(!injected){const row=store.db.prepare('SELECT data FROM task_queues WHERE project_id=?').get(project.id),q=JSON.parse(String(row!.data)),task=q.tasks[0];if(phase==='claim'&&task.claim?.stage==='claimed'||phase==='dispatch'&&task.claim?.stage==='dispatched'||phase==='terminal'&&task.status==='accepted'){injected=true;Atomics.store(t.words,1,Atomics.load(t.words,0)+1);}}return value;}));
  if(phase!=='terminal')await expect(authority.runNativeOperation(()=>queue.start(project.id,{expectedRevision:v.revision,scope:v.startScope}))).rejects.toThrow(/recovery/);
  else {const started=await authority.runNativeOperation(()=>queue.start(project.id,{expectedRevision:v.revision,scope:v.startScope}));await runtime.wait(started.entries[0].chatId!).catch(()=>{});}
  expect(injected).toBe(true);expect(calls).toBe(phase==='terminal'?1:0);
  const inspect=new DatabaseSync(filename,{readOnly:true});try{const q=JSON.parse(String(inspect.prepare('SELECT data FROM task_queues WHERE project_id=?').get(project.id)!.data));expect(q.tasks[1].claim).toBeUndefined();expect(q.tasks[0].status).not.toBe('accepted');if(phase==='claim')expect(inspect.prepare('SELECT count(*) n FROM chats').get()!.n).toBe(0);}finally{inspect.close();}
  expect(()=>queue.view(project.id)).toThrow(/recovery/);expect(()=>store.setState('queue:forbidden',true)).toThrow(/recovery/);expect(calls).toBe(phase==='terminal'?1:0);
 }finally{vi.restoreAllMocks();await runtime.close().catch(()=>{});await tools.dispose();store.close();dirname?.mockRestore();absolute?.mockRestore();normalize?.mockRestore();}
});
