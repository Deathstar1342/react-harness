import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { WorkspaceTools } from '../server/tools/index.js';
import { ToolError } from '../server/tools/paths.js';
import { Store } from '../server/store.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
  const parent=await mkdtemp(path.join(tmpdir(),'sandbox-api-'));cleanup.push(()=>rm(parent,{recursive:true,force:true}));
  const root=path.join(parent,'project');await mkdir(root);
  const home=path.join(parent,'app'),config=readConfig({HARNESS_HOME:home,HARNESS_DATA_DIR:path.join(home,'state')});
  const tools=new WorkspaceTools(),store=new Store(':memory:');
  const app=await createApp({config,store,tools,provider:{models:async()=>[],complete:async()=>{throw Error('No model');}},hooks:{instructions:()=>''}});
  cleanup.push(async()=>{await app.app.close();store.close();});
  const project=store.createProject('Fixture',root);
  return {...app,tools,root,home,parent,project};
}
it('resets only private sandbox storage through strict registered-project API authority',async()=>{
  const t=await fixture(),storage=t.tools.sandbox.storage(t.root);await writeFile(path.join(storage,'cache','cached'),'cache');
  await writeFile(path.join(t.root,'source.txt'),'source');await mkdir(path.join(t.root,'node_modules'));await writeFile(path.join(t.root,'node_modules','keep'),'dependency');await mkdir(path.join(t.root,'.venv'));await writeFile(path.join(t.root,'.venv','keep'),'venv');
  const url=`/api/projects/${t.project.id}/sandbox/reset`;
  expect((await t.app.inject({method:'POST',url,payload:{path:t.parent}})).statusCode).toBe(400);
  expect((await t.app.inject({method:'POST',url,headers:{origin:'https://untrusted.example'},payload:{}})).statusCode).toBe(403);
  t.tools.setDirty(t.root,'source.txt','editor',true);
  expect((await t.app.inject({method:'POST',url,payload:{}})).statusCode).toBe(409);
  t.tools.setDirty(t.root,'source.txt','editor',false);
  expect((await t.app.inject({method:'POST',url,payload:{}})).statusCode).toBe(200);
  await expect(readFile(path.join(storage,'cache','cached'))).rejects.toThrow();
  for(const file of ['source.txt','node_modules/keep','.venv/keep'])expect((await readFile(path.join(t.root,file))).length).toBeGreaterThan(0);
  t.store.removalError(t.project.id,'uncertain prior deletion');
  expect((await t.app.inject({method:'POST',url,payload:{}})).statusCode).toBe(409);
  expect(t.store.project(t.project.id).removalError).toBe('uncertain prior deletion');
});
it('rejects app/state/ancestor and overlapping imports before registration',async()=>{
  const t=await fixture();
  for(const root of [t.home,t.parent,path.join(t.root,'nested')]){
    await mkdir(root,{recursive:true});const result=await t.app.inject({method:'POST',url:'/api/projects',payload:{mode:'import',name:'Unsafe',path:root}});expect(result.statusCode).toBe(400);
  }
  expect(t.store.projects()).toHaveLength(1);
});
it('quarantines uncertain cleanup, prevents mutation/reuse and rejects backend tool shutdown',async()=>{
  const parent=await mkdtemp(path.join(tmpdir(),'sandbox-quarantine-'));cleanup.push(()=>rm(parent,{recursive:true,force:true}));
  const tools=new WorkspaceTools(),pool=(tools as any).shells;
  const id=JSON.stringify([parent,'chat','coder']);let attempts=0;
  pool.sessions.set(id,{hasBackgroundWork:false,dispose:async()=>{attempts++;throw new ToolError('termination timeout','SANDBOX_CLEANUP_FAILED');}});
  let mutated=false;
  await expect(tools.removeScope(parent,undefined,()=>{mutated=true;})).rejects.toThrow('timeout');expect(mutated).toBe(false);expect(pool.sessions.has(id)).toBe(true);
  expect(()=>tools.resetSandbox(parent)).toThrow('uncertain');
  await expect(tools.execute({projectRoot:parent,chatId:'chat',agentId:'coder'},{name:'run_shell',args:{command:'touch impossible'}})).rejects.toThrow('uncertain');
  await expect(tools.dispose()).rejects.toThrow('timeout');expect(attempts).toBe(2);
});
it('refuses reset while another project HTTP request is awaiting work',async()=>{
  const t=await fixture();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  const original=t.tools.read.bind(t.tools),spy=vi.spyOn(t.tools,'read').mockImplementation(async(...args)=>{entered();await gate;return original(...args);});
  const pending=t.app.inject({method:'GET',url:`/api/projects/${t.project.id}/file?path=source.txt`});void pending.then(()=>{});await ready;
  expect((await t.app.inject({method:'POST',url:`/api/projects/${t.project.id}/sandbox/reset`,payload:{}})).statusCode).toBe(409);
  release();await pending;spy.mockRestore();
  expect((await t.app.inject({method:'POST',url:`/api/projects/${t.project.id}/sandbox/reset`,payload:{}})).statusCode).toBe(200);
});
it('gates new requests during reset and rejects an unavailable reset hook',async()=>{
  const t=await fixture();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
  const original=t.tools.resetSandbox.bind(t.tools),spy=vi.spyOn(t.tools,'resetSandbox').mockImplementation(async root=>{entered();await gate;await original(root);});
  const url=`/api/projects/${t.project.id}/sandbox/reset`,pending=t.app.inject({method:'POST',url,payload:{}});void pending.then(()=>{});await ready;
  expect((await t.app.inject({method:'POST',url:`/api/projects/${t.project.id}/chats`,payload:{}})).statusCode).toBe(409);
  expect((await t.app.inject({method:'PATCH',url:'/api/workspace',payload:{workspaceRoot:t.parent}})).statusCode).toBe(409);
  release();expect((await pending).statusCode).toBe(200);spy.mockRestore();
  Object.defineProperty(t.tools,'resetSandbox',{value:undefined});expect((await t.app.inject({method:'POST',url,payload:{}})).statusCode).toBe(503);
});
