import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { startBackend } from '../server/bootstrap.js';
import { BackendLifecycle, signBackendRequest, verifyBackendProof } from '../server/lifecycle.js';
import { StateOwnership } from '../server/local-state.js';
import { childEnvironment } from '../server/tools/command-utils.js';
import { Store } from '../server/store.js';

const cleanups:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanups.splice(0).reverse())await fn();});
async function unusedPort() {const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
async function fixture() {
  const root=mkdtempSync(path.join(tmpdir(),'rh-lifecycle-'));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'install'),other=path.join(root,'other'),home=path.join(cwd,'.harness');mkdirSync(cwd);mkdirSync(other);
  const options={installRoot:cwd,web:false,env:{LOCALAPPDATA:root,XDG_DATA_HOME:root,PORT:String(await unusedPort())}};
  return {root,cwd,other,home,options};
}
async function start(options:Parameters<typeof startBackend>[0]) {const backend=await startBackend(options);cleanups.push(()=>backend.close());return backend;}
const headers={host:'127.0.0.1','content-type':'application/json'};

it('rejects encoded route aliases before auth, Host/Origin or JSON policies can be bypassed',async()=>{
  const t=await fixture(),backend=await start(t.options);
  const store=new Store(path.join(backend.config.dataDir,'state.sqlite'));
  const project=store.createProject('Auth fixture',t.other),chat=store.createChat(project.id,'Events','review');store.close();
  for(const prefix of ['/%61pi','/a%70i','/ap%69','/%61%70%69']) {
    expect((await backend.app.inject({url:prefix+'/projects',headers})).statusCode).toBe(400);
    expect((await backend.app.inject({method:'POST',url:prefix+'/projects',headers:{host:'evil.example',origin:'https://evil.example','content-type':'text/plain'},payload:'bad'})).statusCode).toBe(400);
    expect((await backend.app.inject({method:'POST',url:prefix+'/auth/pair',headers,payload:{code:backend.auth.pairingCode}})).statusCode).toBe(400);
    expect((await fetch(backend.address+prefix+`/chats/${chat.id}/events`)).status).toBe(400);
  }
  expect((await fetch(backend.address+`/api/chats/${chat.id}/events`)).status).toBe(401);
  expect((await backend.app.inject({method:'POST',url:'/api/projects',headers:{host:'evil.example','content-type':'application/json'},payload:{}})).statusCode).toBe(403);
  expect((await backend.app.inject({method:'POST',url:'/api/projects',headers:{...headers,origin:'https://evil.example'},payload:{}})).statusCode).toBe(403);
  expect((await backend.app.inject({method:'POST',url:'/api/projects',headers:{host:'127.0.0.1','content-type':'text/plain'},payload:'bad'})).statusCode).toBe(415);
});

