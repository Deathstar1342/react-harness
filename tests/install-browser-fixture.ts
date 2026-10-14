import { nativeReply } from './native-fixture.js';
// Disposable UI evidence only: synthetic preview/provider; execute is disabled.
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { WorkspaceTools } from '../server/tools/index.js';
import { readConfig } from '../server/config.js';
import { protocolInstructions } from '../server/protocol.js';
import { helperCanonical, helperProtocol } from '../server/package-helper.js';
import type { PackageHelperRecord, PackageHelperTarget } from '../shared/types.js';
import type { InstallHelper } from '../server/installs.js';

const parent=await realpath(tmpdir()),root=await mkdtemp(path.join(parent,'rh-m19-browser-'));
const directory=path.join(root,'workspace');await mkdir(directory);
const config=readConfig({PORT:'3189',STARK_BASE_URL:'http://127.0.0.1:1/synthetic-unused',STARK_API_KEY:'synthetic-fixture-only',HARNESS_DATA_DIR:path.join(root,'data'),HARNESS_WORKSPACE_ROOT:directory});
const store=new Store(path.join(config.dataDir,'state.sqlite'));
const target:PackageHelperTarget={id:'a'.repeat(64),installationId:randomUUID(),machineId:'b'.repeat(32),distribution:'ubuntu',release:'24.04',architecture:'amd64',manager:'apt',adapterVersion:1};
const disabled=async():Promise<never>=>{throw new Error('Synthetic fixture cannot install packages');};
const helper:InstallHelper={hello:async()=>({protocol:helperProtocol,target}),prepare:async request=>{
  const preview:PackageHelperRecord['preview']={target,packages:[{name:'hello',version:'2.10-3',architecture:'amd64',sha256:'c'.repeat(64),downloadBytes:53104,installedBytes:221184,requested:true,uris:['https://archive.ubuntu.com/ubuntu/pool/main/h/hello/hello.deb'],repositories:[{origin:'Ubuntu',label:'Ubuntu',archive:'noble',component:'main',site:'archive.ubuntu.com',trusted:true}]}],stateDigest:'d'.repeat(64),repositoryDigest:'e'.repeat(64),impact:{newPackages:1,downloadBytes:53104,installedBytes:221184,removals:0,upgrades:0,downgrades:0,maintainerScripts:'trusted-package-root-execution',triggers:'may-modify-existing-packages-and-services',serviceChanges:'package-defined'}};
  return {requestId:request.requestId,request,preview,previewDigest:createHash('sha256').update(helperCanonical(preview)).digest('hex'),state:'prepared',createdAt:Date.now(),updatedAt:Date.now(),expiresAt:Date.now()+120000,code:'PREPARED'};
},authorize:disabled,execute:disabled,status:disabled,reconcile:disabled};
const project=store.createProject('M19 synthetic browser fixture',directory),chat=store.createChat(project.id,'System install preview — synthetic only','autonomous');
let count=0;
const {app,runtime}=await createApp({store,config,tools:new WorkspaceTools(),packageHelper:async()=>helper,hooks:{instructions:protocolInstructions},provider:{models:async()=>['synthetic-reviewer','alternate-reviewer'],complete:async()=>count++===0?nativeReply('recommend_packages',{packages:[{name:'hello'}],reason:'Synthetic browser acceptance preview only; no package effects are enabled.'},'Synthetic UI fixture: review a package recommendation. This fixture cannot install anything.'):nativeReply('submit_completion',{summary:'Synthetic evidence received. No installation occurred.'},'Synthetic evidence received. No installation occurred.')}});
await runtime.submit(chat.id,'Show the synthetic system install preview');await runtime.wait(chat.id);
await app.listen({host:'127.0.0.1',port:config.port});console.log(JSON.stringify({url:'http://127.0.0.1:3189',chatId:chat.id}));
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();store.close();if(path.dirname(root)!==parent||!path.basename(root).startsWith('rh-m19-browser-'))throw new Error('Invalid cleanup target');await rm(root,{recursive:true,force:true});process.exit(0);};
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());process.stdin.resume();process.stdin.on('data',()=>void stop());setTimeout(()=>void stop(),30*60_000).unref();
