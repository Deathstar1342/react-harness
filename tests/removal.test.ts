import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, realpath } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Runtime, type RunState } from '../server/runtime.js';
import { Removal } from '../server/removal.js';
import { WorkspaceLocations } from '../server/workspace.js';
import { WorkspaceTools } from '../server/tools/index.js';
import { WorkspaceFiles } from '../server/tools/files.js';
import { readConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { ShellPool } from '../server/tools/shell.js';
import type { AgentResponse, DeletionPreview, ModelProvider } from '../shared/types.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const clean of cleanups.splice(0).reverse()) await clean();});
async function fixture() {
  const temp=await realpath(await mkdtemp(path.join(tmpdir(),'rh-removal-')));
  const root=path.join(temp,'workspace','project');await mkdir(root,{recursive:true});
  await writeFile(path.join(root,'keep.txt'),'user files');
  const config=readConfig({HARNESS_DATA_DIR:path.join(temp,'data'),HARNESS_WORKSPACE_ROOT:path.join(temp,'workspace'),STARK_BASE_URL:'http://localhost/v1',STARK_API_KEY:'test'});
  const filename=path.join(config.dataDir,'state.sqlite'),store=new Store(filename),tools=new WorkspaceTools();
  const provider:ModelProvider={models:async()=>[],complete:async()=>({text:JSON.stringify({version:1,type:'final',message:'Done'})})};
  const hooks={parse:(text:string)=>JSON.parse(text) as AgentResponse,instructions:()=>''};
  const runtime=new Runtime(store,provider,tools,config,hooks),locations=new WorkspaceLocations(store,config.workspaceRoot),cleanup=vi.fn();
  const removal=new Removal(store,runtime,tools,config,locations,cleanup);
  const project=store.createProject('Project',root),chat=store.createChat(project.id,'Chat','autonomous');
  cleanups.push(async()=>{await runtime.close();await tools.dispose();store.close();await rm(temp,{recursive:true,force:true});});
  const disk=()=>removal.project(project.id,{mode:'disk',...removal.preview(project.id)});
  return {temp,root,config,filename,store,tools,provider,hooks,runtime,locations,cleanup,removal,project,chat,disk};
}
const paused:RunState={frames:[{id:'frame',role:'architect',messages:[],repairs:0}],steering:[],generation:0,steps:0,planOnly:false};

it('app-only removal preserves all bytes including Git/hidden files and deletes dependent records durably',async()=>{
  const t=await fixture();await mkdir(path.join(t.root,'.git'));await writeFile(path.join(t.root,'.git','config'),'private config');await writeFile(path.join(t.root,'.env'),'local-only');
  t.store.message(t.chat.id,'user','history');t.store.setPlan(t.chat.id,{phases:[]});t.store.setState(`run:${t.chat.id}`,paused);t.store.setState(`context:archive:${t.chat.id}:frame:hash`,{messages:['archive']});
  t.store.setState('preferences:debug',true);
  await t.removal.project(t.project.id,{mode:'app-only'});
  expect(await readFile(path.join(t.root,'.env'),'utf8')).toBe('local-only');expect(await readFile(path.join(t.root,'.git','config'),'utf8')).toBe('private config');
  expect(t.store.projects()).toEqual([]);expect(t.store.chats()).toEqual([]);expect(t.store.events(t.chat.id)).toEqual([]);expect(t.store.messages(t.chat.id)).toEqual([]);
  expect(t.store.getState(`run:${t.chat.id}`,null)).toBeNull();expect(t.store.getState(`context:archive:${t.chat.id}:frame:hash`,null)).toBeNull();expect(t.store.getState('preferences:debug',false)).toBe(true);
  const reopened=new Store(t.filename);expect(reopened.projects()).toEqual([]);reopened.close();
  await expect(t.runtime.control(t.chat.id,'resume')).rejects.toThrow('not found');
  expect(t.cleanup).toHaveBeenCalledWith(t.project.id,[t.chat.id],true);
});

it('chat deletion forgets paused frames and its history, preserves siblings and project files',async()=>{
  const t=await fixture(),sibling=t.store.createChat(t.project.id,'Other','review');
  t.store.setState(`run:${t.chat.id}`,paused);t.store.updateChat(t.chat.id,{status:'paused'});t.runtime.notifyFileChange(t.project.id,'keep.txt','external');
  t.store.message(t.chat.id,'user','deleted');t.store.message(sibling.id,'user','preserved');
  await t.removal.chat(t.chat.id);
  expect(t.store.chats(t.project.id).map(c=>c.id)).toEqual([sibling.id]);expect(t.store.messages(sibling.id)).toHaveLength(1);expect(existsSync(t.root)).toBe(true);
  await expect(t.runtime.submit(t.chat.id,'resume')).rejects.toThrow('not found');expect(t.cleanup).toHaveBeenCalledWith(t.project.id,[t.chat.id],false);
});

it('disk confirmation deletes only the selected project including imported hidden files',async()=>{
  const t=await fixture(),other=path.join(t.temp,'workspace','other');await mkdir(other);await writeFile(path.join(other,'safe'),'safe');await writeFile(path.join(t.root,'.env'),'fixture only');
  const preview=t.removal.preview(t.project.id);expect(preview.canonicalPath).toBe(t.root);
  await t.removal.project(t.project.id,{mode:'disk',...preview});
  expect(existsSync(t.root)).toBe(false);expect(await readFile(path.join(other,'safe'),'utf8')).toBe('safe');expect(t.store.projects()).toEqual([]);
});

it('rejects mismatched, expired and wrong-project tokens without file effects',async()=>{
  const t=await fixture(),preview=t.removal.preview(t.project.id);
  const cleanup=vi.spyOn(t.tools,'removeScope');
  await expect(t.removal.project(t.project.id,{mode:'disk',...preview,canonicalPath:t.temp})).rejects.toThrow('confirmation');
  const sibling=t.store.createProject('Other',path.join(t.temp,'other'));await mkdir(sibling.path);
  await expect(t.removal.project(sibling.id,{mode:'disk',...preview})).rejects.toThrow('confirmation');
  const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+300_001);
  await expect(t.removal.project(t.project.id,{mode:'disk',...preview})).rejects.toThrow('expired');clock.mockRestore();
  expect(cleanup).not.toHaveBeenCalled();expect(t.cleanup).not.toHaveBeenCalled();
  expect(await readFile(path.join(t.root,'keep.txt'),'utf8')).toBe('user files');
});

