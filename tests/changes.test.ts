import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.js';
import { Runtime, type RunState } from '../server/runtime.js';
import { Changes, boundedDiff } from '../server/changes.js';
import { WorkspaceTools } from '../server/tools/index.js';
import { WorkspaceFiles } from '../server/tools/files.js';
import { hash } from '../server/tools/paths.js';
import { readConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import type { AgentResponse, ChangePreview, FileChange, ModelProvider } from '../shared/types.js';

const cleanup: (()=>Promise<void>)[] = [];
afterEach(async()=>{for (const fn of cleanup.splice(0).reverse()) await fn();});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(),'rh-changes-'));
  const projectRoot = path.join(root,'project');await mkdir(projectRoot);
  const filename = path.join(root,'state.sqlite');
  const store = new Store(filename);
  const tools = new WorkspaceTools();
  const config = readConfig({STARK_BASE_URL:'http://localhost/v1',STARK_API_KEY:'test'});
  const provider: ModelProvider = {models:async()=>[],complete:async()=>({text:JSON.stringify({version:1,type:'final',message:'Done'})})};
  const hooks = {parse:(text:string)=>JSON.parse(text) as AgentResponse,instructions:()=>''};
  const runtime = new Runtime(store,provider,tools,config,hooks);
  const changes = new Changes(store,tools,runtime);
  const project = store.createProject('Test',projectRoot);
  const chat = store.createChat(project.id,'Test','autonomous');
  cleanup.push(async()=>{await runtime.close();await tools.dispose();store.close();await rm(root,{recursive:true,force:true});});
  async function record(before: string|null = 'old\n', after='new\n', file='file.txt', status:FileChange['status']='confirmed') {
    await mkdir(path.dirname(path.join(projectRoot,file)),{recursive:true});
    await writeFile(path.join(projectRoot,file),after);
    const change: FileChange = {id:randomUUID(),projectId:project.id,chatId:chat.id,path:file,createdAt:new Date().toISOString(),status,before:{path:file,content:before ?? '',hash:before === null ? null : hash(before)},after:{path:file,content:after,hash:hash(after)}};
    store.recordFileChange(change);return change;
  }
  async function undo(change:FileChange, preview?:ChangePreview) {
    const p=preview ?? await changes.preview(project.id,change.id);
    return changes.undo(project.id,change.id,p.expectedHash!,p.previewToken!);
  }
  const git = (...args:string[])=>execFileSync('git',['--literal-pathspecs',...args],{cwd:projectRoot,encoding:'utf8',windowsHide:true});
  return {root,projectRoot,filename,store,tools,config,provider,hooks,runtime,changes,project,chat,record,undo,git};
}

it('restores a write, preserves staged and unrelated work, and notifies every chat',async()=>{
  const t=await setup();t.git('init');await writeFile(path.join(t.projectRoot,'file.txt'),'staged\n');t.git('add','file.txt');
  const index=t.git('show',':file.txt');
  const other=t.store.createChat(t.project.id,'Other','review');
  t.store.updateChat(other.id,{status:'paused'});
  const state:RunState={frames:[{id:'coder',role:'coder',messages:[],repairs:0,pending:{id:'pending',stage:'prepared',approvalId:'approval',action:{name:'write_file',args:{}}}}],steering:[],generation:0,steps:0,planOnly:false};
  t.store.setState(`run:${other.id}`,state);
  t.store.approval({id:'approval',chatId:other.id,agentId:'coder',action:{name:'write_file',args:{}},inspection:{effect:'write',risk:'routine',description:''},status:'approved',createdAt:''});
  const c=await t.record();await writeFile(path.join(t.projectRoot,'manual.txt'),'untouched');
  await t.undo(c);
  expect(await readFile(path.join(t.projectRoot,c.path),'utf8')).toBe('old\n');
  expect(t.git('show',':file.txt')).toBe(index);
  expect(await readFile(path.join(t.projectRoot,'manual.txt'),'utf8')).toBe('untouched');
  expect(t.store.getApproval('approval').status).toBe('stale');
  expect(t.store.chat(other.id).status).toBe('paused');
  expect(t.store.getState<RunState>(`run:${other.id}`,state).steering).toHaveLength(1);
  for (const id of [t.chat.id,other.id]) expect(t.store.events(id).some(e=>e.type==='file_changed' && (e.data as {source:string}).source==='undo')).toBe(true);
});

