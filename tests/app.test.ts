import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { readConfig } from '../server/config.js';
import type { AgentResponse, ToolService } from '../shared/types.js';

const roots: string[] = [];
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
const tools: ToolService = {inspect:async()=>({effect:'read',risk:'routine',description:''}),execute:async()=>({ok:true,output:''}),read:async(_root,path)=>path === 'AGENTS.md' ? {path,content:'',hash:null} : {path:'x',content:'x',hash:'hash'},list:async()=>[],save:async()=>{throw new Error('stale file version');},setDirty:()=>{},dispose:async()=>{}};
async function make() {
  const store = new Store(':memory:');
  const config = readConfig({STARK_API_KEY:'private-secret-value',STARK_BASE_URL:'http://127.0.0.1/v1'});
  const result = await createApp({config,store,tools,provider:{models:async()=>['test-model'],complete:async()=>({text:JSON.stringify({version:1,type:'final',message:'Hello'})})},hooks:{parse:text=>JSON.parse(text) as AgentResponse,instructions:()=> 'JSON'}});
  return {...result,close:async()=>{await result.app.close();store.close();}};
}
describe('local application API',()=> {
  it('creates a project and chat, responds through the architect, and protects backend settings',async()=> {
    const t = await make(); const root = await mkdtemp(path.join(tmpdir(),'harness-api-'));roots.push(root);
    try {
      const projectReply = await t.app.inject({method:'POST',url:'/api/projects',payload:{name:'Example',path:path.join(root,'new'),mode:'create'}});
      expect(projectReply.statusCode).toBe(201);
      const project = projectReply.json();
      const chat = (await t.app.inject({method:'POST',url:`/api/projects/${project.id}/chats`,payload:{}})).json();
      const accepted = await t.app.inject({method:'POST',url:`/api/chats/${chat.id}/messages`,payload:{content:'Hello'}});
      expect(accepted.statusCode).toBe(202);await t.runtime.wait(chat.id);
      const detail = (await t.app.inject(`/api/chats/${chat.id}`)).json();
      expect(detail.messages.map((m:{role:string})=>m.role)).toEqual(['user','architect']);
      const settings = await t.app.inject('/api/settings');expect(settings.body).not.toContain('private-secret-value');
      expect((await t.app.inject({method:'PUT',url:`/api/projects/${project.id}/file`,payload:{path:'x',content:'x',baseHash:'old',owner:'tab'}})).statusCode).toBe(409);
    } finally {await t.close();}
  });
  it('rejects cross-origin and non-JSON writes before project access',async()=> {
    const t = await make();
    try {
      expect((await t.app.inject({method:'POST',url:'/api/projects',headers:{origin:'https://attacker.example'},payload:{}})).statusCode).toBe(403);
      expect((await t.app.inject({method:'GET',url:'/api/projects',headers:{host:'attacker.example'}})).statusCode).toBe(403);
      expect((await t.app.inject({method:'POST',url:'/api/projects',headers:{'content-type':'text/plain'},payload:'{}'})).statusCode).toBe(415);
      expect((await t.app.inject({method:'POST',url:'/api/projects',payload:{name:'Unsafe',path:'relative',mode:'create'}})).statusCode).toBe(400);
    } finally {await t.close();}
  });
});
