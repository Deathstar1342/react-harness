import { nativeState } from './native-fixture.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, renameSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.js';
import { applicationHome } from '../server/locations.js';
import { prepareProfile, ProfileOwnership, lockResources } from '../server/profile.js';
import { loadBackendConfig } from '../server/provider-settings.js';

const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
function fixture() {
  const root=mkdtempSync(path.join(tmpdir(),'rh-profile-'));
  cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'install'),other=path.join(root,'other'),home=path.join(root,'home');
  mkdirSync(cwd);mkdirSync(other);
  return {root,cwd,other,home,options:{cwd,installRoot:cwd,env:{HARNESS_HOME:home,HARNESS_INIT:'1'} as NodeJS.ProcessEnv}};
}
function legacy(root:string) {
  const store=new Store(path.join(root,'.harness','state.sqlite'));
  cleanup.push(()=>store.close());
  store.initializeModels({architect:'saved-a',coder:'saved-c',critic:'saved-r'});
  const project=store.createProject('Original',path.join(root,'imported'));
  const chat=store.createChat(project.id,'Original chat','review');
  store.message(chat.id,'user','keep me');
  store.setState(`plan:${chat.id}`,{phases:[{id:'phase',steps:[{id:'step',evidence:{outcome:'failed'}}]}]});
  store.setState(`run:${chat.id}`,nativeState({frames:[{pending:{stage:'executing',id:'uncertain-action'}}]}));
  store.approval({id:'approval',chatId:chat.id,agentId:'coder',action:{name:'run_shell',args:{command:'test'}},inspection:{effect:'execute',risk:'elevated',description:'Command'},status:'approved',createdAt:new Date().toISOString()});
  store.setState('artifact:original','retained');
  store.db.prepare('INSERT INTO file_changes VALUES (?,?,?,?,?)').run('change',project.id,'unknown',JSON.stringify({chatId:chat.id}),JSON.stringify({before:'original',after:'changed'}));
  writeFileSync(path.join(root,'.env'),"STARK_API_KEY='synthetic-only'\nARCHITECT_MODEL=legacy-a\nHARNESS_WORKSPACE_ROOT=projects\nCODER_PROMPT_FILE=prompt.txt\n");
  writeFileSync(path.join(root,'.harness','artifact.txt'),'original evidence');
  return {store,project,chat};
}
async function prepared(options:Parameters<typeof prepareProfile>[0]) {const result=await prepareProfile(options);cleanup.push(()=>result.ownership.close());return result;}

