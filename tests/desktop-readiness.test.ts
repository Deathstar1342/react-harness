import { afterEach,expect,it,vi } from 'vitest';
import { createHmac,randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { waitForReadiness } from '../desktop/readiness.js';
import { DesktopController } from '../desktop/controller.js';
import type { BackendIdentity,BackendProofRequest } from '../shared/types.js';
vi.mock('node:child_process',async importOriginal=>({...await importOriginal<typeof import('node:child_process')>(),spawn:vi.fn()}));
const key='a'.repeat(64),address='http://127.0.0.1:47123';
const identity:BackendIdentity={protocol:'abyssus-backend-v1',instanceId:randomUUID(),profileId:randomUUID(),pid:123,platform:'linux',state:'ready'};
const transport=()=>new TypeError('fetch failed',{cause:Object.assign(new Error('private details'),{code:'ECONNREFUSED'})});
const proof=(init?:RequestInit,changed:Partial<BackendIdentity>={},proofKey=key)=>{
  const request=JSON.parse(String(init?.body)) as BackendProofRequest,id={...identity,...changed};
  const mac=createHmac('sha256',proofKey).update(JSON.stringify([id.protocol,'proof','readiness',request.nonce,request.expiresAt,id])).digest('hex');
  return Response.json({action:'readiness',identity:id,nonce:request.nonce,mac});
};
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
it('recovers from real loopback connection refusal when the same listener becomes available',async()=>{
  const server=createServer((req,res)=>{let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{void proof({body}).text().then(text=>{res.setHeader('content-type','application/json');res.end(text);});});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  const realFetch=globalThis.fetch,fetcher=vi.fn<typeof fetch>(realFetch);vi.stubGlobal('fetch',fetcher);
  const result=waitForReadiness(`http://127.0.0.1:${port}`,key,identity,new AbortController().signal);
  const timer=setTimeout(()=>server.listen(port,'127.0.0.1'),100);
  try{await result;expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);}
  finally{clearTimeout(timer);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it('retries connection refusal at the exact destination with fresh challenges, then verifies the response',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockRejectedValueOnce(transport()).mockImplementation(async(_url,init)=>proof(init));vi.stubGlobal('fetch',fetcher);
  await waitForReadiness(address,key,identity,new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.map(([url])=>url)).toEqual([address+'/api/backend/readiness',address+'/api/backend/readiness']);
  const requests=fetcher.mock.calls.map(([,init])=>JSON.parse(String(init?.body)));
  expect(requests[0].nonce).not.toBe(requests[1].nonce);
  for(const [,init] of fetcher.mock.calls){expect(init?.redirect).toBe('error');expect(init?.method).toBe('POST');}
});
it('caps transport retries with one overall deadline',async()=>{
  vi.useFakeTimers();const fetcher=vi.fn<typeof fetch>().mockRejectedValue(transport());vi.stubGlobal('fetch',fetcher);
  const result=expect(waitForReadiness(address,key,identity,new AbortController().signal)).rejects.toThrow('connectivity timed out');
  await vi.advanceTimersByTimeAsync(10000);await result;expect(fetcher).toHaveBeenCalledTimes(1);
});
it('aborts an in-flight connection at the overall deadline',async()=>{
  vi.useFakeTimers();const fetcher=vi.fn<typeof fetch>().mockImplementation((_url,init)=>new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true})));vi.stubGlobal('fetch',fetcher);
  const result=expect(waitForReadiness(address,key,identity,new AbortController().signal)).rejects.toThrow('connectivity timed out');
  await vi.advanceTimersByTimeAsync(10000);await result;expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  ['HTTP error',async()=>new Response('',{status:503})],
  ['malformed JSON',async()=>new Response('{')],
  ['invalid signature',async(init?:RequestInit)=>proof(init,{},'b'.repeat(64))],
  ['wrong profile',async(init?:RequestInit)=>proof(init,{profileId:randomUUID()})],
  ['wrong instance',async(init?:RequestInit)=>proof(init,{instanceId:randomUUID()})],
  ['wrong process',async(init?:RequestInit)=>proof(init,{pid:124})],
  ['wrong platform',async(init?:RequestInit)=>proof(init,{platform:'win32'})],
  ['not ready',async(init?:RequestInit)=>proof(init,{state:'starting'})],
  ['redirect failure',async()=>{throw new TypeError('fetch failed',{cause:new Error('unexpected redirect')});}],
] as const)('never retries %s',async(_name,respond)=>{
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>respond(init));vi.stubGlobal('fetch',fetcher);
  await expect(waitForReadiness(address,key,identity,new AbortController().signal)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['exit','cleanup failure'] as const)('stops controller readiness immediately on owned child %s and retains cleanup ownership',async event=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stdin:new PassThrough(),stderr:new PassThrough(),pid:123,exitCode:null as number|null,signalCode:null,kill:vi.fn()});
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  child.stdin.once('data',()=>child.stdout.write(JSON.stringify({address,identity,checks:[]})+'\n'));
  const controller=new DesktopController('/unused');
  (controller as unknown as {command:()=>unknown}).command=()=>({file:'unused',args:[],cwd:'.'});
  let entered!:()=>void;const fetching=new Promise<void>(resolve=>{entered=resolve;});
  const fetcher=vi.fn<typeof fetch>().mockImplementation((_url,init)=>{entered();return new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true}));});vi.stubGlobal('fetch',fetcher);
  const result=expect(controller.start({environment:{kind:'linux'},home:'/unused-profile',mode:'existing'})).rejects.toThrow('Owned backend exited or failed');
  await fetching;
  if(event==='exit'){child.exitCode=1;child.emit('exit',1);}
  else child.stdout.write(JSON.stringify({type:'cleanup-failed',instanceId:identity.instanceId})+'\n');
  await result;expect(fetcher).toHaveBeenCalledTimes(1);expect(child.kill).not.toHaveBeenCalled();expect(controller.state.phase).toBe('failed');expect(controller.target()).toBeUndefined();
  expect((controller as unknown as {child:unknown}).child).toBe(child);expect(child.listenerCount('exit')).toBe(0);
  expect((controller as unknown as {failureWaiters:Set<unknown>}).failureWaiters.size).toBe(0);child.emit('close',1);
});
