import {afterEach,expect,it,vi} from 'vitest';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,lstatSync} from 'node:fs';
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
 const authority=await import('../server/native-storage.js');const policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},verifyRoots:()=>{},permits:(file:string)=>file===root||file.startsWith(root+path.sep)} as unknown as NativeBindPolicy;
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
 const authority=await import('../server/native-storage.js');const policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},verifyRoots:()=>{},permits:()=>true} as unknown as NativeBindPolicy;
 authority.installNativeStorage(policy,async()=>({...policy.record,gateId:'c'.repeat(64),issuedAt:clock,expiresAt:clock+1000}),t.descriptor);
 const {Store}=await import('../server/store.js');const store=new Store(filename),before=Atomics.load(t.words,0);
 try{await authority.runNativeOperation(()=>{clock+=1001;expect(()=>authority.assertNativePath('/abyssus')).toThrow(/freshness/);});expect(()=>store.setState('forbidden',true)).toThrow(/recovery/);expect(Atomics.load(t.words,0)).toBe(before);}finally{store.close();date.mockRestore();}
});

it('streaming private-state callbacks after eleven seconds use new bounded units without workspace authority',async()=>{
 const t=await peer(),root=mkdtempSync(path.join(tmpdir(),'native-long-')),filename=path.join(root,'state.sqlite');
 const authority=await import('../server/native-storage.js');const policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},verifyRoots:()=>{},permits:()=>true} as unknown as NativeBindPolicy;
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
 const authority=await import('../server/native-storage.js'),policy={record:{storageId:t.descriptor.storageId,launchId:t.descriptor.launchId},roots:{workspace},verifyRoots:()=>{},permits:()=>true} as unknown as NativeBindPolicy;
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