it('removes only the newly created file and keeps its parent and siblings',async()=>{
  const t=await setup(),c=await t.record(null,'new','folder/new.txt');
  await writeFile(path.join(t.projectRoot,'folder/other.txt'),'manual');await t.undo(c);
  await expect(readFile(path.join(t.projectRoot,c.path))).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile(path.join(t.projectRoot,'folder/other.txt'),'utf8')).toBe('manual');
});

it('dirty rejection leaves the record and preview reusable after releasing the lease',async()=>{
  const t=await setup(),c=await t.record(),p=await t.changes.preview(t.project.id,c.id);
  t.tools.setDirty(t.projectRoot,c.path,'human',true);
  await expect(t.undo(c,p)).rejects.toThrow('unsaved');
  expect(t.store.fileChange(t.project.id,c.id).status).toBe('confirmed');
  t.tools.setDirty(t.projectRoot,c.path,'human',false);await t.undo(c,p);
  expect(t.store.fileChange(t.project.id,c.id).status).toBe('undone');
});

it('rejects a stale preview and protects later saved manual changes',async()=>{
  const t=await setup(),c=await t.record(),p=await t.changes.preview(t.project.id,c.id);
  await t.tools.save(t.projectRoot,c.path,'manual',c.after.hash,'editor');
  await expect(t.undo(c,p)).rejects.toThrow('changed');
  expect(t.store.fileChange(t.project.id,c.id).status).toBe('confirmed');
  expect((await t.changes.preview(t.project.id,c.id)).previewToken).toBeUndefined();
  expect(await readFile(path.join(t.projectRoot,c.path),'utf8')).toBe('manual');
});

