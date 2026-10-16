import {installFixedEnvironment} from './environment.js';
/** Fixed initializer for a host-attested empty NTFS scaffold. No phase RPC. */
import { readdirSync,readFileSync,unlinkSync } from 'node:fs';
import { NativeBindPolicy } from '../server/native-bind-policy.js';
import { installNativeStorage,runNativeOperation,assertNativePath } from '../server/native-storage.js';
import { WorkerClient } from '../server/worker-client.js';
import { prepareProfile,durableWrite,regularFile } from '../server/profile.js';
import { Store } from '../server/store.js';
process.umask(0o077);
const env:NodeJS.ProcessEnv={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',NODE_ENV:'production',HARNESS_EXECUTION_MODE:'container',HARNESS_STORAGE_ID:process.env.HARNESS_STORAGE_ID,HARNESS_NATIVE_BIND_DIGEST:process.env.HARNESS_NATIVE_BIND_DIGEST,HARNESS_LAUNCH_ID:process.env.HARNESS_LAUNCH_ID};
installFixedEnvironment(env);
try{
 const policy=NativeBindPolicy.load(env);
 if(!policy||policy.record.phase!=='initialize'||process.getuid?.()===0)throw new Error('Native initializer phase required');
 const client=await WorkerClient.connectNative(policy);installNativeStorage(policy,()=>client.request('storage_check',{}),client.nativeObservation());
 await runNativeOperation(async()=>{
  for(const root of ['/initialize/state','/initialize/config','/initialize/workspace']){
   assertNativePath(root,false);
   const entries=readdirSync(root);if(entries.length!==1||entries[0]!=='.storage-id'||readFileSync(root+'/.storage-id','utf8')!==policy.record.storageId+'\n')throw new Error('Empty native scaffold changed');
  }
  const profile=await prepareProfile({env:{HARNESS_HOME:'/initialize/state',HARNESS_INIT:'1'},cwd:'/app',checkpoint:()=>assertNativePath('/initialize/state')});
  try{
   assertNativePath(profile.paths.dataDir);const store=new Store(profile.paths.dataDir+'/state.sqlite');
   try{store.setState('container:storage-id',policy.record.storageId);store.setState('container:profile-id',profile.id);}finally{store.close();}
   regularFile(profile.paths.configFile);if(readFileSync(profile.paths.configFile,'utf8')!=='')throw new Error('Fresh native configuration changed');
   // Separate bind slots cannot use a cross-mount rename. Publish the proven
   // empty configuration durably in its own slot before removing the empty stub.
   durableWrite('/initialize/config/.env','');assertNativePath(profile.paths.configFile);unlinkSync(profile.paths.configFile);
   durableWrite('/initialize/state/container-storage.json',JSON.stringify({version:1,storageId:policy.record.storageId,profileId:profile.id,kind:'local-bind'}));
  }finally{profile.ownership.close();}
 });
 console.log('Native profile initialized; trusted host must verify and commit root marker.');
}catch{console.error('Native initialization refused or interrupted; preserve provisional storage and do not replay.');process.exitCode=1;}
