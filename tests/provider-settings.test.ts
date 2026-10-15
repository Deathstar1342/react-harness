import { nativeReply, actionOf, nativeState } from './native-fixture.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, linkSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { loadBackendConfig, ProviderSettings, ProviderSettingsFile } from '../server/provider-settings.js';
import { Store } from '../server/store.js';
import { ReloadingProvider } from '../server/provider.js';
import { createApp } from '../server/app.js';
import { createManagedHooks } from '../server/context.js';
import { roleInstructions } from '../server/prompts.js';
import { childEnvironment } from '../server/tools/shell.js';
import type { ModelProvider, ToolService } from '../shared/types.js';
import type { Frame, RunState } from '../server/runtime.js';
import { Runtime } from '../server/runtime.js';
import * as fs from 'node:fs';

vi.mock('node:fs',async original=>{
  const actual=await original<typeof import('node:fs')>();
  return {...actual,renameSync:vi.fn(actual.renameSync)};
});

const cleanup: (()=>void|Promise<void>)[]=[];
afterEach(async()=>{vi.unstubAllGlobals();vi.mocked(fs.renameSync).mockClear();for(const fn of cleanup.splice(0).reverse())await fn();});
const baseline = "# local settings\r\nSTARK_BASE_URL=http://127.0.0.1/v1\r\nSTARK_API_KEY='old-test-key'\r\nARCHITECT_MODEL=old-a\r\nCODER_MODEL=old-c\r\nCRITIC_MODEL=old-r\r\nOTHER='two\nlines # preserved'\r\n";
function fixture(text=baseline, overrides:NodeJS.ProcessEnv={}) {
  const root=mkdtempSync(path.join(tmpdir(),'harness-m14-'));
  cleanup.push(()=>{if(path.dirname(root)!==path.resolve(tmpdir()) || !path.basename(root).startsWith('harness-m14-'))throw Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});});
  const filename=path.join(root,'.env');writeFileSync(filename,text);
  const file=new ProviderSettingsFile(filename,overrides), config=file.config();
  config.dataDir=path.join(root,'data');config.workspaceRoot=path.join(root,'workspace');
  const store=new Store(path.join(root,'state.sqlite'));cleanup.push(()=>store.close());
  const project=store.createProject('Fixture',root);
  const legacy=store.createChat(project.id,'Legacy','review');
  const settings=new ProviderSettings(config,store,file);
  return {root,filename,file,config,store,project,legacy,settings};
}
it('roundtrips dotenv values, preserves unrelated bytes and backfills before defaults change across restart',()=>{
  const t=fixture();
  const before=t.config.models;
  const result=t.settings.update({models:{architect:'new # a',coder:'new=c',critic:'new:r'},apiKey:'rotated # = " key'});
  expect(result.apiKeyConfigured).toBe(true);expect(JSON.stringify(result)).not.toContain('rotated');
  expect(t.store.chatModels(t.legacy.id)).toEqual(before);
  before.architect='mutated-object';expect(t.store.chatModels(t.legacy.id).architect).toBe('old-a');
  const next=t.store.createChat(t.project.id,'New','review');expect(next.models).toEqual(result.models);
  const text=readFileSync(t.filename,'utf8');expect(text).toContain("OTHER='two\nlines # preserved'\r\n");expect(text).toContain('# local settings\r\n');
  const restarted=loadBackendConfig({},t.filename);expect(restarted.config.models).toEqual(result.models);expect(restarted.config.apiKey).toBe('rotated # = " key');
  const reopened=new Store(path.join(t.root,'state.sqlite'));cleanup.push(()=>reopened.close());reopened.initializeModels(restarted.config.models);
  expect(reopened.chatModels(t.legacy.id).architect).toBe('old-a');expect(reopened.chatModels(next.id)).toEqual(result.models);
  t.settings.update({apiKey:''});expect(t.config.apiKey).toBe('');expect(parse(readFileSync(t.filename)).STARK_API_KEY).toBe('');
});
it('initializes a blank endpoint/key atomically and preserves endpoint paths across restart',()=>{
  const t=fixture('');
  t.settings.update({baseUrl:'http://localhost:45123/custom/v1/',apiKey:'new-key'});
  expect(t.settings.get().baseUrl).toBe('http://localhost:45123/custom/v1');
  expect(loadBackendConfig({},t.filename).config).toMatchObject({baseUrl:'http://localhost:45123/custom/v1',apiKey:'new-key'});
});
it('never forwards an existing key to a changed endpoint, including an initially empty endpoint',()=>{
  for(const text of [baseline,"STARK_API_KEY=old-test-key\n"]) {
    const t=fixture(text);expect(()=>t.settings.update({baseUrl:'https://new.example/v1'})).toThrow('explicit replacement');
    expect(t.config.apiKey).toBe('old-test-key');expect(readFileSync(t.filename,'utf8')).toBe(text);
    t.settings.update({baseUrl:'https://new.example/v1',apiKey:''});expect(t.config.apiKey).toBe('');
    t.settings.update({baseUrl:'https://another.example:444/api/v1',apiKey:'replacement'});expect(t.config.baseUrl).toBe('https://another.example:444/api/v1');
  }
});
it('accepts equivalent endpoint spelling without key rotation but refuses process-locked changes',()=>{
  const t=fixture();t.settings.update({baseUrl:'http://127.0.0.1:80/v1/'});expect(t.config.apiKey).toBe('old-test-key');
  const locked=fixture(baseline,{STARK_API_KEY:'external'});
  expect(()=>locked.settings.update({baseUrl:'https://new.example/v1',apiKey:'replacement'})).toThrow('process environment');expect(locked.config.baseUrl).toBe('http://127.0.0.1/v1');
  const endpoint=fixture(baseline,{STARK_BASE_URL:''});expect(endpoint.settings.get().lockedFields).toContain('baseUrl');
  expect(()=>endpoint.settings.update({baseUrl:'https://new.example',apiKey:''})).toThrow('process environment');
});
it.each(['https://user:pass@example.com','https://example.com?secret=x','https://example.com#fragment','file:///etc/passwd','https://example.com\nSTARK_API_KEY=bad',' https://example.com','https://example.com/\tpath','https://example.com/'+ 'a'.repeat(2050)])('rejects unsafe endpoint %s without writes',baseUrl=>{
  const t=fixture();expect(()=>t.settings.update({baseUrl,apiKey:''})).toThrow();expect(readFileSync(t.filename,'utf8')).toBe(baseline);
});
it('replaces duplicate managed declarations, export/colon syntax and multiline values without affecting other parsed settings',()=>{
  const t=fixture(baseline+"export ARCHITECT_MODEL: 'old\nmultiline'\r\nARCHITECT_MODEL=last # comment\r\nTAIL=keep\r\n");
  t.settings.update({models:{architect:'new'},apiKey:'back\\nslash'});
  expect(parse(readFileSync(t.filename))).toMatchObject({ARCHITECT_MODEL:'new',STARK_API_KEY:'back\\nslash',TAIL:'keep',OTHER:'two\nlines # preserved'});
  expect(readFileSync(t.filename,'utf8').match(/ARCHITECT_MODEL/g)).toHaveLength(1);
});
it.each([{apiKey:'x\nOTHER=bad'},{models:{coder:'x\rBAD=yes'}},{apiKey:'x\0y'},{models:{architect:' '}},{models:{critic:'x'},streaming:false},{apiKey:'x'.repeat(1025)}])('validates whole patch without partial publication: %j',patch=>{
  const t=fixture();const config=structuredClone(t.config);expect(()=>t.settings.update(patch)).toThrow();expect(t.config).toEqual(config);expect(readFileSync(t.filename,'utf8')).toBe(baseline);
});
it('preserves process precedence, locks even empty external overrides and rejects mixed patches atomically',()=>{
  const t=fixture(baseline,{ARCHITECT_MODEL:'external',STARK_API_KEY:''});
  expect(t.settings.get()).toMatchObject({models:{architect:'external'},apiKeyConfigured:false,lockedFields:['architect','apiKey']});
  expect(()=>t.settings.update({models:{coder:'new-c'},apiKey:'new'})).toThrow('process environment');expect(t.config.models.coder).toBe('old-c');expect(readFileSync(t.filename,'utf8')).toBe(baseline);
  expect(()=>loadBackendConfig({DOTENV_CONFIG_PATH:'elsewhere'},t.filename)).toThrow('unsupported');
});
it('rejects stale external edits, hardlinks and missing-file substitutions without changing active config',()=>{
  const t=fixture();writeFileSync(t.filename,baseline+'EXTERNAL=1\n');expect(()=>t.settings.update({apiKey:'new'})).toThrow('changed outside');expect(t.config.apiKey).toBe('old-test-key');
  writeFileSync(t.filename,baseline);linkSync(t.filename,path.join(t.root,'alias'));expect(()=>t.settings.update({apiKey:'new'})).toThrow('unlinked');expect(readFileSync(t.filename,'utf8')).toBe(baseline);
  unlinkSync(path.join(t.root,'alias'));unlinkSync(t.filename);expect(()=>t.settings.update({apiKey:'new'})).toThrow('changed outside');expect(t.config.apiKey).toBe('old-test-key');
});
it.skipIf(process.platform==='win32')('refuses symbolic .env targets and writes private files on Linux',()=>{
  const t=fixture();t.settings.update({apiKey:'new'});expect(lstatSync(t.filename).mode & 0o777).toBe(0o600);
  const target=path.join(t.root,'target');writeFileSync(target,baseline);unlinkSync(t.filename);symlinkSync(target,t.filename);
  expect(()=>new ProviderSettingsFile(t.filename,{})).toThrow('regular');expect(readFileSync(target,'utf8')).toBe(baseline);
});
it('creates an absent .env and leaves key unchanged when omitted',()=>{
  const t=fixture();unlinkSync(t.filename);const file=new ProviderSettingsFile(t.filename,{}),config=file.config();const settings=new ProviderSettings(config,t.store,file);
  settings.update({models:{coder:'manual-id'}});expect(parse(readFileSync(t.filename))).toEqual({CODER_MODEL:'manual-id'});expect(config.apiKey).toBe('');
});
it('failed atomic replacement leaves file, active key and new-chat defaults unchanged; retry succeeds',()=>{
  const t=fixture();vi.mocked(fs.renameSync).mockImplementationOnce(()=>{throw Object.assign(Error('fixture failure'),{code:'EACCES'});});
  expect(()=>t.settings.update({models:{architect:'new-a'},apiKey:'replacement'})).toThrow('active settings were not changed');
  expect(readFileSync(t.filename,'utf8')).toBe(baseline);expect(t.config.apiKey).toBe('old-test-key');expect(t.store.createChat(t.project.id,'After failure','review').models?.architect).toBe('old-a');
  expect(fs.readdirSync(t.root).filter(name=>name.endsWith('.tmp'))).toEqual([]);
  t.settings.update({models:{architect:'new-a'}});expect(t.config.apiKey).toBe('old-test-key');expect(t.store.createChat(t.project.id,'After retry','review').models?.architect).toBe('new-a');
});
it('preserves a UTF-8 BOM and rejects unsupported quote combinations without partial writes',()=>{
  const t=fixture('\uFEFF'+baseline);t.settings.update({models:{architect:'new-a'}});expect(readFileSync(t.filename,'utf8').startsWith('\uFEFF')).toBe(true);
  const before=readFileSync(t.filename,'utf8');expect(()=>t.settings.update({apiKey:'all\'"`quotes'})).toThrow('represented safely');expect(readFileSync(t.filename,'utf8')).toBe(before);expect(t.config.apiKey).toBe('old-test-key');
});
it('external changes after rename are never adopted as the baseline and block subsequent saves',()=>{
  const t=fixture();const refresh=t.file.refreshIdentity.bind(t.file);
  vi.spyOn(t.file,'refreshIdentity').mockImplementationOnce(()=>{writeFileSync(t.filename,baseline.replace('old-a','external-a'));refresh();});
  expect(()=>t.settings.update({models:{architect:'saved-a'},apiKey:'saved-key'})).toThrow('Settings saved and active');
  expect(t.config.models.architect).toBe('saved-a');expect(t.config.apiKey).toBe('saved-key');
  expect(t.store.createChat(t.project.id,'After external edit','review').models?.architect).toBe('saved-a');
  const edited=readFileSync(t.filename,'utf8');expect(parse(edited).ARCHITECT_MODEL).toBe('external-a');
  expect(()=>t.settings.update({models:{coder:'later-c'}})).toThrow('restart');expect(readFileSync(t.filename,'utf8')).toBe(edited);
});
it('captures in-flight credentials through retries and clears only subsequent requests; delayed errors contain neither key',async()=>{
  let apiKey='old-secret',baseUrl='http://127.0.0.1/old';const auth:string[]=[],urls:string[]=[];
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  const fetch=vi.fn(async(url:unknown,init?:RequestInit)=>{urls.push(String(url));auth.push((init!.headers as Record<string,string>).Authorization);if(auth.length===1){await pending;return new Response('',{status:503,headers:{'retry-after':'0'}});}return new Response(JSON.stringify({data:[{id:'a'}]}));});vi.stubGlobal('fetch',fetch);
  const provider=new ReloadingProvider(()=>({baseUrl,apiKey,maxRetries:1}));const old=provider.models();apiKey='new-secret';baseUrl='http://127.0.0.1/new';release();expect(await old).toEqual(['a']);await provider.models();
  expect(auth).toEqual(['Bearer old-secret','Bearer old-secret','Bearer new-secret']);
  expect(urls).toEqual(['http://127.0.0.1/old/models','http://127.0.0.1/old/models','http://127.0.0.1/new/models']);
  let reject!:(error:Error)=>void;fetch.mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}));const late=provider.models();apiKey='';reject(new Error('new-secret old-secret'));await expect(late).rejects.toThrow('Provider transport failed');await expect(provider.models()).rejects.toThrow('Configure');expect(fetch).toHaveBeenCalledTimes(4);
  expect(childEnvironment({STARK_API_KEY:'new-secret',ARCHITECT_MODEL:'model',PATH:'safe'})).not.toHaveProperty('STARK_API_KEY');
});

