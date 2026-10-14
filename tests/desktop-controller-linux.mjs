import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DesktopController } from '../build/app/desktop/controller.js';
import { ProfileOwnership } from '../build/app/server/profile.js';
assert.equal(process.platform,'linux');
const root=mkdtempSync(tmpdir()+'/abyssus-controller-'),appRoot=path.resolve(import.meta.dirname,'../build/app');
const first=new DesktopController(appRoot),second=new DesktopController(appRoot);
const input={environment:{kind:'linux'},home:root+'/first',mode:'initialize'};
try {
  await first.start(input);const original=first.state.sessionId;
  assert(first.target());
  await assert.rejects(second.start({...input,mode:'existing'}),/owned/);
  await second.stop();assert.equal(first.state.phase,'ready');
  // Kill only this controller's exact spawned child to exercise actual crash release.
  const child=first.child;assert(child?.pid);const exited=once(child,'close');child.kill('SIGKILL');await exited;
  assert.equal(first.state.phase,'failed');assert.equal(first.target(),undefined);
  const lock=new ProfileOwnership(input.home);lock.close();
  await first.start({...input,mode:'existing'});assert.notEqual(first.state.sessionId,original);
  assert.equal(first.state.sessionId.split('/')[0],original.split('/')[0]);
  await first.stop();assert.equal(first.target(),undefined);
  await first.start({...input,home:root+'/second'});assert.notEqual(first.state.sessionId.split('/')[0],original.split('/')[0]);
  await first.stop();
  await assert.rejects(first.start({...input,home:root+'/missing',mode:'existing'}),/missing|No initialized/i);await first.stop();
  console.log('PASS real controller occupied-profile refusal, exact owned-child crash, lock release, explicit same-profile recovery, distinct profile session and failed startup cleanup');
}finally{await first.stop().catch(()=>{});await second.stop().catch(()=>{});rmSync(root,{recursive:true,force:true});}