it('refuses an ordinary directory replacement after confirmation',async()=>{
  const t=await fixture(),preview=t.removal.preview(t.project.id);
  await rename(t.root,t.root+'-old');await mkdir(t.root);await writeFile(path.join(t.root,'replacement'),'do not delete');
  await expect(t.removal.project(t.project.id,{mode:'disk',...preview})).rejects.toThrow('identity changed');
  expect(existsSync(path.join(t.root,'replacement'))).toBe(true);expect(existsSync(t.root+'-old')).toBe(true);
});

it('refuses root junction/symlink substitution and nested links without touching outside files',async()=>{
  const t=await fixture(),preview=t.removal.preview(t.project.id),outside=path.join(t.temp,'outside');await mkdir(outside);await writeFile(path.join(outside,'safe'),'outside');
  await rename(t.root,t.root+'-old');await symlink(outside,t.root,process.platform==='win32'?'junction':'dir');
  await expect(t.removal.project(t.project.id,{mode:'disk',...preview})).rejects.toThrow('Linked');
  await rm(t.root);await rename(t.root+'-old',t.root);await symlink(outside,path.join(t.root,'linked'),process.platform==='win32'?'junction':'dir');
  await expect(t.disk()).rejects.toThrow('Linked');expect(await readFile(path.join(outside,'safe'),'utf8')).toBe('outside');expect(t.store.project(t.project.id).removalError).toBeUndefined();
  await t.removal.project(t.project.id,{mode:'app-only'});expect(existsSync(path.join(t.root,'linked'))).toBe(true);
});

it('refuses filesystem/home/workspace/application/database/config roots in disk mode but allows app-only',async()=>{
  const t=await fixture();
  for (const unsafe of [path.parse(t.root).root,homedir(),t.config.workspaceRoot,process.cwd(),t.config.dataDir,t.temp]) {
    const canonical=await realpath(unsafe),project=t.store.createProject('Unsafe',canonical);
    expect(()=>t.removal.preview(project.id)).toThrow(/root|Linked/);
    await t.removal.project(project.id,{mode:'app-only'});expect(existsSync(canonical)).toBe(true);
  }
});

