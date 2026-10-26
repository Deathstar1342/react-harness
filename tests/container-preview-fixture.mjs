// CI-only controller fixture mounted read-only into a disposable controller.
// Uses production Store/Runtime/WorkspaceTools/WorkerClient/Previews with no mocks.
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Store} from '/app/server/store.ts';
import {WorkspaceTools} from '/app/server/tools/index.ts';
import {readConfig} from '/app/server/config.ts';
import {createApp} from '/app/server/app.ts';
import {TransportAuth} from '/app/server/transport-auth.ts';
const projectRoot='/workspace/'+process.env.M35_PROJECT,privateFile='/abyssus/m35-fixture.json';
const config=readConfig({HARNESS_HOME:'/abyssus',HARNESS_DATA_DIR:'/abyssus/profile/state',HARNESS_WORKSPACE_ROOT:'/workspace',HARNESS_EXECUTION_MODE:'container',HOST:'0.0.0.0',PORT:'3000',STARK_API_KEY:'M35_SYNTHETIC_PRIVATE_PROVIDER',STARK_BASE_URL:'http://127.0.0.1:1/no-provider'});
const store=new Store('/abyssus/profile/state/state.sqlite'),project=store.createProject('Connected preview fixture',projectRoot),tools=new WorkspaceTools(),auth=new TransportAuth(randomUUID());let providerCalls=0,starts=0;
const {app,runtime}=await createApp({config,store,tools,transportAuth:auth,browserPreview:'source-fixed-3000',staticRoot:'/app/dist/client',provider:{models:async()=>[],complete:async()=>{providerCalls++;throw new Error('Preview cannot invoke a provider');}},hooks:{instructions:()=>''}});
let chat=store.chats(project.id).find(chat=>chat.title==='Connected preview task'),processId;
if(!chat){
 chat=store.createChat(project.id,'Connected preview task','autonomous');const args={command:'node server.mjs',timeoutMs:600000,previewPort:3001},call={id:'call_'+randomUUID(),type:'function',function:{name:'start_process',arguments:JSON.stringify(args)}};
 const state={frames:[{id:'architect',role:'architect',messages:[],repairs:0},{id:'coder',role:'coder',messages:[{role:'assistant',content:'',tool_calls:[call]}],repairs:0}],generation:0,steps:0,steering:[],planOnly:false,instructionsHash:null};store.setState('run:'+chat.id,state);store.setState(`native:frame:${chat.id}:coder`,state.frames[1].messages);
 const result=runtime.processes.start({projectId:project.id,chatId:chat.id,frameId:'coder',taskId:'architect',callId:call.id,commandId:randomUUID(),generation:0,modeVersion:0,instructionsHash:null,targets:[],approvalMode:'autonomous'},{name:'start_process',args});processId=result.data.id;starts++;
}else{processId=store.db.prepare("SELECT json_extract(data,'$.id') AS id FROM state WHERE key LIKE 'process-job:%' LIMIT 1").get().id;}
app.get('/api/m35-fixture-status',async()=>({starts,providerCalls,processId}));
await app.listen({host:'0.0.0.0',port:3000});
await fs.writeFile(privateFile,JSON.stringify({source:process.env.M35_SOURCE,projectId:project.id,chatId:chat.id,processId,pairingCode:auth.pairingCode,starts,instance:randomUUID()}),{mode:0o600});
let closing;const close=()=>closing??=(async()=>{await app.close();store.close();process.exit(0);})();for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>void close().catch(()=>{console.error('Connected controller cleanup unverified');process.exitCode=1;}));
