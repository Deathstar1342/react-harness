import { expect,it } from 'vitest';
import { DocumentGuard } from '../desktop/document-guard.js';
import type { DesktopStatus } from '../desktop/contracts.js';
const state=(sessionId:string):DesktopStatus=>({platform:'linux',phase:'ready',sessionId,selection:{environment:{kind:'linux'},home:'/'+sessionId},distributions:[],message:'ready'});
it('quarantines a delayed new session and preserves the old published editor key when edits arrive',async()=>{
  const guard=new DocumentGuard();guard.publish(state('old'));const ticket=guard.begin();
  await Promise.resolve();guard.edited(true);const next=state('new');
  expect(guard.status(next)).toMatchObject({sessionId:'old',selection:{home:'/old'},phase:'starting',transitioning:true});
  expect(()=>guard.check(ticket)).toThrow('editor changed');guard.end(ticket);
  expect(guard.sessionId).toBe('old');expect(guard.dirty).toBe(true);
});
it('rejects stale document callbacks and permits only a safely committed replacement',()=>{
  const guard=new DocumentGuard(),old=guard.begin();guard.documentChanged();expect(()=>guard.check(old)).toThrow();guard.end(old);
  const next=guard.begin();guard.check(next);guard.publish(state('new'));guard.documentChanged();guard.end(next);
  expect(()=>guard.check(old)).toThrow();expect(guard.status(state('new')).sessionId).toBe('new');
});
it('does not lose later edits during close even when older dirty text was explicitly confirmed',async()=>{
  const guard=new DocumentGuard();guard.edited(true);const close=guard.begin(true);guard.check(close);
  await Promise.resolve();guard.edited(true);expect(()=>guard.check(close)).toThrow();guard.end(close);
  const retry=guard.begin(true);guard.check(retry);guard.end(retry);
});
it('serializes transitions and rejects changes even if the new edits were later discarded',()=>{
  const guard=new DocumentGuard(),ticket=guard.begin();expect(()=>guard.begin()).toThrow('already');guard.edited(true);guard.edited(false);expect(()=>guard.check(ticket)).toThrow();guard.end(ticket);
});
