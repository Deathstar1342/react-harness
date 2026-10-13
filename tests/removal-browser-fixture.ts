// Opt-in real backend/browser fixture. Uses ONLY newly allocated temporary folders.
// npm run build; node --import tsx tests/removal-browser-fixture.ts
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { WorkspaceTools } from '../server/tools/index.js';
import { Store } from '../server/store.js';

const parent=await realpath(tmpdir()),root=await mkdtemp(path.join(parent,'rh-m13-browser-'));
const config=readConfig({PORT:'3183',HARNESS_DATA_DIR:path.join(root,'data'),HARNESS_WORKSPACE_ROOT:path.join(root,'workspace')});
const store=new Store(path.join(config.dataDir,'state.sqlite'));
for(const name of ['Keep files','Delete files','Dirty editor']) {
  const directory=path.join(config.workspaceRoot,name);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'hello.txt'),'Isolated M13 browser fixture.\n');
  const project=store.createProject(name,directory);store.createChat(project.id,'Disposable chat','review');store.createChat(project.id,'Sibling chat','review');
}
const {app}=await createApp({config,store,tools:new WorkspaceTools(),provider:{models:async()=>[],complete:async()=>{throw new Error('No provider in browser fixture');}},hooks:{instructions:()=>'',parse:()=>{throw new Error('No model output in browser fixture');}}});
await app.listen({host:'127.0.0.1',port:config.port});
console.log(JSON.stringify({url:'http://127.0.0.1:3183',fixtureRoot:root}));
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;await app.close();store.close();if(path.dirname(root)!==parent || !path.basename(root).startsWith('rh-m13-browser-')) throw new Error('Invalid fixture cleanup root');await rm(root,{recursive:true,force:true});process.exit(0);};
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
process.stdin.resume();process.stdin.on('data',()=>void stop());
setTimeout(()=>void stop(),15*60_000).unref();