it('rejects overlapping registrations in either direction, including newly registered overlap after preview',async()=>{
  const t=await fixture(),preview=t.removal.preview(t.project.id),child=path.join(t.root,'nested');await mkdir(child);
  const nested=t.store.createProject('Nested',child);
  await expect(t.removal.project(t.project.id,{mode:'disk',...preview})).rejects.toThrow('overlaps');expect(()=>t.removal.preview(nested.id)).toThrow('overlaps');
  await t.removal.project(nested.id,{mode:'app-only'});await t.disk();
});

it('dirty leases block chat, app-only and disk deletion and can be released for retry',async()=>{
  const t=await fixture();t.tools.setDirty(t.root,'keep.txt','editor',true);
  await expect(t.removal.chat(t.chat.id)).rejects.toThrow('unsaved');await expect(t.removal.project(t.project.id,{mode:'app-only'})).rejects.toThrow('unsaved');await expect(t.disk()).rejects.toThrow('unsaved');
  t.tools.setDirty(t.root,'keep.txt','editor',false);await t.disk();
});

it('a late dirty lease after preview is authoritative and the token is reusable after clean release',async()=>{
  const t=await fixture(),preview=t.removal.preview(t.project.id);t.tools.setDirty(t.root,'keep.txt','late-editor',true);
  await expect(t.removal.project(t.project.id,{mode:'disk',...preview})).rejects.toThrow('unsaved');
  t.tools.setDirty(t.root,'keep.txt','late-editor',false);await t.removal.project(t.project.id,{mode:'disk',...preview});
});

it('tool operations are counted before their first await, preventing save/delete races',async()=>{
  const t=await fixture();const read=t.tools.read(t.root,'keep.txt');
  await expect(t.removal.project(t.project.id,{mode:'app-only'})).rejects.toThrow('pending');await read;
  const snapshot=await t.tools.read(t.root,'keep.txt'),save=t.tools.save(t.root,'keep.txt','new',snapshot.hash,'editor');
  await expect(t.disk()).rejects.toThrow('pending');await save;expect(await readFile(path.join(t.root,'keep.txt'),'utf8')).toBe('new');
});

it('excludes concurrent launches/deletions and rejects stopping work until its promise settles',async()=>{
  const t=await fixture();let release!:()=>void;let entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve);
  t.provider.complete=async()=>{entered();await new Promise<void>(resolve=>release=resolve);return {text:JSON.stringify({version:1,type:'final',message:'Done'})};};
  await t.runtime.submit(t.chat.id,'work');await ready;
  const stop=t.runtime.control(t.chat.id,'pause');
  try {await expect(t.disk()).rejects.toThrow('pending');} finally {release();await stop;}
  const removing=t.removal.project(t.project.id,{mode:'app-only'});
  await expect(t.runtime.submit(t.chat.id,'late')).rejects.toThrow();await removing;
});

it('runtime guard refuses pending approvals, executing frames and overlapping undo promises',async()=>{
  const t=await fixture();t.store.approval({id:'approval',chatId:t.chat.id,agentId:'frame',action:{name:'write_file',args:{}},inspection:{effect:'write',risk:'routine',description:''},status:'pending',createdAt:''});
  await expect(t.removal.chat(t.chat.id)).rejects.toThrow('pending');
  t.store.invalidateApprovals(t.chat.id);
  let release!:()=>void;const undo=t.runtime.exclusiveProjectEdit(t.project.id,()=>new Promise<void>(resolve=>release=resolve));
  await expect(t.disk()).rejects.toThrow('active');release();await undo;
  t.store.setState(`run:${t.chat.id}`,{...paused,frames:[{...paused.frames[0],pending:{id:'action',action:{name:'run_shell',args:{}},stage:'executing'}}]});
  await expect(t.removal.chat(t.chat.id)).rejects.toThrow('pending');
});

it('failed disk mutation stays durable/recoverable and consumes its token without automatic replay',async()=>{
  const t=await fixture(),preview=t.removal.preview(t.project.id);
  const original=t.store.removalError.bind(t.store);
  vi.spyOn(t.store,'removalError').mockImplementation((id,message)=>{
    original(id,message);
    if(message.startsWith('File deletion was started')) throw new Error('simulated durable boundary failure');
  });
  await expect(t.removal.project(t.project.id,{mode:'disk',...preview})).rejects.toThrow('simulated');
  expect(t.store.project(t.project.id).removalError).toContain('started');
  const reopened=new Store(t.filename);reopened.recover();expect(reopened.project(t.project.id).removalError).toContain('started');reopened.close();
  await expect(t.runtime.submit(t.chat.id,'work')).rejects.toThrow('recovery');
  await expect(t.removal.project(t.project.id,{mode:'disk',...preview})).rejects.toThrow('confirmation');
  expect(existsSync(t.root)).toBe(true);await t.removal.project(t.project.id,{mode:'app-only'});expect(existsSync(t.root)).toBe(true);
});

