import path from 'node:path';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { loadBackendConfig } from './provider-settings.js';
import { createApp } from './app.js';
import { ReloadingProvider } from './provider.js';
import { createManagedHooks } from './context.js';
import { Store } from './store.js';
import { WorkspaceTools } from './tools/index.js';
import { loadPromptExtensions } from './prompts.js';
import { prepareProfile, lockResources, durableWrite, privateDirectory, regularFile, type ProfileOptions } from './profile.js';
import { BackendLifecycle } from './lifecycle.js';
import { TransportAuth } from './transport-auth.js';

export async function startBackend(options:ProfileOptions & {transportToken?:string;desktop?:boolean}={}) {
  const env={...(options.env ?? process.env)};
  for(const name of ['HARNESS_DATA_DIR','HARNESS_WORKSPACE_ROOT','ARCHITECT_PROMPT_FILE','CODER_PROMPT_FILE','CRITIC_PROMPT_FILE']) {
    if(env[name] || name==='HARNESS_DATA_DIR' && env[name]!==undefined)env[name]=path.resolve(options.cwd ?? process.cwd(),env[name]!);
  }
  const profile=await prepareProfile({...options,env});
  let resources:ReturnType<typeof lockResources>|undefined,store:Store|undefined;
  let app:Awaited<ReturnType<typeof createApp>>['app']|undefined;
  const tools=new WorkspaceTools();
  let lifecycle:BackendLifecycle|undefined;
  const descriptor=path.join(profile.paths.home,'backend.json');
  let closePromise:Promise<void>|undefined;
  const close=():Promise<void>=>closePromise ??= (async()=>{
    // Failed or hanging drains retain ownership. Process exit releases the OS locks.
    await app?.close();
    if(!app)await tools.dispose();
    store?.close();store=undefined;
    durableWrite(descriptor,JSON.stringify({version:1,instanceId:lifecycle?.instanceId,state:'stopped'}));
    resources?.close();profile.ownership.close();
  })();
  try {
    lifecycle=new BackendLifecycle(profile.id,env.HARNESS_LAUNCH_KEY);
    const auth=new TransportAuth(lifecycle.instanceId,options.transportToken,!options.desktop);
    privateDirectory(path.dirname(profile.paths.configFile));
    if(!existsSync(profile.paths.configFile))throw new Error('Selected configuration is missing; restore profile/config/.env before startup');
    const {config,file}=loadBackendConfig({...env,HARNESS_HOME:profile.paths.home},profile.paths.configFile);
    config.appHome=profile.paths.home;
    if(options.desktop){config.host='127.0.0.1';config.port=0;}
    if(config.port>65535)throw new Error('PORT must be at most 65535');
    // Home is already held. Preserve explicit overrides pointing exactly at it.
    resources=lockResources([path.dirname(file.filename),config.dataDir].filter(dir=>{
      return !(existsSync(dir) && realpathSync(dir)===realpathSync(profile.paths.home));
    }));
    config.dataDir=realpathSync(config.dataDir);
    const database=path.join(config.dataDir,'state.sqlite');
    if(profile.receipt.database && config.dataDir===realpathSync(profile.paths.dataDir) && !existsSync(database))throw new Error('Migrated state.sqlite is missing; restore it before startup');
    for(const filename of [database,`${database}-wal`,`${database}-shm`])if(existsSync(filename))regularFile(filename);
    const dataMarker=path.join(config.dataDir,'.profile-state.json');
    const bindingFile=path.join(profile.paths.profile,'data-location.json');
    if(existsSync(bindingFile)) {
      regularFile(bindingFile);
      const binding=JSON.parse(readFileSync(bindingFile,'utf8')) as {directory:string};
      if(binding.directory!==config.dataDir && env.HARNESS_SELECT_DATA!=='1')throw new Error('Effective data directory changed; restore the prior override or explicitly select it with HARNESS_SELECT_DATA=1');
      if(binding.directory===config.dataDir && !existsSync(database))throw new Error('Selected state.sqlite is missing; restore it before startup');
    }
    if(existsSync(dataMarker) && !existsSync(database))throw new Error('Selected state.sqlite is missing; restore it before startup');
    if(lstatSync(config.dataDir).isSymbolicLink())throw new Error('Data directory must not be a link');
    const promptExtensions=await loadPromptExtensions(config);
    const provider=new ReloadingProvider(()=>({baseUrl:config.baseUrl,apiKey:config.apiKey,streaming:config.streaming,maxRetries:0}));
    store=new Store(database);
    durableWrite(dataMarker,JSON.stringify({version:1}));
    ({app}=await createApp({config,provider,store,providerSettingsFile:file,tools,
      hooks:createManagedHooks(provider,store,config,{promptExtensions}),staticRoot:profile.paths.staticRoot,lifecycle:{identity:lifecycle,close},transportAuth:auth}));
    const address=await app.listen({host:config.host,port:config.port});
    config.port=Number(new URL(address).port);
    lifecycle.ready();
    durableWrite(descriptor,JSON.stringify({version:1,address,key:lifecycle.key,identity:lifecycle.identity()}));
    // Publish the selected target only after successful application setup and listen.
    durableWrite(bindingFile,JSON.stringify({version:1,directory:config.dataDir}));
    const running=lifecycle;
    return {app,config,profile,lifecycle:running,auth,address,close:()=>running.stop(close)};
  } catch(error) {
    await (lifecycle ? lifecycle.stop(close) : close());
    throw error;
  }
}