it('rejects duplicate and concurrent undo even with two valid previews',async()=>{
  const t=await setup(),c=await t.record();
  const [a,b]=await Promise.all([t.changes.preview(t.project.id,c.id),t.changes.preview(t.project.id,c.id)]);
  const results=await Promise.allSettled([t.undo(c,a),t.undo(c,b)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  await expect(t.undo(c,b)).rejects.toThrow();
  expect(t.store.fileChange(t.project.id,c.id).status).toBe('undone');
});

it('persists the undo claim before mutation and never retries uncertain outcomes after restart',async()=>{
  const t=await setup(),c=await t.record();
  const restore=t.tools.restore.bind(t.tools);
  t.tools.restore=async(...args)=>{
    const result=await restore(...args.slice(0,4) as [string,string,FileChange['before'],string],()=>{
      args[4]();expect(t.store.fileChange(t.project.id,c.id).status).toBe('undoing');
      const disk=new Store(t.filename);expect(disk.fileChange(t.project.id,c.id).status).toBe('undoing');disk.close();
    });
    expect(result.content).toBe('old\n');throw new Error('lost response after mutation');
  };
  await expect(t.undo(c)).rejects.toThrow('uncertain');
  expect(t.store.fileChange(t.project.id,c.id).status).toBe('unknown');
  const disk=new Store(t.filename);disk.recover();expect(disk.fileChange(t.project.id,c.id).status).toBe('unknown');disk.close();
  expect((await t.changes.preview(t.project.id,c.id)).previewToken).toBeUndefined();
});

it('crashed recording and undoing claims recover as unknown and history is bounded',async()=>{
  const t=await setup();
  const recording=await t.record('old','new','file.txt','recording');
  const undoing=await t.record('old','new','other.txt','undoing');
  t.store.recover();
  expect(t.store.fileChange(t.project.id,recording.id).status).toBe('unknown');
  expect(t.store.fileChange(t.project.id,undoing.id).status).toBe('unknown');
  for(let i=0;i<101;i++) t.store.recordFileChange({...recording,id:randomUUID(),status:'confirmed'});
  t.git('init');const list=await t.changes.list(t.project.id);
  expect(list.history).toHaveLength(100);expect(list.historyTruncated).toBe(true);
  expect(JSON.stringify(list.history)).not.toContain('"before"');
  expect(()=>boundedDiff('x','a'.repeat(200001),'')).toThrow('limit');
});

it('binds preview tokens to project, record, version and expiration',async()=>{
  const t=await setup(),a=await t.record(),b=await t.record(null,'other','other.txt');
  const p=await t.changes.preview(t.project.id,a.id);
  const other=t.store.createProject('Other',path.join(t.root,'other'));
  await expect(t.changes.preview(other.id,a.id)).rejects.toMatchObject({statusCode:404});
  await expect(t.changes.undo(t.project.id,b.id,b.after.hash!,p.previewToken!)).rejects.toThrow('preview');
  await expect(t.changes.undo(t.project.id,a.id,hash('wrong'),p.previewToken!)).rejects.toThrow('preview');
  const spy=vi.spyOn(Date,'now').mockReturnValue(Date.now()+360_000);
  try {await expect(t.undo(a,p)).rejects.toThrow('expired');} finally {spy.mockRestore();}
});

it('checks protected paths, hard links and new-file deletion boundaries at execution',async()=>{
  const t=await setup(),c=await t.record(null);
  const p=await t.changes.preview(t.project.id,c.id);
  await link(path.join(t.projectRoot,c.path),path.join(t.projectRoot,'linked.txt'));
  await expect(t.undo(c,p)).rejects.toThrow(/linked/);
  expect(t.store.fileChange(t.project.id,c.id).status).toBe('confirmed');
  await expect(t.tools.restore(t.projectRoot,'.env',c.before,c.after.hash!,()=>{throw new Error('must not claim');})).rejects.toThrow('Protected');
});

it.skipIf(process.platform==='win32')('rejects symlink replacement before new-file undo',async()=>{
  const t=await setup(),c=await t.record(null),p=await t.changes.preview(t.project.id,c.id);
  await rm(path.join(t.projectRoot,c.path));await writeFile(path.join(t.root,'outside'),'outside');
  await symlink(path.join(t.root,'outside'),path.join(t.projectRoot,c.path));
  await expect(t.undo(c,p)).rejects.toThrow('Symbolic');
  expect(await readFile(path.join(t.root,'outside'),'utf8')).toBe('outside');
});

it('guards real active promises even after status says paused, and rejects launches during undo',async()=>{
  const t=await setup(),c=await t.record();
  let release!:()=>void,entered!:()=>void;
  const started=new Promise<void>(r=>{entered=r;});
  t.provider.complete=async()=>{entered();await new Promise<void>(r=>{release=r;});return {text:'{}'};};
  await t.runtime.submit(t.chat.id,'work');await started;
  const stopping=t.runtime.control(t.chat.id,'pause');
  expect(t.store.chat(t.chat.id).status).toBe('paused');
  await expect(t.undo(c)).rejects.toThrow('Pause all');release();await stopping;
  await t.runtime.exclusiveProjectEdit(t.project.id,async()=>{
    await expect(t.runtime.submit(t.chat.id,'new')).rejects.toThrow('undo is in progress');
    await expect(t.runtime.control(t.chat.id,'resume')).rejects.toThrow('undo is in progress');
  });
  await t.undo(c);
});

it('reviews literal renamed, deleted and nested untracked paths without attributing them to agents',async()=>{
  const t=await setup();t.git('init');
  await writeFile(path.join(t.projectRoot,'delete.txt'),'delete');await writeFile(path.join(t.projectRoot,'rename.txt'),'rename');
  t.git('add','.');t.git('-c','user.name=Test','-c','user.email=test@example.com','commit','-m','base');
  t.git('mv','rename.txt','renamed.txt');await rm(path.join(t.projectRoot,'delete.txt'));
  await mkdir(path.join(t.projectRoot,'nested'));await writeFile(path.join(t.projectRoot,'nested/[.]env'),'literal safe text');
  await writeFile(path.join(t.projectRoot,'.env'),'never disclose');
  const list=await t.changes.list(t.project.id);
  expect(list.history).toEqual([]);expect(list.git.some(e=>e.originalPath==='rename.txt')).toBe(true);
  expect(list.git.some(e=>e.path==='nested/[.]env')).toBe(true);expect(list.git.some(e=>e.path==='.env')).toBe(false);
  expect((await t.changes.diff(t.project.id,'nested/[.]env')).diff).toContain('literal safe text');
  expect((await t.changes.diff(t.project.id,'delete.txt')).diff).toContain('-delete');
  expect((await t.changes.diff(t.project.id,'renamed.txt')).diff).toContain('+rename');
});

it('API requires an exact preview, rejects cross-origin/replacement content, and keeps project ownership',async()=>{
  const t=await setup(),c=await t.record();
  const {app}=await createApp(t);
  try {
    const base=`/api/projects/${t.project.id}/change/${c.id}`;
    const p=(await app.inject(base)).json<ChangePreview>();
    const payload={expectedHash:p.expectedHash,previewToken:p.previewToken};
    expect((await app.inject({method:'POST',url:base+'/undo',payload:{...payload,content:'client replacement'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:base+'/undo',headers:{origin:'https://evil.example'},payload})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:base+'/undo',payload})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:base+'/undo',payload})).statusCode).toBe(409);
    expect(await readFile(path.join(t.projectRoot,c.path),'utf8')).toBe('old\n');
  } finally {await app.close();}
});