it('fails closed when a ToolService does not implement removal safety',async()=>{
  const t=await fixture();Object.defineProperty(t.tools,'removeScope',{value:undefined});
  await expect(t.disk()).rejects.toThrow('cannot safely');expect(existsSync(t.root)).toBe(true);
});

it('an actual partial disk failure retains app records, exposes the error, and allows a fresh explicit retry',async()=>{
  const t=await fixture(),preview=t.removal.preview(t.project.id);
  const original=t.store.removalError.bind(t.store);let added=false;
  vi.spyOn(t.store,'removalError').mockImplementation((id,message)=>{
    original(id,message);
    if(!added && message.startsWith('File deletion was started')) {added=true;writeFileSync(path.join(t.root,'arrived-after-scan'),'must be reviewed');}
  });
  await expect(t.removal.project(t.project.id,{mode:'disk',...preview})).rejects.toThrow('incomplete');
  expect(existsSync(path.join(t.root,'keep.txt'))).toBe(false);expect(existsSync(path.join(t.root,'arrived-after-scan'))).toBe(true);
  expect(t.store.project(t.project.id).removalError).toContain('retained');expect(t.store.chat(t.chat.id)).toBeDefined();
  expect(()=>t.runtime.notifyFileChange(t.project.id,'keep.txt','external')).not.toThrow();
  await expect(t.removal.project(t.project.id,{mode:'disk',...preview})).rejects.toThrow('confirmation');
  const reopened=new Store(t.filename),restartedTools=new WorkspaceTools();reopened.recover();
  const restartedRuntime=new Runtime(reopened,t.provider,restartedTools,t.config,t.hooks);
  const restarted=new Removal(reopened,restartedRuntime,restartedTools,t.config,new WorkspaceLocations(reopened,t.config.workspaceRoot),()=>{});
  try {
    expect(reopened.project(t.project.id).removalError).toContain('retained');
    await expect(restartedRuntime.submit(t.chat.id,'resume')).rejects.toThrow('recovery');
    await restarted.project(t.project.id,{mode:'disk',...restarted.preview(t.project.id)});expect(existsSync(t.root)).toBe(false);
  } finally {await restartedRuntime.close();await restartedTools.dispose();reopened.close();}
});

it('a database failure after disk deletion keeps the recovery marker and permits app-only recovery',async()=>{
  const t=await fixture(),deleting=vi.spyOn(t.store,'deleteProject').mockImplementation(()=>{throw new Error('database unavailable');});
  await expect(t.disk()).rejects.toThrow('database unavailable');expect(existsSync(t.root)).toBe(false);expect(t.store.project(t.project.id).removalError).toContain('started');
  deleting.mockRestore();await t.removal.project(t.project.id,{mode:'app-only'});expect(t.store.projects()).toEqual([]);
});

it('counts approval decision awaits even after pause makes their approval stale',async()=>{
  const t=await fixture();
  t.store.setState(`run:${t.chat.id}`,{...paused,frames:[{...paused.frames[0],pending:{id:'pending',stage:'prepared',approvalId:'approval',action:{name:'write_file',args:{}}}}]});
  t.store.approval({id:'approval',chatId:t.chat.id,agentId:'frame',action:{name:'write_file',args:{}},inspection:{effect:'write',risk:'routine',description:''},status:'pending',createdAt:''});
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),original=t.tools.read.bind(t.tools);
  vi.spyOn(t.tools,'read').mockImplementation(async(...args)=>{entered();await new Promise<void>(resolve=>release=resolve);return original(...args);});
  const deciding=t.runtime.decide('approval','approve').catch(error=>error);await ready;
  await t.runtime.control(t.chat.id,'pause');await expect(t.removal.chat(t.chat.id)).rejects.toThrow('pending');
  release();await deciding;await t.removal.chat(t.chat.id);expect(t.store.chats()).toEqual([]);
});

