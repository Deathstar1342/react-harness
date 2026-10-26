import {afterEach,expect,it,vi} from 'vitest';
import * as filesystem from 'node:fs/promises';
vi.mock('node:fs/promises',async original=>({...await original<typeof import('node:fs/promises')>()}));
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,symlink,link,chmod,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {Runtime} from '../server/runtime.js';
import {WorkspaceTools} from '../server/tools/index.js';
import {WorkspaceFiles} from '../server/tools/files.js';
import {Checkpoints} from '../server/checkpoints.js';
import {checkpointLimits,checkpointTree} from '../server/checkpoint-files.js';
import {reserveMutation} from '../server/tools/mutations.js';
import {readConfig} from '../server/config.js';
import {hash} from '../server/tools/paths.js';
import {createApp} from '../server/app.js';
import {createGoal,goalOf} from '../server/goals.js';
import type {CheckpointPreview} from '../shared/types.js';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
 const base=await mkdtemp(path.join(await realpath(tmpdir()),'m34-')),workspace=path.join(base,'workspace'),root=path.join(workspace,randomUUID());await mkdir(root,{recursive:true});
 const filename=path.join(base,'state.sqlite');let store=new Store(filename),tools=new WorkspaceTools();
 const config=readConfig({HARNESS_DATA_DIR:path.join(base,'data'),HARNESS_WORKSPACE_ROOT:workspace});
 const provider={models:async()=>[],complete:async()=>{throw new Error('Checkpoints never call providers');}};
 let runtime=new Runtime(store,provider,tools,config,{instructions:()=>''}),service=new Checkpoints(store,runtime);
 const project=store.createProject('Checkpoint fixture',root),chat=store.createChat(project.id,'Boundary','review');store.initializePlanning();
 const write=async(file:string,text:string)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);};
 const capture=(label='Boundary')=>service.capture(project.id,{chatId:chat.id,label});
 const preview=(id:string)=>service.preview(project.id,id,{chatId:chat.id});
 const restore=(p:CheckpointPreview)=>service.restore(project.id,p.checkpoint.id,{chatId:chat.id,previewToken:p.previewToken,revision:p.revision,confirmation:'restore-files'});
 const close=async()=>{await runtime.close();await tools.dispose();store.close();};
 const reopen=async()=>{await close();store=new Store(filename);store.recover();tools=new WorkspaceTools();runtime=new Runtime(store,provider,tools,config,{instructions:()=>''});service=new Checkpoints(store,runtime);};
 cleanup.push(async()=>{await close();if(path.dirname(base)!==await realpath(tmpdir())||!path.basename(base).startsWith('m34-'))throw new Error('Fixture cleanup identity mismatch');await rm(base,{recursive:true,force:true});});
 return {base,root,filename,config,project,chat,write,capture,preview,restore,reopen,get store(){return store;},get runtime(){return runtime;},get tools(){return tools;},get service(){return service;}};
}
it.each([false,true])('actual disk capture and coherent add/delete/move/multifile restore; Git=%s',async git=>{
 const t=await fixture();if(git){execFileSync('git',['init','--quiet'],{cwd:t.root});}
 await t.write('a.ts','before a');await t.write('nested/b.ts','before b');await t.write('move.ts','move me');
 await t.write('AGENTS.md','Guidance');await t.write('.abyssus/skills/example/SKILL.md','Safe source workflow');await t.write('.gitignore','node_modules/');
 await t.write('.env','PRIVATE_SENTINEL');await t.write('node_modules/dep/index.js','excluded');await t.write('state.sqlite','private');await t.write('.abyssus/verification.json','private');
 if(git)execFileSync('git',['add','--','a.ts'],{cwd:t.root});
 const index=git?await readFile(path.join(t.root,'.git/index')):null;
 const checkpoint=await t.capture();expect(checkpoint.files).toBe(6);expect(checkpoint.excludedCount).toBe(git?5:4);expect(JSON.stringify(t.service.list(t.project.id))).not.toContain('PRIVATE_SENTINEL');
 await t.write('a.ts','changed');await rm(path.join(t.root,'nested/b.ts'));await rename(path.join(t.root,'move.ts'),path.join(t.root,'moved.ts'));await t.write('extra.ts','remove');await t.write('.env','keep private');
 const p=await t.preview(checkpoint.id);expect(p.changes.map(c=>c.kind).sort()).toEqual(['add','add','modify','remove','remove']);
 const restored=await t.restore(p);expect(restored.status).toBe('done');
 expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('before a');expect(await readFile(path.join(t.root,'nested/b.ts'),'utf8')).toBe('before b');
 expect(await readFile(path.join(t.root,'move.ts'),'utf8')).toBe('move me');await expect(lstat(path.join(t.root,'moved.ts'))).rejects.toMatchObject({code:'ENOENT'});
 expect(await readFile(path.join(t.root,'.env'),'utf8')).toBe('keep private');if(git)expect(await readFile(path.join(t.root,'.git/index'))).toEqual(index);
 expect(t.store.fileChanges(t.project.id).every(c=>c.status==='confirmed')).toBe(true);expect(t.store.fileChanges(t.project.id)).toHaveLength(5);
 await expect(t.restore(p)).rejects.toThrow(/consumed/);await t.reopen();expect(t.service.list(t.project.id).restores[0].status).toBe('done');expect((await t.preview(checkpoint.id)).changes).toEqual([]);
});
it('fresh previews preserve manual edits and bind project, chat, app revisions and expiry',async()=>{
 const t=await fixture();await t.write('a.ts','before');const checkpoint=await t.capture();await t.write('a.ts','after');
 let p=await t.preview(checkpoint.id);await t.write('a.ts','later human edit');await expect(t.restore(p)).rejects.toThrow(/stale/);expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('later human edit');
 p=await t.preview(checkpoint.id);t.store.updateChat(t.chat.id,{modeVersion:7});await expect(t.restore(p)).rejects.toThrow(/stale/);
 p=await t.preview(checkpoint.id);vi.spyOn(Date,'now').mockReturnValue(Date.now()+300001);await expect(t.restore(p)).rejects.toThrow(/expired/);vi.restoreAllMocks();
 p=await t.preview(checkpoint.id);const other=t.store.createProject('other',path.join(t.base,'other'));await expect(t.service.restore(other.id,checkpoint.id,{chatId:t.chat.id,previewToken:p.previewToken,revision:p.revision,confirmation:'restore-files'})).rejects.toThrow(/preview/);
 await t.restore(await t.preview(checkpoint.id));expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('before');
});
it('rejects dirty editors, project reservations, active chats, pending actions/install and unknown effects',async()=>{
 const t=await fixture();await t.write('a.ts','a');t.tools.setDirty(t.root,'a.ts','human',true);await expect(t.capture()).rejects.toThrow(/unsaved/);t.tools.setDirty(t.root,'a.ts','human',false);
 const reserved=reserveMutation(t.root);await expect(t.capture()).rejects.toThrow(/mutation/);reserved.release();
 t.store.updateChat(t.chat.id,{status:'running'});await expect(t.capture()).rejects.toThrow(/Pause/);t.store.updateChat(t.chat.id,{status:'paused'});
 t.store.setState(`transfer:reservation:${t.project.id}`,{claim:'uncertain'});await expect(t.capture()).rejects.toThrow(/export/i);t.store.setState(`transfer:reservation:${t.project.id}`,null);
 const snapshot={path:'a.ts',content:'a',hash:hash('a')};t.store.recordFileChange({id:randomUUID(),projectId:t.project.id,chatId:t.chat.id,path:'a.ts',createdAt:'',status:'unknown',before:snapshot,after:snapshot});await expect(t.capture()).rejects.toThrow(/uncertain/);
});
it('rejects all eligible unsafe links and binary/oversized source without publishing a partial checkpoint',async()=>{
 const t=await fixture();await t.write('a.ts','a');await link(path.join(t.root,'a.ts'),path.join(t.root,'hard.ts'));await expect(t.capture()).rejects.toThrow(/linked/);expect(t.service.list(t.project.id).items).toHaveLength(0);await rm(path.join(t.root,'hard.ts'));
 await mkdir(path.join(t.root,'linked'));await symlink(path.join(t.root,'linked'),path.join(t.root,'alias'),process.platform==='win32'?'junction':'dir');await expect(t.capture()).rejects.toThrow(/linked/);await rm(path.join(t.root,'alias'),{recursive:process.platform==='win32'});
 await t.write('binary.ts','a\0b');await expect(t.capture()).rejects.toThrow(/Binary/);await rm(path.join(t.root,'binary.ts'));
 await t.write('huge.ts','x'.repeat(checkpointLimits.fileBytes+1));await expect(t.capture()).rejects.toThrow(/size limit/);expect(t.service.list(t.project.id).items).toHaveLength(0);
});
it('checkpoint integrity, root identity and topology changes fail before effects',async()=>{
 const t=await fixture();await t.write('a.ts','before');const checkpoint=await t.capture();await t.write('a.ts','after');
 const stored=t.store.getState<any>(`checkpoint:v1:${checkpoint.id}`,null);stored.files[0].content='CORRUPT';t.store.setState(`checkpoint:v1:${checkpoint.id}`,stored);await expect(t.preview(checkpoint.id)).rejects.toThrow(/integrity/);expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('after');
});
it('intent COMMIT failure leaves files untouched and no claiming journal',async()=>{
 const t=await fixture();await t.write('a.ts','before');const checkpoint=await t.capture();await t.write('a.ts','after');const p=await t.preview(checkpoint.id);
 const original=t.store.db.exec.bind(t.store.db);let veto=true;vi.spyOn(t.store.db,'exec').mockImplementation(sql=>{if(sql==='COMMIT'&&veto){veto=false;throw new Error('intent COMMIT veto');}return original(sql);});
 await expect(t.restore(p)).rejects.toThrow(/COMMIT veto/);expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('after');expect(t.service.list(t.project.id).restores).toEqual([]);
 vi.restoreAllMocks();await t.restore(p);expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('before');
});
it('partial filesystem restore remains uncertain through disk restart and cannot mutate, remove or replay',async()=>{
 const t=await fixture();await t.write('a.ts','a-before');await t.write('b.ts','b-before');const checkpoint=await t.capture();await t.write('a.ts','a-after');await t.write('b.ts','b-after');const p=await t.preview(checkpoint.id);
 const original=WorkspaceFiles.prototype.restoreCheckpoint;let writes=0;vi.spyOn(WorkspaceFiles.prototype,'restoreCheckpoint').mockImplementation(async function(this:WorkspaceFiles,...args){if(++writes===2)throw new Error('fixture file effect failure');return original.apply(this,args);});
 await expect(t.restore(p)).rejects.toThrow(/uncertain/);expect(t.service.list(t.project.id).restores[0].status).toBe('uncertain');expect(t.store.fileChanges(t.project.id).every(c=>c.status==='unknown')).toBe(true);
 const partial=[await readFile(path.join(t.root,'a.ts'),'utf8'),await readFile(path.join(t.root,'b.ts'),'utf8')];expect(partial).toContain('a-before');expect(partial).toContain('b-after');
 vi.restoreAllMocks();await t.reopen();expect([await readFile(path.join(t.root,'a.ts'),'utf8'),await readFile(path.join(t.root,'b.ts'),'utf8')]).toEqual(partial);
 await expect(t.tools.save(t.root,'a.ts','unsafe',hash('a-before'))).rejects.toThrow(/uncertain/);await expect(t.capture()).rejects.toThrow(/uncertain/);await expect(t.restore(p)).rejects.toThrow(/consumed|expired/);expect(()=>t.store.deleteChat(t.chat.id)).toThrow(/uncertain/);expect(()=>t.store.deleteProject(t.project.id)).toThrow(/uncertain/);
});
it('lost final COMMIT retains uncertainty after effects, and failed uncertainty persistence retains claiming barrier',async()=>{
 const t=await fixture();await t.write('a.ts','before');const checkpoint=await t.capture();await t.write('a.ts','after');const p=await t.preview(checkpoint.id);
 const original=t.store.db.exec.bind(t.store.db);let intent=false;
 vi.spyOn(t.store.db,'exec').mockImplementation(sql=>{if(sql==='COMMIT'){if(intent)throw new Error('persistent COMMIT loss');intent=true;}return original(sql);});
 await expect(t.restore(p)).rejects.toThrow(/COMMIT loss/);expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('before');
 vi.restoreAllMocks();expect(t.service.list(t.project.id).restores[0].status).toBe('claiming');expect(()=>t.store.assertCheckpointSafe(t.project.id)).toThrow(/uncertain/);
 await t.reopen();expect(t.service.list(t.project.id).restores[0].status).toBe('uncertain');expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('before');
});
it('retention evicts oldest unreferenced captures, pins previews and restores, and refuses rather than discarding evidence',async()=>{
 const t=await fixture();await t.write('a.ts','before');const first=await t.capture('first');await t.write('a.ts','after');await t.restore(await t.preview(first.id));
 for(let i=0;i<8;i++)await t.capture('capture '+i);const list=t.service.list(t.project.id);expect(list.items).toHaveLength(8);expect(list.items.some(c=>c.id===first.id)).toBe(true);expect(list.items.some(c=>c.label==='capture 0')).toBe(false);
 for(const item of list.items)await t.preview(item.id);await expect(t.capture('blocked')).rejects.toThrow(/quota/);expect(t.service.list(t.project.id).items).toHaveLength(8);
});
it('restoration invalidates actual goal evidence and preserves conversation history',async()=>{
 const t=await fixture();const human=t.store.message(t.chat.id,'user','Original human task');createGoal(t.store,t.chat.id,{objective:'Task',acceptanceCriteria:['Review source']},human.id);
 await t.write('AGENTS.md','before');const checkpoint=await t.capture();await t.write('AGENTS.md','after');await t.restore(await t.preview(checkpoint.id));
 expect(goalOf(t.store,t.chat.id)?.reason).toMatch(/Workspace/);expect(t.store.messages(t.chat.id).some(m=>m.id===human.id)).toBe(true);expect(t.store.events(t.chat.id).some(e=>e.type==='file_changed')).toBe(true);
});
it('fixed binary asset policy excludes bytes without silently skipping unsupported source',async()=>{
 const t=await fixture();await t.write('src.ts','source');await t.write('icon.svg','<svg/>');await writeFile(path.join(t.root,'photo.png'),Buffer.from([0,255,254,0]));
 const checkpoint=await t.capture();expect(checkpoint.files).toBe(2);expect(checkpoint.excluded).toContainEqual({path:'photo.png',reason:'Binary asset/archive/font/media'});
 await writeFile(path.join(t.root,'unsupported.dat'),Buffer.from([0,255]));await expect(t.capture()).rejects.toThrow(/UTF-8|Binary/);expect(t.service.list(t.project.id).items).toHaveLength(1);
});
it('managed workspace membership is mandatory even for portable direct execution',async()=>{
 const t=await fixture();const outside=path.join(t.base,'original');await mkdir(outside);const project=t.store.createProject('Original',outside),chat=t.store.createChat(project.id,'Original','review');
 await expect(t.service.capture(project.id,{chatId:chat.id,label:'No original access'})).rejects.toThrow(/Only managed/);expect(t.service.list(project.id).items).toEqual([]);
});
it('rejects Unicode aliases and replaced root identity before restoring',async()=>{
 const t=await fixture();await t.write('café.ts','one');await t.write('cafe\u0301.ts','two');await expect(t.capture()).rejects.toThrow(/alias/);await rm(path.join(t.root,'cafe\u0301.ts'));
 const checkpoint=await t.capture();await rename(t.root,t.root+'-retained');await mkdir(t.root);await t.write('café.ts','replacement');
 await expect(t.preview(checkpoint.id)).rejects.toThrow(/replaced project/);expect(await readFile(path.join(t.root,'café.ts'),'utf8')).toBe('replacement');
});
it('refuses file/directory topology replacement before claiming',async()=>{
 const t=await fixture();await t.write('a','file');const checkpoint=await t.capture();await rm(path.join(t.root,'a'));await mkdir(path.join(t.root,'a'));await t.write('a/nested.ts','later');
 await expect(t.preview(checkpoint.id)).rejects.toThrow(/topology/);expect(t.service.list(t.project.id).restores).toHaveLength(0);expect(await readFile(path.join(t.root,'a/nested.ts'),'utf8')).toBe('later');
});
it('worker cleanup confirmation gates capture and excludes concurrent tool/editor writers',async()=>{
 const t=await fixture();await t.write('a.ts','source');let release!:()=>void,enter!:()=>void;const held=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);
 const shells=(t.tools as unknown as {shells:{removeScope:(root:string)=>Promise<void>}}).shells;
 vi.spyOn(shells,'removeScope').mockImplementation(async()=>{enter();await held;});
 const capture=t.capture();await entered;expect(t.service.list(t.project.id).items).toHaveLength(0);
 await expect(t.tools.save(t.root,'a.ts','other',hash('source'))).rejects.toThrow(/mutation/);expect(()=>t.tools.setDirty(t.root,'a.ts','editor',true)).toThrow(/cleanup/);
 release();expect((await capture).files).toBe(1);
});
it('dirty leases introduced after preview block before intent without consuming current content',async()=>{
 const t=await fixture();await t.write('a.ts','before');const checkpoint=await t.capture();await t.write('a.ts','after');const p=await t.preview(checkpoint.id);
 t.tools.setDirty(t.root,'a.ts','human',true);await expect(t.restore(p)).rejects.toThrow(/unsaved/);expect(t.service.list(t.project.id).restores).toEqual([]);expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('after');
 t.tools.setDirty(t.root,'a.ts','human',false);await t.restore(p);
});
it.each(['duplicate','oversize','unknown-key','wrong-root'])('bounded strict checkpoint observation fails closed for %s state',async variant=>{
 const t=await fixture();await t.write('a.ts','source');const checkpoint=await t.capture();const key=variant==='oversize'?`checkpoint:v1:${checkpoint.id}`:`checkpoint-meta:v1:${checkpoint.id}`,record=t.store.getState<any>(key,null);
 if(variant==='duplicate')t.store.db.prepare('UPDATE state SET data=? WHERE key=?').run(JSON.stringify(record).replace('{','{"id":"duplicate",'),key);
 if(variant==='oversize')t.store.db.prepare('UPDATE state SET data=? WHERE key=?').run(' '.repeat(12*1024*1024+1),key);
 if(variant==='unknown-key')t.store.setState(key,{...record,unexpected:true});
 if(variant==='wrong-root')t.store.setState(key,{...record,root:path.join(t.base,'other')});
 expect(()=>t.service.list(t.project.id)).toThrow(/integrity|bounded/);await expect(t.tools.save(t.root,'a.ts','unsafe',hash('source'))).rejects.toThrow(/integrity|bounded/);expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('source');
});
it('row caps and oversized current run context reject before unbounded legacy admission parsing',async()=>{
 const t=await fixture();await t.write('a.ts','source');t.store.setState(`run:${t.chat.id}`,{frames:[],flood:'x'.repeat(2*1024*1024)});await expect(t.capture()).rejects.toThrow(/bounded/);t.store.db.prepare('DELETE FROM state WHERE key=?').run(`run:${t.chat.id}`);
 const checkpoint=await t.capture(),raw=t.store.db.prepare('SELECT data FROM state WHERE key=?').get(`checkpoint:v1:${checkpoint.id}`)!.data;
 for(let i=0;i<64;i++)t.store.db.prepare('INSERT INTO state VALUES (?,?)').run(`checkpoint:v1:extra-${i}`,raw);
 expect(()=>t.service.list(t.project.id)).toThrow(/bounded/);
});
it('unknown restore reference survives as a fail-closed mutation/removal/restart barrier',async()=>{
 const t=await fixture();await t.write('a.ts','before');const checkpoint=await t.capture();await t.write('a.ts','after');await t.restore(await t.preview(checkpoint.id));
 const restore=t.service.list(t.project.id).restores[0],key=`checkpoint-restore:v1:${restore.id}`,journal=t.store.getState<any>(key,null);t.store.setState(key,{...journal,checkpointId:randomUUID()});
 expect(()=>t.service.list(t.project.id)).toThrow(/integrity/);expect(()=>t.store.assertCheckpointSafe(t.project.id)).toThrow(/integrity/);expect(()=>t.store.deleteProject(t.project.id)).toThrow(/integrity/);expect(()=>t.store.recover()).toThrow(/integrity/);
});
it('explicit capture does not bless a passed goal or produce execution authority',async()=>{
 const t=await fixture();await t.write('a.ts','source');const human=t.store.message(t.chat.id,'user','Original human task');createGoal(t.store,t.chat.id,{objective:'Task',acceptanceCriteria:['Observed code']},human.id);
 const before=JSON.stringify(goalOf(t.store,t.chat.id)),messages=t.store.messages(t.chat.id),events=t.store.events(t.chat.id);await t.capture();
 expect(JSON.stringify(goalOf(t.store,t.chat.id))).toBe(before);expect(t.store.messages(t.chat.id)).toEqual(messages);expect(t.store.events(t.chat.id)).toEqual(events);
});
it('authenticated strict HTTP capture/preview/restore never exposes private manifests or invokes models',async()=>{
 const t=await fixture(),{TransportAuth}=await import('../server/transport-auth.js'),auth=new TransportAuth('checkpoint-api');
 const provider={models:async()=>[],complete:vi.fn(async()=>{throw new Error('No model authority');})};
 const built=await createApp({config:t.config,store:t.store,tools:t.tools,provider,hooks:{instructions:()=>''},transportAuth:auth});cleanup.push(()=>built.app.close());
 const url=`/api/projects/${t.project.id}/checkpoints`,headers={authorization:`Bearer ${auth.token}`};
 await t.write('a.ts','before');await t.write('.env','PRIVATE_PROVIDER_SENTINEL');
 expect((await built.app.inject({method:'GET',url})).statusCode).toBe(401);
 expect((await built.app.inject({method:'POST',url,headers,payload:{chatId:t.chat.id,label:'Boundary',projectRoot:t.base}})).statusCode).toBe(400);
 const captured=await built.app.inject({method:'POST',url,headers,payload:{chatId:t.chat.id,label:'Human API boundary'}});expect(captured.statusCode).toBe(201);const checkpoint=captured.json();
 const listed=await built.app.inject({method:'GET',url,headers});expect(listed.statusCode).toBe(200);expect(listed.body).not.toContain('PRIVATE_PROVIDER_SENTINEL');expect(listed.body).not.toContain('"content"');expect(listed.body).not.toContain('rootIdentity');
 await t.write('a.ts','after');let response=await built.app.inject({method:'POST',url:`${url}/${checkpoint.id}/preview`,headers,payload:{chatId:t.chat.id}});expect(response.statusCode).toBe(200);const preview=response.json();expect(preview.changes[0].diff).toContain('+before');
 response=await built.app.inject({method:'POST',url:`${url}/${checkpoint.id}/restore`,headers,payload:{chatId:t.chat.id,previewToken:preview.previewToken,revision:preview.revision,confirmation:'model-said-ok'}});expect(response.statusCode).toBe(400);expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('after');
 response=await built.app.inject({method:'POST',url:`${url}/${checkpoint.id}/restore`,headers,payload:{chatId:t.chat.id,previewToken:preview.previewToken,revision:preview.revision,confirmation:'restore-files'}});expect(response.statusCode).toBe(200);expect(response.json().status).toBe('done');expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('before');expect(provider.complete).not.toHaveBeenCalled();
});
it('selected project workflow and AGENTS restoration invalidates instruction evidence without replacing human provenance',async()=>{
 const t=await fixture();const workflow=(body:string)=>`---\nname: "verify"\ndescription: "Verify source"\nreferences: []\n---\n${body}\n`;
 await t.write('AGENTS.md','Original guidance');await t.write('.abyssus/skills/verify/SKILL.md',workflow('Original workflow'));const checkpoint=await t.capture();
 await t.write('AGENTS.md','Changed guidance');await t.write('.abyssus/skills/verify/SKILL.md',workflow('Changed workflow'));
 const doc=await t.runtime.skills.files(t.chat.id).load('project','verify');t.runtime.skills.select(t.chat.id,doc,0,'human');
 const human=t.store.message(t.chat.id,'user','Keep this human assignment');await t.restore(await t.preview(checkpoint.id));
 expect(t.runtime.skills.selection(t.chat.id).stale).toMatch(/Selected workflow files changed/);expect(t.runtime.skills.selection(t.chat.id).sources[0].source).toBe('human');expect(t.store.messages(t.chat.id).find(m=>m.id===human.id)?.role).toBe('user');expect(t.store.chat(t.chat.id).status).toBe('paused');
});
it('lazy metadata and exact per-file claims have a bounded read budget across eight checkpoints and 32 files',async()=>{
 const t=await fixture(),count=32,content=(i:number,after=false)=>`${after?'after':'before'} ${i}\n`+Array(64).fill('x'.repeat(120)).join('\n')+'\n';
 for(let i=0;i<count;i++)await t.write(`source-${i}.ts`,content(i));
 let checkpoint:Awaited<ReturnType<typeof t.capture>>|undefined;for(let i=0;i<8;i++)checkpoint=await t.capture(`Boundary ${i}`);
 const original=t.store.db.prepare.bind(t.store.db);let bytes=0,largest=0;
 vi.spyOn(t.store.db,'prepare').mockImplementation(sql=>{const statement=original(sql);return new Proxy(statement,{get(target,field){const value=Reflect.get(target,field,target);if(typeof value!=='function')return value;return (...args:unknown[])=>{const result=Reflect.apply(value,target,args);if(field==='get'||field==='all'){for(const row of Array.isArray(result)?result:[result])if(row&&typeof row==='object')for(const item of Object.values(row))if(typeof item==='string'){const size=Buffer.byteLength(item);bytes+=size;largest=Math.max(largest,size);}}return result;};}});});
 t.service.list(t.project.id);expect(bytes).toBeLessThan(128000);expect(largest).toBeLessThan(32768);const listBytes=bytes;
 bytes=0;await t.tools.save(t.root,'source-0.ts',content(0,true),hash(content(0)));expect(bytes).toBeLessThan(128000);const ordinarySaveBytes=bytes;
 for(let i=1;i<count;i++)await t.write(`source-${i}.ts`,content(i,true));const p=await t.preview(checkpoint!.id);expect(p.changes).toHaveLength(count);
 bytes=0;largest=0;const start=performance.now();await t.restore(p);const elapsedMs=performance.now()-start;
 expect(bytes).toBeLessThan(4*1024*1024);expect(largest).toBeLessThan(1024*1024);expect(elapsedMs).toBeLessThan(10000);
 const receipt={checkpoints:8,files:count,listSQLReturnedBytes:listBytes,ordinarySaveSQLReturnedBytes:ordinarySaveBytes,restoreSQLReturnedBytes:bytes,largestReturnedString:largest,elapsedMs:Math.round(elapsedMs)};if(process.env.M34_READ_BUDGET_RECEIPT)await writeFile(process.env.M34_READ_BUDGET_RECEIPT,JSON.stringify(receipt,null,2));console.info('M34 actual disk read budget',JSON.stringify(receipt));
});
it('whole capture rejects file count and aggregate content quotas without publishing partial source',async()=>{
 const t=await fixture();for(let i=0;i<513;i++)await t.write(`file-${i}.ts`,'x');await expect(t.capture()).rejects.toThrow(/file count/);expect(t.service.list(t.project.id).items).toEqual([]);
 for(let i=0;i<513;i++)await rm(path.join(t.root,`file-${i}.ts`));for(let i=0;i<33;i++)await t.write(`large-${i}.ts`,'x'.repeat(checkpointLimits.fileBytes));await expect(t.capture()).rejects.toThrow(/byte limit/);expect(t.service.list(t.project.id).items).toEqual([]);
});
it('post-COMMIT notification loss preserves durable done and cannot replay the restored set',async()=>{
 const t=await fixture();await t.write('a.ts','before');const checkpoint=await t.capture();await t.write('a.ts','after');const p=await t.preview(checkpoint.id);
 let delivered=0;t.store.changes.once('event',()=>{delivered++;throw new Error('Lost notification after COMMIT');});expect((await t.restore(p)).status).toBe('done');expect(delivered).toBe(1);
 expect(t.service.list(t.project.id).restores[0].status).toBe('done');expect(t.store.fileChanges(t.project.id)[0].status).toBe('confirmed');expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('before');await expect(t.restore(p)).rejects.toThrow(/consumed/);expect(()=>t.store.assertCheckpointSafe(t.project.id)).not.toThrow();
});
it.runIf(process.platform!=='win32')('restores Unix executable permission evidence as part of the reviewed file set',async()=>{
 const t=await fixture();await t.write('bin/cli.sh','#!/bin/sh\nexit 0\n');await chmod(path.join(t.root,'bin/cli.sh'),0o750);const checkpoint=await t.capture();await chmod(path.join(t.root,'bin/cli.sh'),0o640);
 const p=await t.preview(checkpoint.id);expect(p.changes[0].diff).toContain('Mode 640 → 750');await t.restore(p);expect((await lstat(path.join(t.root,'bin/cli.sh'))).mode&0o777).toBe(0o750);
});