it('uses a platform home independent of cwd and requires explicit first initialization',async()=>{
  const t=fixture();expect(applicationHome({XDG_DATA_HOME:t.root},'linux')).toBe(path.join(t.root,'abyssus'));
  expect(applicationHome({LOCALAPPDATA:t.root},'win32')).toBe(path.join(t.root,'abysSUS'));
  expect(()=>applicationHome({HARNESS_HOME:'relative'})).toThrow('absolute');
  await expect(prepareProfile({...t.options,env:{HARNESS_HOME:t.home}})).rejects.toThrow('HARNESS_INIT');
  const first=await prepared(t.options);first.ownership.close();
  writeFileSync(path.join(t.other,'.env'),'STARK_API_KEY=ambient-ignored');
  const second=await prepared({...t.options,cwd:t.other});
  expect(second.id).toBe(first.id);expect(loadBackendConfig(t.options.env,second.paths.configFile).config.apiKey).toBe('');
});
it('does not choose ambiguous sources or missing profiles and ignores empty legacy/example files',async()=>{
  const t=fixture();writeFileSync(path.join(t.cwd,'.env'),'STARK_API_KEY=one');writeFileSync(path.join(t.other,'.env'),'STARK_API_KEY=two');
  await expect(prepareProfile({...t.options,env:{HARNESS_HOME:t.home},installRoot:t.other})).rejects.toThrow('Select exactly one');
  await expect(prepareProfile({...t.options,env:{...t.options.env,HARNESS_LEGACY_ROOT:path.join(t.root,'missing')}})).rejects.toThrow('missing');
  const u=fixture();mkdirSync(path.join(u.cwd,'.harness'));writeFileSync(path.join(u.cwd,'.env.example'),'STARK_API_KEY=example');
  const profile=await prepared(u.options);profile.ownership.close();
  renameSync(profile.paths.profile,`${profile.paths.profile}-saved`);
  await expect(prepareProfile(u.options)).rejects.toThrow('missing');
});
it('backs up open WAL state and preserves every durable row, config, imported path and artifacts',async()=>{
  const t=fixture(),old=legacy(t.cwd);
  expect(existsSync(path.join(t.cwd,'.harness','state.sqlite-wal'))).toBe(true);
  const result=await prepared({...t.options,env:{...t.options.env,HARNESS_LEGACY_ROOT:t.cwd}});
  const next=new Store(path.join(result.paths.dataDir,'state.sqlite'));cleanup.push(()=>next.close());
  for(const table of ['projects','chats','messages','events','approvals','state','file_changes'])expect(next.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(old.store.db.prepare(`SELECT * FROM ${table}`).all());
  expect(next.project(old.project.id).path).toBe(old.project.path);
  expect(next.chat(old.chat.id).models).toEqual(old.chat.models);
  expect(readFileSync(path.join(result.paths.dataDir,'artifact.txt'),'utf8')).toBe('original evidence');
  const {config}=loadBackendConfig(t.options.env,result.paths.configFile);
  expect(config.apiKey).toBe('synthetic-only');expect(config.workspaceRoot).toBe(path.join(t.cwd,'projects'));expect(config.promptFiles.coder).toBe(path.join(t.cwd,'prompt.txt'));
  expect(JSON.stringify(result.receipt)).not.toContain('synthetic-only');
});
it('preserves a legacy explicit data override in place',async()=>{
  const t=fixture();legacy(t.cwd);writeFileSync(path.join(t.cwd,'.env'),'HARNESS_DATA_DIR=.harness\n');
  const profile=await prepared({...t.options,env:{...t.options.env,HARNESS_LEGACY_ROOT:t.cwd}});
  expect(loadBackendConfig(t.options.env,profile.paths.configFile).config.dataDir).toBe(path.join(t.cwd,'.harness'));
  expect(profile.receipt.database).toBe(false);expect(existsSync(path.join(profile.paths.dataDir,'state.sqlite'))).toBe(false);
});
it.each(['preparing','ready','published'])('recovers interruption at %s without overwriting source or replaying state',async phase=>{
  const t=fixture();const old=legacy(t.cwd);
  const options={...t.options,env:{...t.options.env,HARNESS_LEGACY_ROOT:t.cwd}};
  await expect(prepareProfile({...options,checkpoint:at=>{if(at===phase)throw new Error('injected crash');}})).rejects.toThrow('injected crash');
  if(phase!=='published') {
    await expect(prepareProfile(options)).rejects.toThrow('interrupted');
    old.store.message(old.chat.id,'user','after interrupted backup');
  }
  const profile=await prepared({...options,env:{...options.env,HARNESS_MIGRATION_RETRY:'1'}});
  expect(profile.receipt.phase).toBe('committed');
  const next=new Store(path.join(profile.paths.dataDir,'state.sqlite'));cleanup.push(()=>next.close());
  expect(next.getState(`run:${old.chat.id}`,null)).toEqual(old.store.getState(`run:${old.chat.id}`,null));
  expect(next.messages(old.chat.id).length).toBe(phase==='published'?1:2);
  if(phase!=='published')expect(readdirSync(t.home).some(name=>name.startsWith('interrupted-'))).toBe(true);
});
it('rejects an active source owner, write transaction and linked database',async()=>{
  const t=fixture(),old=legacy(t.cwd),options={...t.options,env:{...t.options.env,HARNESS_LEGACY_ROOT:t.cwd,HARNESS_MIGRATION_RETRY:'1'}};
  const owner=new ProfileOwnership(path.join(t.cwd,'.harness'));
  try{await expect(prepareProfile(options)).rejects.toThrow('owned');}finally{owner.close();}
  old.store.db.exec('BEGIN IMMEDIATE');
  try{await expect(prepareProfile(options)).rejects.toThrow('locked');}finally{old.store.db.exec('ROLLBACK');}
  const file=path.join(t.cwd,'.harness','state.sqlite');linkSync(file,`${file}.linked`);
  await expect(prepareProfile(options)).rejects.toThrow('unlinked');
});

export async function worker(mode:string,argument:string):Promise<{child:ChildProcess;message:{ready?:boolean;error?:string;address?:string}}> {
  const child=fork(fileURLToPath(new URL('./profile-worker.ts',import.meta.url)),[mode,argument],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});
  cleanup.push(async()=>{if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}});
  const [message]=await once(child,'message');return {child,message};
}
it('proves ownership contention and crash-release across real processes without removing lock files',async()=>{
  const t=fixture(),first=await worker('lock',t.home);expect(first.message.ready).toBe(true);
  const second=await worker('lock',t.home);expect(second.message.error).toContain('owned');
  const exited=once(first.child,'exit');first.child.kill('SIGKILL');await exited;
  const third=await worker('lock',t.home);expect(third.message.ready).toBe(true);
  expect(existsSync(path.join(t.home,'.backend-owner.sqlite'))).toBe(true);
});
it('locks canonical shared data/config resources deterministically and releases partial acquisitions',()=>{
  const t=fixture(),dirs=[path.join(t.root,'z'),path.join(t.root,'a')];
  const first=lockResources(dirs);try{expect(()=>lockResources(dirs.reverse())).toThrow('owned');}finally{first.close();}
  const next=lockResources(dirs);next.close();
});
it('rejects tampered published staging and missing legacy databases instead of initializing blank state',async()=>{
  const t=fixture();legacy(t.cwd);const options={...t.options,env:{...t.options.env,HARNESS_LEGACY_ROOT:t.cwd}};
  await expect(prepareProfile({...options,checkpoint:phase=>{if(phase==='published')throw new Error('crash');}})).rejects.toThrow('crash');
  writeFileSync(path.join(t.home,'profile','state','artifact.txt'),'tampered');
  await expect(prepareProfile(options)).rejects.toThrow('changed before completion');
  const u=fixture();mkdirSync(path.join(u.cwd,'.harness'));writeFileSync(path.join(u.cwd,'.harness','artifact.txt'),'without db');
  await expect(prepareProfile({...u.options,env:{...u.options.env,HARNESS_LEGACY_ROOT:u.cwd}})).rejects.toThrow('no state.sqlite');
});