it('bounds confirmation tokens and rejects a consumed token against a new registration at the same path',async()=>{
  const t=await fixture(),old=t.removal.preview(t.project.id);
  for(let i=0;i<200;i++) t.removal.preview(t.project.id);
  await expect(t.removal.project(t.project.id,{mode:'disk',...old})).rejects.toThrow('confirmation');
  const used=t.removal.preview(t.project.id);await t.removal.project(t.project.id,{mode:'disk',...used});await mkdir(t.root);
  const replacement=t.store.createProject('New',t.root);await expect(t.removal.project(replacement.id,{mode:'disk',...used})).rejects.toThrow('confirmation');
});

it('HTTP requires explicit JSON contracts, tracks pending saves, and preserves app-only data',async()=>{
  const t=await fixture(),{app}=await createApp(t);cleanups.push(()=>app.close());
  const call=(method:'POST'|'DELETE',url:string,payload:Record<string,unknown>)=>app.inject({method,url,payload});
  expect((await app.inject({method:'DELETE',url:`/api/projects/${t.project.id}`})).statusCode).toBe(415);
  expect((await call('DELETE',`/api/projects/${t.project.id}`,{mode:'disk'})).statusCode).toBe(400);
  expect((await app.inject({method:'DELETE',url:`/api/projects/${t.project.id}`,payload:{mode:'app-only'},headers:{origin:'https://evil.example'}})).statusCode).toBe(403);
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve);
  const original=t.tools.save.bind(t.tools);
  vi.spyOn(t.tools,'save').mockImplementation(async(...args)=>{entered();await new Promise<void>(resolve=>release=resolve);return original(...args);});
  const snapshot=await t.tools.read(t.root,'keep.txt');
  const saving=app.inject({method:'PUT',url:`/api/projects/${t.project.id}/file`,payload:{path:'keep.txt',content:'saved',baseHash:snapshot.hash,owner:'editor'}}).then(r=>r);
  await ready;expect((await call('DELETE',`/api/projects/${t.project.id}`,{mode:'app-only'})).statusCode).toBe(409);release();expect((await saving).statusCode).toBe(200);
  const preview=(await call('POST',`/api/projects/${t.project.id}/deletion-preview`,{})).json<DeletionPreview>();expect(preview.canonicalPath).toBe(t.root);
  expect((await call('DELETE',`/api/chats/${t.chat.id}`,{})).statusCode).toBe(200);
  expect((await call('DELETE',`/api/projects/${t.project.id}`,{mode:'app-only'})).statusCode).toBe(200);expect(await readFile(path.join(t.root,'keep.txt'),'utf8')).toBe('saved');
});

it('a lease arriving after a save validation still blocks removal',async()=>{
  const t=await fixture(),snapshot=await t.tools.read(t.root,'keep.txt');
  const original=WorkspaceFiles.prototype.read;let reads=0;
  vi.spyOn(WorkspaceFiles.prototype,'read').mockImplementation(async function(this:WorkspaceFiles,...args){const result=await original.apply(this,args);if(++reads===2)t.tools.setDirty(t.root,'keep.txt','late',true);return result;});
  await expect(t.tools.save(t.root,'keep.txt','changed',snapshot.hash)).rejects.toThrow('unsaved');await expect(t.disk()).rejects.toThrow('unsaved');
  t.tools.setDirty(t.root,'keep.txt','late',false);
});

it('closes real chat SSE subscriptions while preserving a sibling stream',async()=>{
  const t=await fixture(),server=await createApp(t),sibling=t.store.createChat(t.project.id,'Other','review');cleanups.push(()=>server.app.close());
  const address=await server.app.listen({host:'127.0.0.1',port:0});
  const first=await fetch(`${address}/api/chats/${t.chat.id}/events`),second=await fetch(`${address}/api/chats/${sibling.id}/events`);
  const firstReader=first.body!.getReader(),secondReader=second.body!.getReader();await firstReader.read();await secondReader.read();
  expect(t.store.changes.listenerCount(t.chat.id)).toBe(1);expect(t.store.changes.listenerCount(sibling.id)).toBe(1);
  expect((await server.app.inject({method:'DELETE',url:`/api/chats/${t.chat.id}`,payload:{}})).statusCode).toBe(200);
  expect(new TextDecoder().decode((await firstReader.read()).value)).toContain('event: chat_removed');
  expect((await firstReader.read()).done).toBe(true);expect(t.store.changes.listenerCount(t.chat.id)).toBe(0);expect(t.store.changes.listenerCount(sibling.id)).toBe(1);
  expect((await server.app.inject({method:'DELETE',url:`/api/projects/${t.project.id}`,payload:{mode:'app-only'}})).statusCode).toBe(200);
  expect(new TextDecoder().decode((await secondReader.read()).value)).toContain('"projectRemoved":true');
  expect((await secondReader.read()).done).toBe(true);expect(t.store.changes.listenerCount(sibling.id)).toBe(0);
});