it('lost reply after successful final COMMIT keeps durable done and does not repeat file effects',async()=>{
 const t=await fixture();await t.write('a.ts','before');const checkpoint=await t.capture();await t.write('a.ts','after');const p=await t.preview(checkpoint.id);const original=t.store.transaction.bind(t.store);let lost=false;
 vi.spyOn(t.store,'transaction').mockImplementation(fn=>{const result=original(fn);if(!lost&&t.store.db.prepare("SELECT 1 FROM state WHERE key LIKE 'checkpoint-restore:v1:%' AND json_extract(data,'$.status')='done'").get()){lost=true;throw new Error('Lost successful COMMIT reply');}return result;});
 await expect(t.restore(p)).rejects.toThrow(/completed.*notification/);expect(lost).toBe(true);expect(t.service.list(t.project.id).restores[0].status).toBe('done');expect(t.store.fileChanges(t.project.id)[0].status).toBe('confirmed');await expect(t.restore(p)).rejects.toThrow(/consumed/);expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('before');
});

it('long exclusion paths remain byte-bounded metadata and cannot publish an unreadable header',async()=>{
 const t=await fixture(),directory=Array(4).fill('folder-'+('x'.repeat(70))).join('/');for(let i=0;i<120;i++)await t.write(`${directory}/.env-${'x'.repeat(190)}-${i}`,'PRIVATE_EXCLUDED');
 const checkpoint=await t.capture();expect(checkpoint.files).toBe(0);expect(checkpoint.excludedCount).toBe(120);expect(checkpoint.excluded.length).toBeLessThan(100);expect(Buffer.byteLength(JSON.stringify(checkpoint.excluded))).toBeLessThan(16100);expect(t.service.list(t.project.id).items[0].id).toBe(checkpoint.id);expect(()=>t.store.assertCheckpointSafe(t.project.id)).not.toThrow();
});
it('root replacement between durable intent and file effect never overwrites the replacement directory',async()=>{
 const t=await fixture();await t.write('a.ts','before');const checkpoint=await t.capture();await t.write('a.ts','after');const preview=await t.preview(checkpoint.id),retained=t.root+'-retained';
 expect(path.dirname(retained)).toBe(path.resolve(t.config.workspaceRoot));const original=WorkspaceFiles.prototype.restoreCheckpoint;let swapped=false;
 vi.spyOn(WorkspaceFiles.prototype,'restoreCheckpoint').mockImplementation(async function(this:WorkspaceFiles,...args){if(!swapped){swapped=true;await rename(t.root,retained);await mkdir(t.root);await writeFile(path.join(t.root,'a.ts'),'after');}return original.apply(this,args);});
 await expect(t.restore(preview)).rejects.toThrow(/uncertain/);expect(swapped).toBe(true);expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('after');expect(await readFile(path.join(retained,'a.ts'),'utf8')).toBe('after');expect(t.service.list(t.project.id).restores[0].status).toBe('uncertain');
});
it('root replacement between two file effects preserves completed old-root edits and the entire replacement',async()=>{
 const t=await fixture();await t.write('a.ts','before a');await t.write('b.ts','before b');const checkpoint=await t.capture();await t.write('a.ts','after a');await t.write('b.ts','after b');const preview=await t.preview(checkpoint.id),retained=t.root+'-retained';expect(path.dirname(retained)).toBe(path.resolve(t.config.workspaceRoot));
 const original=WorkspaceFiles.prototype.restoreCheckpoint;let files=0;vi.spyOn(WorkspaceFiles.prototype,'restoreCheckpoint').mockImplementation(async function(this:WorkspaceFiles,...args){if(++files===2){await rename(t.root,retained);await mkdir(t.root);await writeFile(path.join(t.root,'a.ts'),'after a');await writeFile(path.join(t.root,'b.ts'),'after b');}return original.apply(this,args);});
 await expect(t.restore(preview)).rejects.toThrow(/uncertain/);expect(await readFile(path.join(retained,'a.ts'),'utf8')).toBe('before a');expect(await readFile(path.join(retained,'b.ts'),'utf8')).toBe('after b');expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('after a');expect(await readFile(path.join(t.root,'b.ts'),'utf8')).toBe('after b');expect(t.service.list(t.project.id).restores[0].status).toBe('uncertain');
});
it('root replacement after content save cannot authorize chmod of an identical-byte replacement',async()=>{
 const t=await fixture();await t.write('a.ts','before');await chmod(path.join(t.root,'a.ts'),0o444);const checkpoint=await t.capture();await chmod(path.join(t.root,'a.ts'),0o666);await t.write('a.ts','after');const preview=await t.preview(checkpoint.id),retained=t.root+'-retained';expect(path.dirname(retained)).toBe(path.resolve(t.config.workspaceRoot));
 const original=WorkspaceFiles.prototype.save;let swapped=false;vi.spyOn(WorkspaceFiles.prototype,'save').mockImplementation(async function(this:WorkspaceFiles,...args){const result=await original.apply(this,args);if(!swapped){swapped=true;await rename(t.root,retained);await mkdir(t.root);await writeFile(path.join(t.root,'a.ts'),'before');}return result;});
 await expect(t.restore(preview)).rejects.toThrow(/uncertain/);expect(swapped).toBe(true);expect((await lstat(path.join(t.root,'a.ts'))).mode&0o200).not.toBe(0);expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('before');expect(await readFile(path.join(retained,'a.ts'),'utf8')).toBe('before');expect(t.service.list(t.project.id).restores[0].status).toBe('uncertain');
});