const tools:ToolService={inspect:async()=>({effect:'read',risk:'routine',description:''}),execute:async()=>({ok:true,output:''}),read:async(_root,path)=>({path,content:'',hash:null}),list:async()=>[],save:async()=>({path:'x',content:'',hash:null}),setDirty:()=>{},dispose:async()=>{}};
it('API persists settings with local-origin guards, snapshots new chats, and never exposes keys',async()=>{
  const t=fixture();const provider:ModelProvider={models:async()=>['old-a'],complete:async()=>({text:'unused'})};
  const {app}=await createApp({config:t.config,store:t.store,provider,providerSettingsFile:t.file,tools,hooks:{instructions:roleInstructions}});cleanup.push(()=>app.close());
  expect(t.store.chatModels(t.legacy.id).architect).toBe('old-a');
  for(const [headers,status] of [[{origin:'https://attacker.example'},403],[{'content-type':'text/plain'},415]] as const)expect((await app.inject({method:'PATCH',url:'/api/provider-settings',headers,payload:'{}'})).statusCode).toBe(status);
  const response=await app.inject({method:'PATCH',url:'/api/provider-settings',payload:{models:{architect:'new-a'},apiKey:'new-test-key'}});expect(response.statusCode).toBe(200);expect(response.body).not.toContain('test-key');
  const next=(await app.inject({method:'POST',url:`/api/projects/${t.project.id}/chats`,payload:{}})).json();expect(next.models.architect).toBe('new-a');expect(t.store.chatModels(t.legacy.id).architect).toBe('old-a');
  for(const url of ['/api/provider-settings','/api/settings',`/api/chats/${t.legacy.id}`])expect((await app.inject(url)).body).not.toMatch(/old-test-key|new-test-key/);
});
it('rotation during a normal chat request preserves the old request and sanitizes its delayed failure in durable events',async()=>{
  const t=fixture();t.config.streaming=false;
  const requests:{model:string;authorization:string}[]=[];
  let reject!:(error:Error)=>void;
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{
    requests.push({model:JSON.parse(String(init!.body)).model,authorization:(init!.headers as Record<string,string>).Authorization});
    if(requests.length===1)return new Promise<Response>((_,r)=>{reject=r;});
    return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'Completed'},finish_reason:'stop'}]}));
  }));
  const provider=new ReloadingProvider(()=>({...t.config,maxRetries:0}));
  const {app,runtime}=await createApp({config:t.config,store:t.store,provider,providerSettingsFile:t.file,tools,hooks:createManagedHooks(provider,t.store,t.config)});cleanup.push(()=>app.close());
  await runtime.submit(t.legacy.id,'First request');await vi.waitFor(()=>expect(requests).toHaveLength(1));
  expect((await app.inject({method:'PATCH',url:'/api/provider-settings',payload:{apiKey:'rotated-test-key',models:{architect:'new-a'}}})).statusCode).toBe(200);
  reject(Error('old-test-key rotated-test-key leaked upstream'));
  await vi.waitFor(()=>expect(t.store.chat(t.legacy.id).status).toBe('error'));
  const detail=(await app.inject(`/api/chats/${t.legacy.id}`)).body;
  expect(detail).toContain('Provider transport failed');expect(detail).not.toMatch(/old-test-key|rotated-test-key/);
  await runtime.control(t.legacy.id,'resume');await vi.waitFor(()=>expect(t.store.chat(t.legacy.id).status).toBe('idle'));
  expect(requests).toEqual([{model:'old-a',authorization:'Bearer old-test-key'},{model:'old-a',authorization:'Bearer rotated-test-key'}]);
  const fresh=t.store.createChat(t.project.id,'After rotation','review');await runtime.submit(fresh.id,'New request');await vi.waitFor(()=>expect(t.store.chat(fresh.id).status).toBe('idle'));
  expect(requests.at(-1)).toEqual({model:'new-a',authorization:'Bearer rotated-test-key'});
});
it.each(['architect','coder','critic'] as const)('compaction for %s retains saved models after changing defaults',async role=>{
  const t=fixture();t.config.contextLimits={architect:30000,coder:30000,critic:30000};t.config.maxOutputTokens=256;
  const calls:string[]=[];const provider:ModelProvider={models:async()=>[],complete:async input=>{calls.push(input.model);return {text:'Summary of observed history.',finishReason:'stop'};}};
  const hooks=createManagedHooks(provider,t.store,t.config);t.settings.update({models:{architect:'new-a',coder:'new-c',critic:'new-r'}});
  const frame:Frame={id:'frame',role,objective:'task',repairs:0,messages:[{role:'user',content:'Task'},...Array.from({length:20},(_,i)=>({role:'assistant' as const,content:`History ${i}: ${'x'.repeat(1500)}`}))]};
  const state:RunState={frames:[frame],steering:[],generation:0,steps:0,planOnly:false};t.store.setState(`run:${t.legacy.id}`,nativeState(state));
  await hooks.prepareMessages!(t.legacy.id,frame,[{role:'system',content:'Policy'},...frame.messages],new AbortController().signal);
  expect(calls.length).toBeGreaterThan(0);expect(new Set(calls)).toEqual(new Set([t.store.chatModels(t.legacy.id)[role]]));
});

