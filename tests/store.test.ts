import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
describe('durable workspace state', () => {
  it('preserves conversations and pending approvals across restart, marks running work interrupted', () => {
    const root = mkdtempSync(path.join(tmpdir(),'harness-db-')); roots.push(root);
    const file = path.join(root,'state.sqlite');
    const first = new Store(file);
    const project = first.createProject('Example',root);
    const chat = first.createChat(project.id,'Work','review');
    first.message(chat.id,'user','Keep my label');
    first.updateChat(chat.id,{status:'running'});
    first.setState(`run:${chat.id}`,{step:3,pending:{stage:'executing'}});
    first.approval({id:'approval-1',chatId:chat.id,agentId:'coder',action:{name:'write_file',args:{}},inspection:{effect:'write',risk:'routine',description:'Edit'},status:'pending',createdAt:new Date().toISOString()});
    first.close();
    const next = new Store(file);
    try {
      next.recover();
      expect(next.chat(chat.id).status).toBe('interrupted');
      expect(next.messages(chat.id)[0].content).toBe('Keep my label');
      expect(next.getState(`run:${chat.id}`,null)).toEqual({step:3,pending:{stage:'executing'}});
      expect(next.getApproval('approval-1').status).toBe('pending');
      expect(next.events(chat.id).map(event=>event.id)).toEqual([...next.events(chat.id).map(event=>event.id)].sort((a,b)=>a-b));
    } finally { next.close(); }
  });
  it('rolls back state transactions and keeps project chats separate', () => {
    const store = new Store(':memory:');
    try {
      const a = store.createProject('A','/a'); const b = store.createProject('B','/b');
      const chat = store.createChat(a.id,'A task','balanced');
      expect(store.chats(b.id)).toEqual([]);
      expect(() => store.transaction(()=>{store.setState('broken',true);throw new Error('rollback');})).toThrow('rollback');
      expect(store.getState('broken',false)).toBe(false);
      expect(store.chat(chat.id).projectId).toBe(a.id);
    } finally { store.close(); }
  });
});