it('root substitution after save entry cannot create or write temporary files in the replacement',async()=>{
 const t=await fixture();await t.write('a.ts','before');const checkpoint=await t.capture();await t.write('a.ts','after');const preview=await t.preview(checkpoint.id),retained=t.root+'-retained';expect(path.dirname(retained)).toBe(path.resolve(t.config.workspaceRoot));
 const original=WorkspaceFiles.prototype.read,open=filesystem.open;let swapped=false,temporaryOpens=0;
 vi.spyOn(filesystem,'open').mockImplementation(async(...args:Parameters<typeof filesystem.open>)=>{if(swapped&&String(args[0]).startsWith(t.root+path.sep)&&String(args[0]).includes('.rh-write-'))temporaryOpens++;return open(...args);});
 vi.spyOn(WorkspaceFiles.prototype,'read').mockImplementation(async function(this:WorkspaceFiles,...args){if(!swapped&&t.store.db.prepare("SELECT 1 FROM state WHERE key LIKE 'checkpoint-restore:v1:%' AND json_extract(data,'$.status')='claiming'").get()){swapped=true;await rename(t.root,retained);await mkdir(t.root);await writeFile(path.join(t.root,'a.ts'),'after');}return original.apply(this,args);});
 await expect(t.restore(preview)).rejects.toThrow(/uncertain/);expect(swapped).toBe(true);expect(temporaryOpens).toBe(0);expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('after');expect(t.service.list(t.project.id).restores[0].status).toBe('uncertain');
});
it('root substitution after first parent creation cannot create deeper parents or temporary writes in a replacement',async()=>{
 const t=await fixture();await t.write('new/deep/a.ts','before');const checkpoint=await t.capture();const parent=path.join(t.root,'new');expect(path.dirname(parent)).toBe(t.root);await rm(parent,{recursive:true});const preview=await t.preview(checkpoint.id),retained=t.root+'-retained';expect(path.dirname(retained)).toBe(path.resolve(t.config.workspaceRoot));
 const original=filesystem.mkdir;let swapped=false;
 vi.spyOn(filesystem,'mkdir').mockImplementation(async(...args:Parameters<typeof filesystem.mkdir>)=>{const result=await original(...args);if(!swapped&&String(args[0])===parent){swapped=true;await rename(t.root,retained);await original(t.root);await original(parent);}return result;});
 await expect(t.restore(preview)).rejects.toThrow(/uncertain/);expect(swapped).toBe(true);await expect(lstat(path.join(parent,'deep'))).rejects.toMatchObject({code:'ENOENT'});expect(await filesystem.readdir(parent)).toEqual([]);expect((await lstat(path.join(retained,'new'))).isDirectory()).toBe(true);expect(t.service.list(t.project.id).restores[0].status).toBe('uncertain');
});
it('cleanup after temp open never unlinks a same-name replacement sentinel beneath a changed root',async()=>{
 const t=await fixture();await t.write('a.ts','before');const checkpoint=await t.capture();await t.write('a.ts','after');const preview=await t.preview(checkpoint.id),retained=t.root+'-retained';expect(path.dirname(retained)).toBe(path.resolve(t.config.workspaceRoot));
 const original=filesystem.open;let swapped=false,sentinel='';vi.spyOn(filesystem,'open').mockImplementation(async(...args:Parameters<typeof filesystem.open>)=>{let handle=await original(...args);if(!swapped&&args[1]==='wx'&&String(args[0]).includes('.rh-write-')){sentinel=String(args[0]);const identity=await handle.stat({bigint:true});
  try{await rename(t.root,retained);}catch(error){
   // Windows may forbid renaming a directory with an open child. Reopen the
   // SAME observed fixture inode after the injected move; no fake handle/data.
   if(process.platform!=='win32'||!['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??'')){await handle.close();throw error;}
   await handle.close();await rename(t.root,retained);handle=await original(path.join(retained,path.basename(sentinel)),'r+');const reopened=await handle.stat({bigint:true});expect([reopened.dev,reopened.ino]).toEqual([identity.dev,identity.ino]);
  }
  swapped=true;await mkdir(t.root);await writeFile(path.join(t.root,'a.ts'),'after');await writeFile(sentinel,'REPLACEMENT_SENTINEL');}return handle;});
 await expect(t.restore(preview)).rejects.toThrow(/uncertain/);expect(swapped).toBe(true);expect(await readFile(sentinel,'utf8')).toBe('REPLACEMENT_SENTINEL');expect(await readFile(path.join(t.root,'a.ts'),'utf8')).toBe('after');expect(await readFile(path.join(retained,'a.ts'),'utf8')).toBe('after');expect(t.service.list(t.project.id).restores[0].status).toBe('uncertain');
});
