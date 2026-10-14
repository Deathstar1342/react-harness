import { afterEach,expect,it,vi } from 'vitest';
import Fastify from 'fastify';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { BackendLifecycle,signBackendRequest } from '../server/lifecycle.js';
import { DesktopController } from '../desktop/controller.js';
import type { BackendIdentity } from '../shared/types.js';
import type { BackendTarget } from '../desktop/proxy.js';
import { observeCleanupFailure } from '../desktop/process.js';
const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture() {
  const lifecycle=new BackendLifecycle(randomUUID()),app=Fastify();
  let finish!:()=>void,fail!:(e:Error)=>void;
  const drain=vi.fn(()=>new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;}));
  lifecycle.register(app,drain);lifecycle.ready();const address=await app.listen({host:'127.0.0.1',port:0});
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),pid:123,exitCode:null,signalCode:null,kill:vi.fn()}) as unknown as ChildProcessWithoutNullStreams;
  const controller=new DesktopController('/unused');
  const owned=controller as unknown as {trackChild:(c:ChildProcessWithoutNullStreams)=>void;identity:BackendIdentity;key:string;active:BackendTarget;child?:ChildProcessWithoutNullStreams};
  owned.trackChild(child);owned.identity=lifecycle.identity();owned.key=lifecycle.key;owned.active={address,token:'unused'};controller.state.phase='ready';
  // Same private owned-pipe notice emitted by backend-entry, even if HTTP closes.
  lifecycle.onFailure(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({type:'cleanup-failed',instanceId:lifecycle.instanceId})+'\n')));
  cleanup.push(async()=>{child.emit('close',0);await app.close();});
  return {lifecycle,app,controller,child,owned,drain,finish:()=>finish(),fail:()=>fail(new Error('synthetic failed drain'))};
}
it('reports failed drain after valid shutdown acknowledgement and retains exact ownership on repeated close',async()=>{
  const t=await fixture(),stopped=t.controller.stop();const failed=expect(stopped).rejects.toThrow('cleanup failed');
  await vi.waitFor(()=>expect(t.drain).toHaveBeenCalledTimes(1));t.fail();await failed;
  expect(t.lifecycle.identity().state).toBe('failed');expect(t.controller.state.phase).toBe('failed');expect(t.owned.child).toBe(t.child);expect(t.child.kill).not.toHaveBeenCalled();
  await expect(t.controller.stop()).rejects.toThrow('cleanup failed');
  // Repeated authenticated shutdown must not erase a retained failed lifecycle.
  const response=await t.app.inject({method:'POST',url:'/api/backend/shutdown',payload:signBackendRequest(t.lifecycle.key,'shutdown',t.lifecycle.instanceId)});
  expect(response.json().identity.state).toBe('failed');expect(t.drain).toHaveBeenCalledTimes(1);
});
it('allows legitimate drain indefinitely and requires actual process exit after completion',async()=>{
  const t=await fixture();let settled=false;const stopped=t.controller.stop().then(()=>{settled=true;});
  await vi.waitFor(()=>expect(t.drain).toHaveBeenCalledOnce());await new Promise(r=>setTimeout(r,40));expect(settled).toBe(false);expect(t.controller.state.phase).toBe('stopping');
  t.finish();await vi.waitFor(()=>expect(t.lifecycle.identity().state).toBe('stopped'));expect(settled).toBe(false);
  t.child.emit('close',0);await stopped;expect(t.owned.child).toBeUndefined();expect(t.child.kill).not.toHaveBeenCalled();
});
it('observes failure through the owned pipe even after the HTTP listener has closed',async()=>{
  const t=await fixture(),stopped=t.controller.stop();const failed=expect(stopped).rejects.toThrow('cleanup failed');
  await vi.waitFor(()=>expect(t.drain).toHaveBeenCalledOnce());await t.app.close();expect(t.app.server.listening).toBe(false);
  t.fail();await failed;expect(t.controller.state.phase).toBe('failed');expect(t.owned.child).toBe(t.child);expect(t.controller.target()).toBeUndefined();expect(t.child.kill).not.toHaveBeenCalled();
});
it('accepts only bounded complete private notices and ignores other instance failures',async()=>{
  const t=await fixture();t.child.stdout.emit('data',Buffer.from(JSON.stringify({type:'cleanup-failed',instanceId:randomUUID()})+'\n'));expect(t.controller.state.phase).toBe('ready');
  const stream=new PassThrough(),seen:string[]=[];const stop=observeCleanupFailure(stream,id=>seen.push(id)),id=randomUUID();
  stream.write('x'.repeat(2000)+'\n');stream.write(JSON.stringify({type:'cleanup-failed',instanceId:id}).slice(0,-1));expect(seen).toEqual([]);stream.write('}\n');expect(seen).toEqual([id]);stop();
});
