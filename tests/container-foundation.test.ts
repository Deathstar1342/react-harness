import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hostStoragePath } from '../server/container-contract.js';
import { verifyContainerStorage } from '../server/container-storage.js';
import { prepareProfile, durableWrite, privateDirectory } from '../server/profile.js';
import { Store } from '../server/store.js';
import { LinuxSandbox } from '../server/tools/sandbox.js';
import { PackageHelperClient } from '../server/package-helper.js';
import { readConfig, publicSettings } from '../server/config.js';
import { WorkspaceLocations } from '../server/workspace.js';

const cleanup:(()=>void)[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const fn of cleanup.splice(0).reverse())fn();});
async function fixture() {
  const root=realpathSync(mkdtempSync(path.join(tmpdir(),'m28-')));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'state'),workspace=path.join(root,'workspace'),id=randomUUID();privateDirectory(workspace);
  const profile=await prepareProfile({env:{HARNESS_HOME:home,HARNESS_INIT:'1'},cwd:root,installRoot:root});
  const store=new Store(path.join(profile.paths.dataDir,'state.sqlite'));
  store.setState('container:storage-id',id);store.setState('container:profile-id',profile.id);store.close();profile.ownership.close();
  for(const dir of [home,profile.paths.configFile.slice(0,-5),workspace])durableWrite(path.join(dir,'.storage-id'),`${id}\n`);
  durableWrite(path.join(home,'container-storage.json'),JSON.stringify({version:1,storageId:id,profileId:profile.id,kind:'local-bind'}));
  return {root,home,workspace,id,profile};
}
it('keeps Windows and Linux host paths explicit and rejects remote/relative/noncanonical roots',()=>{
  expect(hostStoragePath('D:\\abysSUS','win32')).toBe('D:\\abysSUS');
  expect(hostStoragePath('/srv/abyssus','linux')).toBe('/srv/abyssus');
  for(const value of ['D:relative','\\\\server\\share','D:\\','D:\\x\\..\\y'])expect(()=>hostStoragePath(value,'win32')).toThrow();
  for(const value of ['D:\\abysSUS','/','/srv/../home','/srv/a\nb'])expect(()=>hostStoragePath(value,'linux')).toThrow();
});
it('accepts established storage and rejects a replaced database instead of initializing one',async()=>{
  const t=await fixture();expect(verifyContainerStorage(t.id,t.home,t.workspace).profileId).toBe(t.profile.id);
  const file=path.join(t.home,'profile/state/state.sqlite');renameSync(file,`${file}.saved`);writeFileSync(file,'');
  expect(()=>verifyContainerStorage(t.id,t.home,t.workspace)).toThrow();expect(readFileSync(file).length).toBe(0);
});
it.each(['config','state','workspace','profile.json','database','mount-id','receipt'])('refuses missing %s without recreating it',async kind=>{
  const t=await fixture();
  const target=({config:path.join(t.home,'profile/config'),state:t.home,workspace:t.workspace,'profile.json':path.join(t.home,'profile/profile.json'),database:path.join(t.home,'profile/state/state.sqlite'),'mount-id':path.join(t.workspace,'.storage-id'),receipt:path.join(t.home,'container-storage.json')} as const)[kind as 'config'];
  const saved=path.join(t.root,`missing-${kind}`);renameSync(target,saved);
  expect(()=>verifyContainerStorage(t.id,t.home,t.workspace)).toThrow();expect(()=>readFileSync(target)).toThrow();
});
it('refuses mismatched mount identities and wrong profile identities',async()=>{
  const t=await fixture();durableWrite(path.join(t.workspace,'.storage-id'),`${randomUUID()}\n`);
  expect(()=>verifyContainerStorage(t.id,t.home,t.workspace)).toThrow(/mount/);
  durableWrite(path.join(t.workspace,'.storage-id'),`${t.id}\n`);
  durableWrite(path.join(t.home,'profile/profile.json'),JSON.stringify({id:randomUUID(),protocol:'native-tools-v1'}));
  expect(()=>verifyContainerStorage(t.id,t.home,t.workspace)).toThrow(/profile identity/);
});
it('blocks command layout, launch and reset before filesystem or subprocess access',async()=>{
  const sandbox=new LinuxSandbox();sandbox.configure({home:'/abyssus',projects:()=>[],protectedPaths:[],executionMode:'container'});
  expect(()=>sandbox.layout('/nonexistent')).toThrow(/M29/);
  expect(()=>sandbox.reset('/nonexistent')).toThrow(/M29/);
  await expect(sandbox.launch('/nonexistent',['/bin/sh','-c','touch /tmp/not-allowed'])).rejects.toThrow(/M29/);
});
it('blocks package helper connection before any descriptor access',async()=>{
  vi.stubEnv('HARNESS_EXECUTION_MODE','container');await expect(PackageHelperClient.connect()).rejects.toThrow('CONTAINER_EXECUTION_UNAVAILABLE');
});
it('only explicitly selected container mode permits a container listener and reports execution unavailable',()=>{
  expect(()=>readConfig({HOST:'0.0.0.0'})).toThrow(/loopback/);
  const config=readConfig({HOST:'0.0.0.0',HARNESS_EXECUTION_MODE:'container'});
  expect(publicSettings(config)).toMatchObject({executionMode:'container',executionAvailable:false});
  expect(()=>readConfig({HARNESS_EXECUTION_MODE:'typo'})).toThrow(/mode/);
});
it('does not expose host browsing or mutable workspace selection in container mode',async()=>{
  const store=new Store(':memory:');cleanup.push(()=>store.close());store.setState('preferences:workspace','/private');
  const locations=new WorkspaceLocations(store,'/workspace',undefined,true);
  expect(locations.settings().workspaceRoot).toBe('/workspace');
  await expect(locations.update('/tmp')).rejects.toThrow(/supervisor/);await expect(locations.browse('/abyssus')).rejects.toThrow(/unavailable/);
});