it('authenticates readiness without sending the key, rejects replay, expiry, wrong instance/action and origin',async()=>{
  const t=await fixture(),backend=await start(t.options),id=backend.lifecycle.instanceId,key=backend.lifecycle.key;
  const request=signBackendRequest(key,'readiness',id);
  expect(verifyBackendProof(key,'readiness',request,null)).toBe(false);
  const response=await backend.app.inject({method:'POST',url:'/api/backend/readiness',headers,payload:request});
  expect(response.statusCode).toBe(200);expect(verifyBackendProof(key,'readiness',request,response.json())).toBe(true);
  expect(verifyBackendProof(key,'shutdown',request,response.json())).toBe(false);
  expect(response.body).not.toContain(key);expect(response.body).not.toContain('synthetic-only');
  const proof=response.json();proof.identity.pid+=1;expect(verifyBackendProof(key,'readiness',request,proof)).toBe(false);
  for(const [url,payload] of [
    ['/api/backend/readiness',request],
    ['/api/backend/shutdown',signBackendRequest(key,'readiness',id)],
    ['/api/backend/readiness',signBackendRequest('0'.repeat(64),'readiness',id)],
    ['/api/backend/readiness',signBackendRequest(key,'readiness','11111111-1111-4111-8111-111111111111')],
    ['/api/backend/readiness',signBackendRequest(key,'readiness',id,Date.now()-60000)],
    ['/api/backend/readiness',signBackendRequest(key,'readiness',id,Date.now()+60000)],
  ] as const)expect((await backend.app.inject({method:'POST',url,headers,payload})).statusCode).toBe(403);
  expect((await backend.app.inject({method:'POST',url:'/api/backend/readiness',headers:{...headers,origin:'https://evil.example'},payload:signBackendRequest(key,'readiness',id)})).statusCode).toBe(403);
  expect(childEnvironment({HARNESS_LAUNCH_KEY:key,STARK_API_KEY:'synthetic-only'})).not.toHaveProperty('HARNESS_LAUNCH_KEY');
});
it('uses one checkout database and settings file and refuses to replace an established missing database',async()=>{
  const t=await fixture(),first=await start(t.options);
  expect(first.config.dataDir).toBe(t.home);
  const store=new Store(path.join(t.home,'state.sqlite'));
  const project=store.createProject('Keep',t.other),chat=store.createChat(project.id,'Keep','review');store.close();
  const response=await first.app.inject({method:'PATCH',url:'/api/provider-settings',headers:{...headers,authorization:'Bearer '+first.auth.token},payload:{apiKey:'new-synthetic',models:{architect:'new-default'}}});
  expect(response.statusCode).toBe(200);expect(response.body).not.toContain('new-synthetic');
  expect(readFileSync(path.join(t.cwd,'.env'),'utf8')).toContain('new-synthetic');
  expect(existsSync(path.join(t.home,'profile'))).toBe(false);
  await first.close();

  const next=await start(t.options);
  expect(next.config.apiKey).toBe('new-synthetic');
  expect((await next.app.inject({url:`/api/chats/${chat.id}`,headers:{...headers,authorization:`Bearer ${next.auth.token}`}})).statusCode).toBe(200);
  await next.close();
  renameSync(path.join(t.home,'state.sqlite'),path.join(t.home,'retained.sqlite'));
  await expect(startBackend(t.options)).rejects.toThrow('missing');
});

