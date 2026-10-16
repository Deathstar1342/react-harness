import { readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { prepareProfile, privateDirectory, durableWrite } from '../server/profile.js';
import { Store } from '../server/store.js';

process.umask(0o077);
try {
  const root='/initialize',id=z.uuid().parse(process.env.HARNESS_STORAGE_ID);
  if(process.getuid?.()===0 || readdirSync(root).length)throw new Error('Initialization requires an empty non-root-owned selected directory');
  privateDirectory(root);
  for(const name of ['state','config','workspace','runtime'])privateDirectory(path.join(root,name));
  for(const name of ['control','egress'])privateDirectory(path.join(root,'runtime',name));
  const profile=await prepareProfile({env:{HARNESS_HOME:path.join(root,'state'),HARNESS_INIT:'1'},cwd:'/app'});
  try {
    const store=new Store(path.join(profile.paths.dataDir,'state.sqlite'));
    store.setState('container:storage-id',id);store.setState('container:profile-id',profile.id);store.close();
    renameSync(profile.paths.configFile,path.join(root,'config','.env'));
    for(const name of ['state','config','workspace'])durableWrite(path.join(root,name,'.storage-id'),`${id}\n`);
    durableWrite(path.join(root,'state','container-storage.json'),JSON.stringify({version:1,storageId:id,profileId:profile.id,kind:'local-bind'}));
    // Publish last. A partial initialization is preserved for explicit inspection, never retried blindly.
    durableWrite(path.join(root,'.storage-id'),`${id}\n`);
  } finally {profile.ownership.close();}
  console.log('Empty storage initialized. Existing profiles are never migrated or erased.');
} catch {console.error('Initialization refused or interrupted. Preserve the selected directory for inspection; no automatic retry/reset.');process.exitCode=1;}
