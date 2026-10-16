import Fastify from 'fastify';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import type {NativeObservation} from '../server/native-state-check.js';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {NativeBindPolicy} from '../server/native-bind-policy.js';
const peers:Worker[]=[];
afterEach(async()=>{await Promise.all(peers.splice(0).map(peer=>peer.terminate()));vi.resetModules();});
async function observation(record:{storageId:string;launchId:string},control=new SharedArrayBuffer(16)){
 const descriptor:NativeObservation={protocol:'abyssus-worker-v1',sessionId:randomUUID(),...record,key:'a'.repeat(64),phase:'controller',transport:'tcp',host:'127.0.0.1',port:0};
 const peer=new Worker(new URL('./native-observation-fixture.mjs',import.meta.url),{workerData:{descriptor,control}});peers.push(peer);const [ready]=await once(peer,'message');descriptor.port=ready.port;return descriptor;
}
it('actual private writes refuse missing host scope and lost replies before creating files',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'native-hooks-')),filename=path.join(root,'private.json'),record={storageId:randomUUID(),launchId:randomUUID()};
 const policy={record,roots:{state:root,config:path.join(root,'config'),control:path.join(root,'control'),workspace:path.join(root,'workspace')},verifyRoots:vi.fn(),permits:vi.fn((file:string)=>file===root||file.startsWith(root+path.sep))} as unknown as NativeBindPolicy;
 const check=vi.fn(async()=>({...record,gateId:'a'.repeat(64),issuedAt:Date.now(),expiresAt:Date.now()+5000}));
 const authority=await import('../server/native-storage.js');authority.installNativeStorage(policy,check,await observation(record));
 // Native Linux container paths use POSIX syntax; local fixture replaces only
 // the lexical platform parser, leaving actual writes and gate checks intact.
 const hostDirname=path.dirname.bind(path),dirname=process.platform==='win32'?vi.spyOn(path.posix,'dirname').mockImplementation(hostDirname):undefined;
 const absolute=process.platform==='win32'?vi.spyOn(path.posix,'isAbsolute').mockReturnValue(true):undefined,normalize=process.platform==='win32'?vi.spyOn(path.posix,'normalize').mockImplementation(value=>value):undefined;
 try{
  const {durableWrite}=await import('../server/profile.js');
  expect(()=>durableWrite(filename,'unscoped')).toThrow(/freshness/);expect(existsSync(filename)).toBe(false);
  await authority.runNativeOperation(()=>durableWrite(filename,'authorized'));expect(readFileSync(filename,'utf8')).toBe('authorized');
  check.mockRejectedValueOnce(new Error('lost host reply'));
  await expect(authority.runNativeOperation(()=>durableWrite(filename,'replayed'))).rejects.toThrow('lost host reply');
  await expect(authority.runNativeOperation(()=>durableWrite(filename,'retry'))).rejects.toThrow(/recovery/);expect(readFileSync(filename,'utf8')).toBe('authorized');
 }finally{absolute?.mockRestore();normalize?.mockRestore();dirname?.mockRestore();}
});

it('real Fastify async routes retain scope across done and await, then refuse an expired pending write',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'native-http-')),filename=path.join(root,'private.json'),record={storageId:randomUUID(),launchId:randomUUID()};let clock=Date.now();
 const date=vi.spyOn(Date,'now').mockImplementation(()=>clock),hostDirname=path.dirname.bind(path),dirname=process.platform==='win32'?vi.spyOn(path.posix,'dirname').mockImplementation(hostDirname):undefined,absolute=process.platform==='win32'?vi.spyOn(path.posix,'isAbsolute').mockReturnValue(true):undefined,normalize=process.platform==='win32'?vi.spyOn(path.posix,'normalize').mockImplementation(value=>value):undefined;
 const authority=await import('../server/native-storage.js'),{durableWrite}=await import('../server/profile.js');
 const check=vi.fn(async()=>({...record,gateId:'b'.repeat(64),issuedAt:clock,expiresAt:clock+10000}));
 const policy={record,roots:{state:root,config:path.join(root,'config'),control:path.join(root,'control'),workspace:path.join(root,'workspace')},verifyRoots:vi.fn(),permits:vi.fn((file:string)=>file===root||file.startsWith(root+path.sep))} as unknown as NativeBindPolicy;
 authority.installNativeStorage(policy,check,await observation(record));const app=Fastify();authority.registerNativeStorageScope(app);
 app.post('/write',async()=>{await Promise.resolve();durableWrite(filename,'async success');return {saved:true};});
 app.post('/delayed',async()=>{await Promise.resolve();clock+=10001;durableWrite(filename,'stale write');return {saved:true};});
 try{
  expect((await app.inject({method:'POST',url:'/write'})).statusCode).toBe(200);expect(readFileSync(filename,'utf8')).toBe('async success');
  expect((await app.inject({method:'POST',url:'/delayed'})).statusCode).toBe(500);expect(readFileSync(filename,'utf8')).toBe('async success');
  expect((await app.inject({method:'POST',url:'/write'})).statusCode).toBe(500);expect(check).toHaveBeenCalledTimes(2);
 }finally{await app.close();date.mockRestore();absolute?.mockRestore();normalize?.mockRestore();dirname?.mockRestore();}
});

it('host refusal of the actual provider temporary file prevents publication and preserves old bytes',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'native-provider-target-')),filename=path.join(root,'.env'),record={storageId:randomUUID(),launchId:randomUUID()},control=new SharedArrayBuffer(16);writeFileSync(filename,'# preserved\n');
 const policy={record,roots:{state:root,config:path.join(root,'config'),control:path.join(root,'control'),workspace:path.join(root,'workspace')},verifyRoots:()=>{},permits:()=>true} as unknown as NativeBindPolicy;
 const authority=await import('../server/native-storage.js');authority.installNativeStorage(policy,async()=>({...record,gateId:'a'.repeat(64),issuedAt:Date.now(),expiresAt:Date.now()+10000}),await observation(record,control));
 const hostDirname=path.dirname.bind(path),dirname=process.platform==='win32'?vi.spyOn(path.posix,'dirname').mockImplementation(hostDirname):undefined,absolute=process.platform==='win32'?vi.spyOn(path.posix,'isAbsolute').mockReturnValue(true):undefined,normalize=process.platform==='win32'?vi.spyOn(path.posix,'normalize').mockImplementation(value=>value):undefined;
 try{
  const {ProviderSettingsFile}=await import('../server/provider-settings.js');
  await authority.runNativeOperation(()=>{const file=new ProviderSettingsFile(filename,{});Atomics.store(new Int32Array(control),3,3);expect(()=>file.write({apiKey:'synthetic-fixture'})).toThrow(/Cannot save/);});
  expect(readFileSync(filename,'utf8')).toBe('# preserved\n');expect(readdirSync(root)).toEqual(['.env']);
 }finally{dirname?.mockRestore();absolute?.mockRestore();normalize?.mockRestore();}
});