it('copies the old selected database and personal skills without using the old config',async()=>{
  const t=await fixture(),legacy=path.join(t.root,'legacy'),profile=path.join(legacy,'profile');
  const data=path.join(t.root,'custom-data');
  mkdirSync(path.join(profile,'config'),{recursive:true,mode:0o700});
  mkdirSync(path.join(legacy,'skills','sample'),{recursive:true,mode:0o700});
  writeFileSync(path.join(profile,'config','.env'),'ARCHITECT_MODEL=ignored-old');
  writeFileSync(path.join(legacy,'skills','sample','SKILL.md'),'saved skill');
  mkdirSync(data,{mode:0o700});
  const source=path.join(data,'state.sqlite'),old=new Store(source);
  const project=old.createProject('Imported',t.other),chat=old.createChat(project.id,'Original','review');old.close();
  writeFileSync(path.join(profile,'data-location.json'),JSON.stringify({directory:data}));
  writeFileSync(path.join(data,'artifact.txt'),'retained evidence');
  writeFileSync(path.join(data,'config.env'),'ARCHITECT_MODEL=ignored-copy');
  writeFileSync(path.join(t.cwd,'.env'),'ARCHITECT_MODEL=checkout');
  const options={...t.options,env:{...t.options.env,HARNESS_HOME:legacy}};
  const owner=new StateOwnership(legacy);
  try { await expect(startBackend(options)).rejects.toThrow('owned'); }
  finally { owner.close(); }
  expect(existsSync(t.home)).toBe(false);
  const original=readFileSync(source);
  const first=await start(options);
  expect(first.config.dataDir).toBe(t.home);
  expect(first.config.models.architect).toBe('checkout');
  expect(readFileSync(path.join(t.home,'skills','sample','SKILL.md'),'utf8')).toBe('saved skill');
  expect(readFileSync(path.join(t.home,'artifact.txt'),'utf8')).toBe('retained evidence');
  expect(existsSync(path.join(t.home,'profile'))).toBe(false);
  expect(existsSync(path.join(t.home,'config.env'))).toBe(false);
  expect(readFileSync(source)).toEqual(original);
  expect((await first.app.inject({url:`/api/chats/${chat.id}`,headers:{...headers,authorization:`Bearer ${first.auth.token}`}})).statusCode).toBe(200);
  await first.close();
  const next=await start(t.options);
  expect(next.config.dataDir).toBe(t.home);
});
it('fails occupied-port startup and releases ownership without touching the unrelated listener',async()=>{
  const t=await fixture(),server=createServer();server.listen(Number(t.options.env.PORT),'127.0.0.1');await once(server,'listening');
  cleanups.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  await expect(startBackend(t.options)).rejects.toThrow('EADDRINUSE');expect(server.listening).toBe(true);
  const lock=new StateOwnership(t.home);lock.close();
});
it('rejects two backends using the same checkout in actual backend processes',async()=>{
  const t=await fixture(),first=await start(t.options);
  const options={...t.options,env:{...t.options.env,PORT:String(await unusedPort())}};
  const child=fork(fileURLToPath(new URL('./state-worker.ts',import.meta.url)),['backend',JSON.stringify(options)],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});
  cleanups.push(async()=>{if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}});
  const [message]=await once(child,'message');expect(message.error).toContain('owned');
  await first.close();const next=await start(options);expect(next.config.dataDir).toBe(first.config.dataDir);
});
it('authenticated shutdown closes the listener and overwrites its descriptor without the secret',async()=>{
  const t=await fixture(),backend=await start(t.options);
  const request=signBackendRequest(backend.lifecycle.key,'shutdown',backend.lifecycle.instanceId);
  const response=await fetch(`${backend.address}/api/backend/shutdown`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
  expect(response.status).toBe(200);expect(verifyBackendProof(backend.lifecycle.key,'shutdown',request,await response.json())).toBe(true);
  await backend.close();expect(backend.app.server.listening).toBe(false);
  const descriptor=readFileSync(path.join(t.home,'backend.json'),'utf8');expect(descriptor).not.toContain(backend.lifecycle.key);expect(JSON.parse(descriptor).state).toBe('stopped');
});
it('shutdown is idempotent, rejects new work while draining, and exposes failed drain state',async()=>{
  const lifecycle=new BackendLifecycle(),app=Fastify();let finish!:()=>void;
  const close=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  lifecycle.register(app,close);app.get('/api/work',()=>({ok:true}));lifecycle.ready();
  const first=lifecycle.stop(close),second=lifecycle.stop(close);expect(first).toBe(second);
  expect((await app.inject('/api/work')).statusCode).toBe(503);expect(close).toHaveBeenCalledTimes(1);
  finish();await first;expect(lifecycle.identity().state).toBe('stopped');await app.close();
  const failed=new BackendLifecycle();await expect(failed.stop(async()=>{throw new Error('drain failure');})).rejects.toThrow('drain failure');
  expect(failed.identity().state).toBe('failed');
});
it('retains actual ownership during a hanging or failed close',async()=>{
  const t=await fixture(),backend=await start(t.options);
  const original=backend.app.close.bind(backend.app);let release!:()=>void;
  vi.spyOn(backend.app,'close').mockImplementation((()=>new Promise<void>(resolve=>{release=resolve;})) as typeof backend.app.close);
  const closing=backend.close();await Promise.resolve();expect(()=>new StateOwnership(t.home)).toThrow('owned');
  await original();release();await closing;
  const lock=new StateOwnership(t.home);lock.close();
});