it('runtime records successful writes exactly once, retains the before snapshot before dispatch and survives done replay',async()=>{
  const t=await setup();await writeFile(path.join(t.projectRoot,'file.txt'),'original');
  const pending={id:randomUUID(),stage:'prepared' as const,instructionsHash:null,action:{name:'write_file',args:{path:'file.txt',content:'agent',baseHash:hash('original')}}};
  const state:RunState={frames:[{id:'coder',role:'coder',messages:[],repairs:0,pending}],instructionsHash:null,steering:[],steps:0,generation:0,planOnly:false};
  t.store.setState(`run:${t.chat.id}`,state);
  const execute=t.tools.execute.bind(t.tools);let calls=0;
  t.tools.execute=async(ctx,action)=>{
    calls++;
    const saved=t.store.fileChange(t.project.id,pending.id);
    expect(saved.status).toBe('recording');expect(saved.before.content).toBe('original');
    expect(t.store.getState<RunState>(`run:${t.chat.id}`,state).frames[0].pending?.stage).toBe('executing');
    return execute(ctx,action);
  };
  const replies=[{version:1,type:'final',message:'Done'},{version:1,type:'action',message:'',action:{name:'review_result',args:{verdict:'pass',findings:[]}}}];
  t.provider.complete=async()=>({text:JSON.stringify(replies.shift())});
  await t.runtime.control(t.chat.id,'resume');await t.runtime.wait(t.chat.id);
  const change=t.store.fileChange(t.project.id,pending.id);
  expect(change.status).toBe('confirmed');expect(change.after.content).toBe('agent');expect(calls).toBe(1);
  // Simulate restart after durable done, but before consuming its event/transcript.
  state.frames[0].pending={...pending,stage:'done',result:{ok:true,output:'Saved file.txt',data:change.after}};
  t.store.setState(`run:${t.chat.id}`,state);
  const next=new Runtime(t.store,t.provider,t.tools,t.config,t.hooks);
  await next.control(t.chat.id,'resume');await next.wait(t.chat.id);await next.close();
  expect(calls).toBe(1);expect(t.store.fileChanges(t.project.id)).toHaveLength(1);
});

it('runtime never promotes a crash after filesystem mutation to confirmed or repeats the write',async()=>{
  const t=await setup(),c=await t.record('before','after','file.txt','recording');
  const state:RunState={frames:[{id:'coder',role:'coder',messages:[],repairs:0,pending:{id:c.id,stage:'executing',action:{name:'write_file',args:{path:c.path,content:c.after.content,baseHash:c.before.hash}}}}],steering:[],generation:0,steps:0,planOnly:false};
  t.store.setState(`run:${t.chat.id}`,state);t.store.recover();
  const spy=vi.spyOn(t.tools,'execute');
  await t.runtime.control(t.chat.id,'resume');await t.runtime.wait(t.chat.id);
  expect(spy).not.toHaveBeenCalled();expect(t.store.fileChange(t.project.id,c.id).status).toBe('unknown');
  expect((await t.changes.preview(t.project.id,c.id)).previewToken).toBeUndefined();
  expect(await readFile(path.join(t.projectRoot,c.path),'utf8')).toBe('after');
});

