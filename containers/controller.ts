import { readDesktopLaunch } from './desktop-session.js';
import { startBackend } from '../server/bootstrap.js';

process.umask(0o077);
// Fixed trusted deployment config. Provider fields are read only from the private file.
const env:NodeJS.ProcessEnv={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',NODE_ENV:'production',
  HARNESS_EXECUTION_MODE:'container',HARNESS_STORAGE_ID:process.env.HARNESS_STORAGE_ID,HARNESS_DESKTOP:process.env.HARNESS_DESKTOP,
  HARNESS_HOME:'/abyssus',HARNESS_WORKSPACE_ROOT:'/workspace',HOST:'0.0.0.0',PORT:'3000'};
for(const key of Object.keys(process.env))delete process.env[key];
Object.assign(process.env,env);
try {
  const desktop=process.env.HARNESS_DESKTOP==='1';
  const launch=desktop?readDesktopLaunch(env.HARNESS_STORAGE_ID??''):undefined;
  if(launch)env.HARNESS_LAUNCH_KEY=launch.key;
  const backend=await startBackend({env,desktop,transportToken:launch?.token});
  console.log('Container controller ready; host address http://127.0.0.1:3000');
  // Same deliberate single-use, expiring local-operator capability as source mode.
  if(!desktop)console.log(`Browser pairing code (single use, 5 minutes): ${backend.auth.pairingCode}`);
  backend.app.server.once('close',()=>{void backend.close().then(()=>process.exit(0),()=>{process.exitCode=1;console.error('Controller shutdown failed; ownership retained.');});});
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{
    void backend.close().then(()=>process.exit(0),()=>{console.error('Controller shutdown failed; inspect retained state.');process.exit(1);});
  });
} catch {
  // Never echo errors containing private paths, configuration, or descriptors.
  console.error('Container startup refused: verify selected mount identities, private ownership, profile/database/configuration and exclusive backend ownership. No storage was reset.');
  process.exitCode=1;
}
