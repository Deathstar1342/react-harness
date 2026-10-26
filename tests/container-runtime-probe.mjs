// Runs inside the actual disposable controller with the production Unix broker.
// Provider is intentionally unused; Runtime, SQLite, files, callbacks, workers are real.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {Store} from '/app/server/store.ts';
import {Runtime} from '/app/server/runtime.ts';
import {WorkspaceTools} from '/app/server/tools/index.ts';
import {WorkerClient} from '/app/server/worker-client.ts';
import {readConfig} from '/app/server/config.ts';
import {roleInstructions} from '/app/server/prompts.ts';
import {Checkpoints} from '/app/server/checkpoints.ts';
import {createGoal,goalOf} from '/app/server/goals.ts';
const checks=[];
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);console.log('PASS:',name);};
const exists=async file=>{try{await access(file);return true;}catch{return false;}};
for(const kind of ['success','tests','approval','lease','steering','goal','guidance','skill','authorization-commit','outcome-commit','lost-activation']){
  const id=randomUUID(),root='/workspace/runtime-'+id,home='/tmp/runtime-'+id;
  await mkdir(root);await mkdir(home,{mode:0o700});await writeFile(root+'/AGENTS.md','Preserve manual work.');
  const filename=home+'/state.sqlite',store=new Store(filename),tools=new WorkspaceTools();
  const project=store.createProject('Real container callback '+kind,root),chat=store.createChat(project.id,kind,'autonomous');
  const config=readConfig({HARNESS_EXECUTION_MODE:'container',HARNESS_HOME:home,HARNESS_DATA_DIR:home+'/data',HARNESS_WORKSPACE_ROOT:'/workspace'});
  tools.configureSandbox({home,projects:()=>[root],protectedPaths:[],executionMode:'container'});
  const provider={models:async()=>[],complete:async()=>{throw new Error('Provider must not be called by callback fixture');}};
  const runtime=new Runtime(store,provider,tools,config,{instructions:roleInstructions});
  const signal=new AbortController().signal;
  const state={frames:[{id:'task',role:'architect',messages:[],repairs:0},{id:'frame',role:'coder',messages:[],repairs:0}],steering:[],generation:0,steps:0,planOnly:false};
  let originalRequest=WorkerClient.prototype.request,originalSet=store.setState.bind(store),originalExec=store.db.exec.bind(store.db),activations=0,prepared=0,armed=false,injected=false;
  try{
    if(kind==='skill'){
      const dir=root+'/.abyssus/skills/check';await mkdir(dir,{recursive:true});
      await writeFile(dir+'/SKILL.md','---\nname: "check"\ndescription: "Callback fixture"\nreferences: []\n---\nInspect actual evidence.\n');
      const doc=await runtime.skills.files(chat.id).load('project','check');
      await runtime.selectSkill(chat.id,{scope:'project',name:'check',revision:doc.revision,selectionRevision:runtime.skills.selection(chat.id).revision});
    }
    if(kind==='goal'){
      const message=store.message(chat.id,'user','Deliver one verified marker');
      createGoal(store,chat.id,{objective:'Deliver one verified marker',acceptanceCriteria:['Marker written']},message.id);
    }
    await runtime.refreshInstructions(chat.id,state,signal);
    if(kind==='tests')await writeFile(root+'/test_actual.py',`import unittest, pathlib, xml.etree.ElementTree as ET\nclass Actual(unittest.TestCase):\n def test_project_marker(self): self.assertEqual(pathlib.Path('effect.txt').read_text(),'x')\nr=unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(Actual))\ns=ET.Element('testsuite',tests=str(r.testsRun),failures=str(len(r.failures)),errors=str(len(r.errors)))\nET.SubElement(s,'testcase',name='actual project marker')\nET.ElementTree(s).write('actual.xml')\nraise SystemExit(0 if r.wasSuccessful() else 1)\n`);
    const frame=state.frames[1],action=kind==='tests'?{name:'run_tests',args:{command:'printf x >> effect.txt; python3 test_actual.py',reportPath:'actual.xml'}}:{name:'run_shell',args:{command:'printf x >> effect.txt'}},call={id:'call_'+id,type:'function',function:{name:action.name,arguments:JSON.stringify(action.args)}};
    frame.messages.push({role:'assistant',content:'',tool_calls:[call]});frame.queuedCalls=[call];
    frame.pending={id:'command-'+id,callId:call.id,stage:'prepared',action,instructionsHash:state.instructionsHash};
    if(kind==='approval'){
      const inspection=await tools.inspect({projectRoot:root,chatId:chat.id,agentId:frame.id},action);
      frame.pending.approvalId='approval-'+id;
      store.approval({id:frame.pending.approvalId,chatId:chat.id,agentId:frame.id,action,createdAt:new Date().toISOString(),status:'approved',inspection});
    }
    runtime.save(chat.id,state);runtime.runs.set(chat.id,state);
    WorkerClient.prototype.request=async function(op,body){
      const result=await originalRequest.call(this,op,body);
      if(op==='prepare'){
        prepared++;
        if(kind==='approval')store.approval({...store.getApproval(frame.pending.approvalId),status:'denied'});
        if(kind==='lease')tools.setDirty(root,'manual.txt','human-editor',true);
        if(kind==='steering')state.steering.push('Human changed the next action');
        if(kind==='goal'){const goal=goalOf(store,chat.id);store.setState('goal:'+chat.id,{...goal,revision:goal.revision+1});}
        if(kind==='guidance')await writeFile(root+'/AGENTS.md','New human guidance during worker preparation.');
        if(kind==='skill')await writeFile(root+'/.abyssus/skills/check/SKILL.md','Changed selected revision during worker preparation.');
      }
      if(op==='activate'){
        activations++;
        if(kind==='lost-activation'){
          for(let n=0;n<100;n++){const observed=await originalRequest.call(this,'observe',{...body,offset:0});if(observed.state==='finished')break;await new Promise(resolve=>setTimeout(resolve,20));}
          throw new Error('Injected loss after real acceptance and effect');
        }
      }
      return result;
    };
    store.setState=function(key,value){const out=originalSet(key,value);if(kind==='authorization-commit'&&key.startsWith('worker-authorization:')||kind==='outcome-commit'&&key==='run:'+chat.id&&value.frames?.some(f=>f.pending?.stage==='done'))armed=true;return out;};
    store.db.exec=function(sql){if(sql==='COMMIT'&&armed&&!injected){injected=true;throw new Error('Injected durable commit failure');}return originalExec(sql);};
    let failure;
    try{await runtime.executePending(chat.id,state,frame,signal);}catch(error){failure=error;}
    store.setState=originalSet;store.db.exec=originalExec;
    check(kind+' reached real prepared worker',prepared===1);
    if(['success','tests','outcome-commit','lost-activation'].includes(kind)){
      check(kind+' activated once and changed real project',activations===1&&await readFile(root+'/effect.txt','utf8')==='x');
      const authorizations=store.db.prepare("SELECT data FROM state WHERE key LIKE 'worker-authorization:%'").all();
      check(kind+' retained exact durable worker authorization',authorizations.length===1&&JSON.parse(authorizations[0].data).callId===call.id);
      if(kind==='outcome-commit'){
        check('outcome COMMIT failure leaves executing uncertainty',injected&&failure&&store.getState('run:'+chat.id,null).frames[1].pending.stage==='executing');
        await runtime.executePending(chat.id,state,frame,signal);
        check('uncertain outcome recovery does not repeat command',activations===1&&await readFile(root+'/effect.txt','utf8')==='x');
      }
      if(kind==='lost-activation')check('lost activation remains uncertain in native result',store.events(chat.id).some(event=>JSON.stringify(event.data).includes('uncertain')));
      if(kind==='tests')check('real test tool records a fresh passing JUnit observation',store.events(chat.id).some(event=>JSON.stringify(event.data).includes('actual project marker')));
      if(kind==='success')check('real worker success has correlated native result',store.getState('run:'+chat.id,null).frames[1].messages.some(m=>m.role==='tool'&&m.tool_call_id===call.id));
    }else{
      check(kind+' vetoes before actual activation',activations===0&&!await exists(root+'/effect.txt'));
      check(kind+' commits no worker authorization',store.db.prepare("SELECT count(*) AS n FROM state WHERE key LIKE 'worker-authorization:%'").get().n===0);
      if(kind==='authorization-commit')check('authorization COMMIT failure was actually injected',injected);
    }
    if(kind==='lease')tools.setDirty(root,'manual.txt','human-editor',false);
  }finally{
    WorkerClient.prototype.request=originalRequest;store.setState=originalSet;store.db.exec=originalExec;
    await runtime.close();await tools.dispose();store.close();
  }
  const reopened=new Store(filename);reopened.recover();
  const secondTools=new WorkspaceTools(),second=new Runtime(reopened,provider,secondTools,config,{instructions:roleInstructions});
  await new Promise(resolve=>setTimeout(resolve,30));
  check(kind+' disk SQLite restart does not replay',!await exists(root+'/effect.txt')||await readFile(root+'/effect.txt','utf8')==='x');
  await second.close();await secondTools.dispose();reopened.close();
}
for(const kind of ['completed','lease','cancelled']){
  const id=randomUUID(),root='/workspace/process-'+id,home='/tmp/process-'+id;
  await mkdir(root);await mkdir(home,{mode:0o700});
  const store=new Store(home+'/state.sqlite'),tools=new WorkspaceTools(),project=store.createProject('Process '+kind,root),chat=store.createChat(project.id,kind,'autonomous');
  const config=readConfig({HARNESS_EXECUTION_MODE:'container',HARNESS_HOME:home,HARNESS_DATA_DIR:home+'/data'});
  tools.configureSandbox({home,projects:()=>[root],protectedPaths:[],executionMode:'container'});
  const runtime=new Runtime(store,{models:async()=>[],complete:async()=>{throw new Error('unused provider');}},tools,config,{instructions:roleInstructions});
  const state={frames:[{id:'task',role:'architect',messages:[],repairs:0},{id:'coder',role:'coder',messages:[],repairs:0}],steering:[],generation:0,steps:0,planOnly:false};
  const original=WorkerClient.prototype.request;let activations=0;
  try{
    await runtime.refreshInstructions(chat.id,state);
    const action={name:'start_process',args:{command:kind==='cancelled'?'printf started; sleep 2; printf forbidden > late.txt':'sleep .3; printf completed > process.txt; printf observed',timeoutMs:10000}};
    const call={id:'call_'+id,type:'function',function:{name:action.name,arguments:JSON.stringify(action.args)}};
    state.frames[1].messages.push({role:'assistant',content:'',tool_calls:[call]});runtime.save(chat.id,state);runtime.runs.set(chat.id,state);
    WorkerClient.prototype.request=async function(op,body){const result=await original.call(this,op,body);if(op==='prepare'&&kind==='lease')tools.setDirty(root,'manual.txt','editor',true);if(op==='activate'){activations++;if(kind==='cancelled')runtime.processes.stopChat(chat.id);}return result;};
    const origin={projectId:project.id,chatId:chat.id,frameId:'coder',taskId:'task',callId:call.id,commandId:'owned-'+id,generation:state.generation,modeVersion:store.chat(chat.id).modeVersion??0,instructionsHash:state.instructionsHash,targets:[],approvalMode:'autonomous',skillsHash:runtime.skills.binding(chat.id)};
    const handle=runtime.processes.start(origin,action).data;
    await assert.rejects(tools.save(root,'blocked.txt','x',null),/mutation|process/);
    await runtime.processes.drainChat(chat.id);
    const job=await runtime.processes.observe(handle.id,chat.id,['coder']);
    await assert.rejects(runtime.processes.observe(handle.id,'foreign',['coder']),/belong/);
    if(kind==='completed')check('real background process commits dispatch output exit and cleanup',job.status==='completed'&&job.exitCode===0&&job.output==='observed'&&activations===1&&await readFile(root+'/process.txt','utf8')==='completed');
    if(kind==='lease'){tools.setDirty(root,'manual.txt','editor',false);check('real background process rechecks editor lease before dispatch',job.status==='not_started'&&activations===0&&!await exists(root+'/process.txt'));}
    if(kind==='cancelled'){await new Promise(resolve=>setTimeout(resolve,2100));check('owned cancellation cannot publish success or leave later writes',['uncertain','interrupted'].includes(job.status)&&activations===1&&!await exists(root+'/late.txt'));}
  }finally{WorkerClient.prototype.request=original;await runtime.close();await tools.dispose();store.close();}
}
// M34: real owned worker descendants must drain before source capture/restore.
{
 const id=randomUUID(),root='/workspace/checkpoint-'+id,home='/tmp/checkpoint-'+id;await mkdir(root);await mkdir(home,{mode:0o700});
 await writeFile(root+'/a.ts','before a');await writeFile(root+'/b.ts','before b');await writeFile(root+'/AGENTS.md','Preserve source guidance');
 const filename=home+'/state.sqlite',store=new Store(filename),tools=new WorkspaceTools(),project=store.createProject('Checkpoint worker',root),chat=store.createChat(project.id,'Human task boundary','review');
 const config=readConfig({HARNESS_EXECUTION_MODE:'container',HARNESS_HOME:home,HARNESS_DATA_DIR:home+'/data',HARNESS_WORKSPACE_ROOT:'/workspace'});
 tools.configureSandbox({home,projects:()=>[root],protectedPaths:[],executionMode:'container'});
 const runtime=new Runtime(store,{models:async()=>[],complete:async()=>{throw new Error('Checkpoints never call provider');}},tools,config,{instructions:roleInstructions}),service=new Checkpoints(store,runtime),context={projectRoot:root,chatId:chat.id,agentId:'checkpoint-worker'};
 const original=WorkerClient.prototype.request;let confirmedCloses=0;
 try{
  const captured=await service.capture(project.id,{chatId:chat.id,label:'Before worker task'});
  WorkerClient.prototype.request=async function(op,body){const result=await original.call(this,op,body);if(op==='close'&&result.cleanupConfirmed===true)confirmedCloses++;return result;};
  const pending=tools.execute(context,{name:'run_shell',args:{command:'sleep .3; printf busy > busy.ts',timeoutMs:10000}});await new Promise(resolve=>setTimeout(resolve,40));
  await assert.rejects(service.capture(project.id,{chatId:chat.id,label:'Must reject active writer'}),/mutation|pending|process/);check('checkpoint capture rejects actual pending worker writer',(await pending).ok);
  const changed=await tools.execute(context,{name:'run_shell',args:{command:'printf changed > a.ts; mv b.ts moved.ts; printf added > added.ts',timeoutMs:10000}});check('checkpoint fixture changed real managed files through worker',changed.ok&&await readFile(root+'/a.ts','utf8')==='changed');
  await service.capture(project.id,{chatId:chat.id,label:'After confirmed worker drain'});check('checkpoint idle boundary observes exact confirmed worker closure',confirmedCloses>=1);
  const preview=await service.preview(project.id,captured.id,{chatId:chat.id});tools.setDirty(root,'a.ts','human',true);
  await assert.rejects(service.restore(project.id,captured.id,{chatId:chat.id,previewToken:preview.previewToken,revision:preview.revision,confirmation:'restore-files'}),/unsaved/);tools.setDirty(root,'a.ts','human',false);
  await service.restore(project.id,captured.id,{chatId:chat.id,previewToken:preview.previewToken,revision:preview.revision,confirmation:'restore-files'});
  check('actual controller SQLite and guarded files restore coherent pre-worker source',await readFile(root+'/a.ts','utf8')==='before a'&&await readFile(root+'/b.ts','utf8')==='before b'&&!await exists(root+'/moved.ts')&&!await exists(root+'/added.ts')&&!await exists(root+'/busy.ts'));
  check('container checkpoint appends confirmed normal file history',store.fileChanges(project.id).length>=5&&store.fileChanges(project.id).every(change=>change.status==='confirmed'&&change.source==='checkpoint'));
 }finally{WorkerClient.prototype.request=original;await runtime.close();await tools.dispose();store.close();}
 const reopened=new Store(filename);reopened.recover();try{check('actual container checkpoint restore remains terminal on SQLite restart',reopened.db.prepare("SELECT json_extract(data,'$.status') AS status FROM state WHERE key LIKE 'checkpoint-restore:v1:%'").get().status==='done');}finally{reopened.close();}
}
// Separate negative boundary: an owned detached child must never become successful work or be replayed.
{
 const id=randomUUID(),root='/workspace/checkpoint-negative-'+id,home='/tmp/checkpoint-negative-'+id;await mkdir(root);await mkdir(home,{mode:0o700});await writeFile(root+'/AGENTS.md','Preserve original failed worker evidence');
 const store=new Store(home+'/state.sqlite'),tools=new WorkspaceTools(),project=store.createProject('Checkpoint descendant boundary',root),chat=store.createChat(project.id,'Detached child must fail','autonomous');
 const config=readConfig({HARNESS_EXECUTION_MODE:'container',HARNESS_HOME:home,HARNESS_DATA_DIR:home+'/data',HARNESS_WORKSPACE_ROOT:'/workspace'});tools.configureSandbox({home,projects:()=>[root],protectedPaths:[],executionMode:'container'});
 const runtime=new Runtime(store,{models:async()=>[],complete:async()=>{throw new Error('Unused provider');}},tools,config,{instructions:roleInstructions}),service=new Checkpoints(store,runtime),context={projectRoot:root,chatId:chat.id,agentId:'checkpoint-negative'};
 const original=WorkerClient.prototype.request;let ownedContext,exactClose=false,closeFailed=false,activations=0;
 try{
  WorkerClient.prototype.request=async function(op,body){if(op==='prepare')ownedContext=body.contextId;if(op==='activate')activations++;try{const result=await original.call(this,op,body);if(op==='close')exactClose=body.contextId===ownedContext&&result.contextId===ownedContext&&result.cleanupConfirmed===true;return result;}catch(error){if(op==='close')closeFailed=true;throw error;}};
  const action={name:'run_shell',args:{command:'(sleep 4; printf forbidden > late.ts) >/dev/null 2>&1 &',timeoutMs:10000}},failed=await tools.execute(context,action);
  check('checkpoint negative descendant command is retained as failed/reset or uncertain',failed.ok===false&&(failed.data?.shellReset===true||failed.data?.uncertain===true));
  const event=store.event(chat.id,'tool',{agentId:context.agentId,commandId:'negative-'+id,action,result:failed});
  let captured,blocked;try{captured=await service.capture(project.id,{chatId:chat.id,label:'After exact owned descendant cleanup'});}catch(error){blocked=error;}
  if(captured)check('checkpoint after failed descendant requires exact owned cleanup confirmation',exactClose&&captured.files===1);
  else check('checkpoint cannot bypass unresolved descendant cleanup',/uncertain|cleanup|pending|process|mutation/i.test(String(blocked))&&(failed.data?.uncertain===true||closeFailed));
  await new Promise(resolve=>setTimeout(resolve,4200));check('checkpoint boundary has no late detached-child write and never replays command',activations===1&&!await exists(root+'/late.ts'));
  check('checkpoint observation never upgrades original failed descendant result',store.events(chat.id).find(item=>item.id===event.id).data.result.ok===false);
 }finally{WorkerClient.prototype.request=original;await runtime.close();await tools.dispose();store.close();}
}
console.log(JSON.stringify({platform:'actual Linux controller/broker/worker with disk SQLite',provider:'unused synthetic fixture',checks}));