it.each(['architect','coder','critic'] as const)('resumed %s frames use durable assignments after restart',async role=>{
  const t=fixture();t.store.initializeModels(t.config.models);
  const frame:Frame={id:'resumed-frame',role,objective:'Continue',repairs:0,messages:[{role:'user',content:'Continue safely'}]};
  t.store.setState(`run:${t.legacy.id}`,nativeState({frames:[frame],steering:[],generation:0,steps:0,planOnly:false} satisfies RunState));
  t.store.updateChat(t.legacy.id,{status:'paused'});t.settings.update({models:{architect:'new-a',coder:'new-c',critic:'new-r'}});
  const config=loadBackendConfig({},t.filename).config;
  const reopened=new Store(path.join(t.root,'state.sqlite'));cleanup.push(()=>reopened.close());
  const calls:string[]=[];const provider:ModelProvider={models:async()=>[],complete:async input=>{calls.push(input.model);return nativeReply('submit_completion',{summary:'Done'},'Done');}};
  const runtime=new Runtime(reopened,provider,tools,config,{instructions:roleInstructions});cleanup.push(()=>runtime.close());
  await runtime.control(t.legacy.id,'resume');
  await vi.waitFor(()=>expect(calls.length).toBeGreaterThan(0));
  expect(calls[0]).toBe(t.store.chatModels(t.legacy.id)[role]);
});
