import type {WorkerClient as NativeWorkerClient} from '../server/worker-client.js';
import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {AsyncResource} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import type {NativeBindPolicy} from '../server/native-bind-policy.js';
const socketState=vi.hoisted(()=>({last:undefined as any,count:0}));
vi.mock('node:net',()=>({connect:()=>{socketState.count++;const socket=new EventEmitter() as any;socket.write=vi.fn();socket.destroy=vi.fn();socket.release=new AsyncResource('native-dispatch-fixture');socketState.last=socket;return socket;}}));
afterEach(()=>{vi.restoreAllMocks();vi.resetModules();socketState.last=undefined;socketState.count=0;});
async function fixture(){
 let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
 const authority=await import('../server/native-storage.js'),{WorkerClient}=await import('../server/worker-client.js');
 const record={storageId:randomUUID(),launchId:randomUUID()},policy={record,roots:{workspace:'/workspace'},verifyRoots:vi.fn(),permits:vi.fn(()=>true)} as unknown as NativeBindPolicy;
 const check=vi.fn(async()=>({...record,gateId:'b'.repeat(64),issuedAt:now,expiresAt:now+10000}));authority.installNativeStorage(policy,check);
 const client=new (WorkerClient as unknown as new(record:unknown)=>NativeWorkerClient)({protocol:'abyssus-worker-v1',sessionId:randomUUID(),...record,key:'c'.repeat(64),phase:'controller',transport:'tcp',host:'127.0.0.1',port:32123});
 return {authority,client,check,policy,advance:()=>{now+=10001;}};
}
it('refuses unscoped native dispatch before opening a socket',async()=>{const t=await fixture();expect(()=>t.client.request('activate',{})).toThrow(/freshness/);expect(socketState.count).toBe(0);expect(t.check).not.toHaveBeenCalled();});
it('socket-connect delay cannot renew an expired command scope or send its bytes',async()=>{
 const t=await fixture();let pending!:Promise<unknown>;
 await t.authority.runNativeOperation(()=>{pending=t.client.request('activate',{});return undefined;});
 const refused=expect(pending).rejects.toThrow(/freshness/);t.advance();socketState.last.release.runInAsyncScope(()=>socketState.last.emit('connect'));await refused;
 expect(socketState.last.write).not.toHaveBeenCalled();expect(socketState.last.destroy).toHaveBeenCalled();expect(t.check).toHaveBeenCalledTimes(1);
 await expect(t.authority.runNativeOperation(()=>t.client.request('activate',{}))).rejects.toThrow(/recovery/);expect(socketState.count).toBe(1);
});
it('final root loss vetoes prepared dispatch while exact cleanup remains sendable',async()=>{
 const t=await fixture();let pending!:Promise<unknown>;
 await t.authority.runNativeOperation(()=>{pending=t.client.request('install_execute',{});return undefined;});const first=socketState.last,refused=expect(pending).rejects.toThrow(/freshness/);
 vi.mocked(t.policy.verifyRoots).mockImplementation(()=>{throw new Error('root replaced');});first.release.runInAsyncScope(()=>first.emit('connect'));await refused;expect(first.write).not.toHaveBeenCalled();
 const cleanup=t.client.request('cancel',{claimId:randomUUID(),binding:'d'.repeat(64)}),socket=socketState.last;socket.release.runInAsyncScope(()=>socket.emit('connect'));expect(socket.write).toHaveBeenCalledTimes(1);
 const uncertain=expect(cleanup).rejects.toThrow(/UNCERTAIN/);socket.emit('close');await uncertain;expect(t.check).toHaveBeenCalledTimes(1);
});
it.each(['prepare','activate','install_hello','install_prepare','install_authorize','install_execute','install_reconcile','transfer_begin','transfer_receipt','reset','preview_open'])('%s requires a live scope, never a background observation',async op=>{
 const t=await fixture();expect(()=>t.client.request(op,{})).toThrow(/freshness/);expect(socketState.count).toBe(0);expect(t.check).not.toHaveBeenCalled();
});

it('aborted preview wire never sends a late connect and cannot renew or bypass poisoned read/close state',async()=>{
 const t=await fixture(),abort=new AbortController();let pending!:Promise<unknown>;
 await t.authority.runNativeOperation(()=>{pending=t.client.request('preview_open',{},abort.signal);return undefined;});const socket=socketState.last,refused=expect(pending).rejects.toThrow(/UNCERTAIN/);abort.abort();await refused;socket.release.runInAsyncScope(()=>socket.emit('connect'));expect(socket.write).not.toHaveBeenCalled();
 await expect(t.authority.runNativeOperation(()=>{t.advance();t.authority.assertNativePath('/workspace',false);})).rejects.toThrow(/freshness/);
 for(const op of ['preview_read','preview_close'])expect(()=>t.client.request(op,{})).toThrow(/recovery/);expect(socketState.count).toBe(1);expect(t.check).toHaveBeenCalledTimes(2);
});