it('an awaited watcher callback cannot notify or revive a removed project',async()=>{
  const t=await fixture(),server=await createApp(t);cleanups.push(()=>server.app.close());
  await server.app.inject(`/api/chats/${t.chat.id}`); // Installs the real recursive watcher.
  const snapshot=await t.tools.read(t.root,'keep.txt');
  expect((await server.app.inject({method:'PUT',url:`/api/projects/${t.project.id}/file`,payload:{path:'keep.txt',content:'saved',baseHash:snapshot.hash,owner:'editor'}})).statusCode).toBe(200);
  const original=t.tools.read.bind(t.tools);let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>entered=resolve);
  vi.spyOn(t.tools,'read').mockImplementation(async(...args)=>{entered();await new Promise<void>(resolve=>release=resolve);return original(...args);});
  const notify=vi.spyOn(server.runtime,'notifyFileChange');await writeFile(path.join(t.root,'keep.txt'),'external');await ready;
  expect((await server.app.inject({method:'DELETE',url:`/api/projects/${t.project.id}`,payload:{mode:'app-only'}})).statusCode).toBe(200);
  release();await new Promise(resolve=>setTimeout(resolve,250));expect(notify).not.toHaveBeenCalled();expect(t.store.projects()).toEqual([]);
});

it.skipIf(process.platform!=='linux')('scoped PTY cleanup preserves sibling sessions and refuses active/background commands',async()=>{
  const t=await fixture(),context={projectRoot:t.root,chatId:t.chat.id,agentId:'coder'},sibling={...context,chatId:'sibling'};
  const otherRoot=path.join(t.temp,'another-project');await mkdir(otherRoot);const otherProject={...context,projectRoot:otherRoot};
  const shell=(command:string)=>({name:'run_shell',args:{command}});
  expect((await t.tools.execute(context,shell('export REMOVAL_TEST=first'))).ok).toBe(true);
  expect((await t.tools.execute(sibling,shell('export REMOVAL_TEST=sibling'))).ok).toBe(true);
  expect((await t.tools.execute(otherProject,shell('export REMOVAL_TEST=other-project'))).ok).toBe(true);
  await expect(t.removal.project(t.project.id,{mode:'disk',canonicalPath:t.root,confirmationToken:'invalid'})).rejects.toThrow('confirmation');
  expect((await t.tools.execute(context,shell('printf "%s" "$REMOVAL_TEST"'))).output).toContain('first');
  await t.tools.removeScope(t.root,t.chat.id,()=>{});
  expect((await t.tools.execute(context,shell('printf "%s" "${REMOVAL_TEST-fresh}"'))).output).toContain('fresh');
  expect((await t.tools.execute(sibling,shell('printf "%s" "$REMOVAL_TEST"'))).output).toContain('sibling');
  const running=t.tools.execute(context,shell('sleep 0.2'));expect(()=>t.tools.removeScope(t.root,undefined,()=>{})).toThrow('pending');await running;
  expect((await t.tools.execute(context,shell('sleep 30 &'))).ok).toBe(true);
  expect(()=>t.tools.removeScope(t.root,undefined,()=>{})).toThrow('background');
  expect((await t.tools.execute(context,shell('kill $(jobs -pr); wait'))).ok).toBe(true);
  await t.tools.removeScope(t.root,undefined,()=>{});
  expect((await t.tools.execute(otherProject,shell('printf "%s" "$REMOVAL_TEST"'))).output).toContain('other-project');
});

it('shell pool refuses a queued command before a native PTY is created',async()=>{
  const t=await fixture(),pool=new ShellPool({maxOutputBytes:1000,maxQueue:4,maxSessions:4,defaultTimeoutMs:1000,maxTimeoutMs:1000,shell:'/bin/bash'});
  const command=pool.run({projectRoot:t.root,chatId:t.chat.id,agentId:'coder'},'true').catch(()=>undefined);
  expect(()=>pool.removeScope(t.root,t.chat.id)).toThrow('pending');await command;pool.removeScope(t.root,t.chat.id);await pool.dispose();
});
