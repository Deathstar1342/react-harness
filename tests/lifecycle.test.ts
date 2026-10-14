import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { startBackend } from '../server/bootstrap.js';
import { BackendLifecycle, signBackendRequest, verifyBackendProof } from '../server/lifecycle.js';
import { ProfileOwnership } from '../server/profile.js';
import { childEnvironment } from '../server/tools/shell.js';
import { Store } from '../server/store.js';

const cleanups:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanups.splice(0).reverse())await fn();});
async function unusedPort() {const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
async function fixture() {
  const root=mkdtempSync(path.join(tmpdir(),'rh-lifecycle-'));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'install'),other=path.join(root,'other'),home=path.join(root,'home');mkdirSync(cwd);mkdirSync(other);
  const options={cwd,installRoot:cwd,env:{HARNESS_HOME:home,HARNESS_INIT:'1',PORT:String(await unusedPort()),STARK_API_KEY:'synthetic-only'}};
  return {root,cwd,other,home,options};
}
async function start(options:Parameters<typeof startBackend>[0]) {const backend=await startBackend(options);cleanups.push(()=>backend.close());return backend;}
const headers={host:'127.0.0.1','content-type':'application/json'};

it('authenticates readiness without sending the key, rejects replay, expiry, wrong instance/action and origin',async()=>{
  const t=await fixture(),backend=await start(t.options),id=backend.lifecycle.instanceId,key=backend.lifecycle.key;
  const request=signBackendRequest(key,'readiness',id);
  expect(verifyBackendProof(key,'readiness',request,null)).toBe(false);
  const response=await backend.app.inject({method:'POST',url:'/api/backend/readiness',headers,payload:request});
  expect(response.statusCode).toBe(200);expect(verifyBackendProof(key,'readiness',request,response.json())).toBe(true);
  expect(verifyBackendProof(key,'shutdown',request,response.json())).toBe(false);
  expect(response.body).not.toContain(key);expect(response.body).not.toContain('synthetic-only');
  const proof=response.json();proof.identity.profileId='impostor';expect(verifyBackendProof(key,'readiness',request,proof)).toBe(false);
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
it('keeps selected data/config across cwd changes and refuses a missing database or lost override',async()=>{
  const t=await fixture(),first=await start(t.options);
  const store=new Store(path.join(first.config.dataDir,'state.sqlite'));
  const project=store.createProject('Keep',t.other),chat=store.createChat(project.id,'Keep','review');store.close();
  const id=first.profile.id;await first.close();
  writeFileSync(path.join(t.other,'.env'),'STARK_API_KEY=wrong-profile');
  const next=await start({...t.options,cwd:t.other,env:{HARNESS_HOME:t.home,PORT:t.options.env.PORT}});expect(next.profile.id).toBe(id);
  expect((await next.app.inject({url:`/api/chats/${chat.id}`,headers:{...headers,authorization:`Bearer ${next.auth.token}`}})).statusCode).toBe(200);
  await next.close();
  renameSync(path.join(next.config.dataDir,'state.sqlite'),path.join(next.config.dataDir,'retained.sqlite'));
  await expect(startBackend(t.options)).rejects.toThrow('missing');
  const u=await fixture(),override=path.join(u.root,'explicit');
  const custom=await start({...u.options,env:{...u.options.env,HARNESS_DATA_DIR:override}});await custom.close();
  await expect(startBackend(u.options)).rejects.toThrow('directory changed');
  const deliberate=await start({...u.options,env:{...u.options.env,HARNESS_SELECT_DATA:'1'}});
  expect(deliberate.config.dataDir).not.toBe(override);
});
it('migrates through startBackend, saves provider settings in stable config, and restarts without one-time flags',async()=>{
  const t=await fixture();
  const old=new Store(path.join(t.cwd,'.harness','state.sqlite'));
  const project=old.createProject('Imported',t.other),chat=old.createChat(project.id,'Original','review');old.close();
  writeFileSync(path.join(t.cwd,'.env'),'ARCHITECT_MODEL=legacy\nSTARK_API_KEY=legacy-synthetic\n');
  const first=await start({...t.options,env:{HARNESS_HOME:t.home,PORT:t.options.env.PORT,HARNESS_LEGACY_ROOT:t.cwd}});
  const response=await first.app.inject({method:'PATCH',url:'/api/provider-settings',headers:{...headers,authorization:'Bearer '+first.auth.token},payload:{apiKey:'new-synthetic',models:{architect:'new-default'}}});
  expect(response.statusCode).toBe(200);expect(response.body).not.toContain('new-synthetic');
  expect(readFileSync(first.profile.paths.configFile,'utf8')).toContain('new-synthetic');
  expect(readFileSync(path.join(t.cwd,'.env'),'utf8')).toContain('legacy-synthetic');
  await first.close();
  const next=await start({...t.options,cwd:t.other,env:{HARNESS_HOME:t.home,PORT:t.options.env.PORT}});
  expect(next.config.apiKey).toBe('new-synthetic');
  const detail=(await next.app.inject({url:`/api/chats/${chat.id}`,headers:{...headers,authorization:`Bearer ${next.auth.token}`}})).json();
  expect(detail.chat.models.architect).toBe('legacy');
});
it('failed startup never replaces a working data binding; retry after port collision remains possible',async()=>{
  const t=await fixture(),first=await start(t.options),original=first.config.dataDir;await first.close();
  const binding=readFileSync(path.join(first.profile.paths.profile,'data-location.json'),'utf8');
  const server=createServer();server.listen(Number(t.options.env.PORT),'127.0.0.1');await once(server,'listening');
  try {
    await expect(startBackend({...t.options,env:{...t.options.env,HARNESS_SELECT_DATA:'1',HARNESS_DATA_DIR:path.join(t.root,'alternative')}})).rejects.toThrow('EADDRINUSE');
    expect(readFileSync(path.join(first.profile.paths.profile,'data-location.json'),'utf8')).toBe(binding);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
  const next=await start(t.options);expect(next.config.dataDir).toBe(original);
});
it('fails occupied-port startup and releases ownership without touching the unrelated listener',async()=>{
  const t=await fixture(),server=createServer();server.listen(Number(t.options.env.PORT),'127.0.0.1');await once(server,'listening');
  cleanups.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  await expect(startBackend(t.options)).rejects.toThrow('EADDRINUSE');expect(server.listening).toBe(true);
  const lock=new ProfileOwnership(t.home);lock.close();
});
it('rejects two different homes sharing one data override in actual backend processes',async()=>{
  const t=await fixture(),first=await start({...t.options,env:{...t.options.env,HARNESS_DATA_DIR:path.join(t.root,'shared')}});
  const options={...t.options,env:{...t.options.env,HARNESS_HOME:path.join(t.root,'second'),HARNESS_DATA_DIR:first.config.dataDir,PORT:String(await unusedPort())}};
  const child=fork(fileURLToPath(new URL('./profile-worker.ts',import.meta.url)),['backend',JSON.stringify(options)],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});
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
  const lifecycle=new BackendLifecycle('profile'),app=Fastify();let finish!:()=>void;
  const close=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  lifecycle.register(app,close);app.get('/api/work',()=>({ok:true}));lifecycle.ready();
  const first=lifecycle.stop(close),second=lifecycle.stop(close);expect(first).toBe(second);
  expect((await app.inject('/api/work')).statusCode).toBe(503);expect(close).toHaveBeenCalledTimes(1);
  finish();await first;expect(lifecycle.identity().state).toBe('stopped');await app.close();
  const failed=new BackendLifecycle('profile');await expect(failed.stop(async()=>{throw new Error('drain failure');})).rejects.toThrow('drain failure');
  expect(failed.identity().state).toBe('failed');
});
it('retains actual ownership during a hanging or failed close',async()=>{
  const t=await fixture(),backend=await start(t.options);
  const original=backend.app.close.bind(backend.app);let release!:()=>void;
  vi.spyOn(backend.app,'close').mockImplementation((()=>new Promise<void>(resolve=>{release=resolve;})) as typeof backend.app.close);
  const closing=backend.close();await Promise.resolve();expect(()=>new ProfileOwnership(t.home)).toThrow('owned');
  await original();release();await closing;
  const lock=new ProfileOwnership(t.home);lock.close();
});