it('runtime records a safe dirty-buffer rejection without claiming that a write occurred',async()=>{
  const t=await setup();await writeFile(path.join(t.projectRoot,'file.txt'),'old');
  t.tools.setDirty(t.projectRoot,'file.txt','human',true);
  const pending={id:randomUUID(),stage:'prepared' as const,instructionsHash:null,action:{name:'write_file',args:{path:'file.txt',content:'new',baseHash:hash('old')}}};
  const state:RunState={frames:[{id:'coder',role:'coder',messages:[],repairs:0,pending}],instructionsHash:null,steering:[],steps:0,generation:0,planOnly:false};
  t.store.setState(`run:${t.chat.id}`,state);
  await t.runtime.control(t.chat.id,'resume');await t.runtime.wait(t.chat.id);
  expect(t.store.fileChange(t.project.id,pending.id).status).toBe('rejected');
  expect(await readFile(path.join(t.projectRoot,'file.txt'),'utf8')).toBe('old');
  t.tools.setDirty(t.projectRoot,'file.txt','human',false);
});

it.each([false,true])('rechecks a lease acquired during final filesystem validation (remove=%s)',async(remove)=>{
  const t=await setup(),c=await t.record();
  const files=new WorkspaceFiles({maxFileBytes:2_000_000,maxEntries:100,maxSearchFiles:100,leaseMs:45000});
  const read=files.read.bind(files);let reads=0;let claimed=false;
  files.read=async(...args)=>{const snapshot=await read(...args);if (++reads===2) files.setDirty(t.projectRoot,c.path,'late-editor',true);return snapshot;};
  try {
    await expect(files.save(t.projectRoot,c.path,'old',c.after.hash,undefined,()=>{claimed=true;},remove)).rejects.toThrow('unsaved');
    expect(claimed).toBe(false);expect(await readFile(path.join(t.projectRoot,c.path),'utf8')).toBe(c.after.content);
  } finally {files.setDirty(t.projectRoot,c.path,'late-editor',false);}
  await files.save(t.projectRoot,c.path,'old',c.after.hash,undefined,()=>{claimed=true;},remove);
  expect(claimed).toBe(true);
  if (remove) await expect(readFile(path.join(t.projectRoot,c.path))).rejects.toMatchObject({code:'ENOENT'});
  else expect(await readFile(path.join(t.projectRoot,c.path),'utf8')).toBe('old');
});

it('rechecks M9 guidance after the new snapshot read and discards the superseded write',async()=>{
  const t=await setup();await writeFile(path.join(t.projectRoot,'file.txt'),'old');
  const pending={id:randomUUID(),stage:'prepared' as const,instructionsHash:null,action:{name:'write_file',args:{path:'file.txt',content:'new',baseHash:hash('old')}}};
  const state:RunState={frames:[{id:'coder',role:'coder',messages:[],repairs:0,pending}],instructionsHash:null,steering:[],steps:0,generation:0,planOnly:false};
  t.store.setState(`run:${t.chat.id}`,state);
  const read=t.tools.read.bind(t.tools);
  t.tools.read=async(root,file)=>{const result=await read(root,file);if(file==='file.txt') await writeFile(path.join(root,'AGENTS.md'),'Changed guidance');return result;};
  const execute=vi.spyOn(t.tools,'execute');
  await t.runtime.control(t.chat.id,'resume');await t.runtime.wait(t.chat.id);
  expect(execute).not.toHaveBeenCalled();expect(t.store.fileChanges(t.project.id)).toEqual([]);
  expect(await readFile(path.join(t.projectRoot,'file.txt'),'utf8')).toBe('old');
});
