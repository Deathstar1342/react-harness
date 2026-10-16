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
import {createGoal,goalOf} from '/app/server/goals.ts';
const checks=[];
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);console.log('PASS:',name);};
const exists=async file=>{try{await access(file);return true;}catch{return false;}};
for(const kind of ['success','approval','lease','steering','goal','guidance','skill','authorization-commit','outcome-commit','lost-activation']){
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
      await writeFile(dir+'/SKILL.md','---\nname: "check"\ndescription: "Callback fixture"\n---\nInspect actual evidence.\n');
      const doc=await runtime.skills.files(chat.id).load('project','check');
      await runtime.selectSkill(chat.id,{scope:'project',name:'check',revision:doc.revision,selectionRevision:runtime.skills.selection(chat.id).revision});
    }
    if(kind==='goal'){
      const message=store.message(chat.id,'user','Deliver one verified marker');
      createGoal(store,chat.id,{objective:'Deliver one verified marker',acceptanceCriteria:['Marker written']},message.id);
    }
    await runtime.refreshInstructions(chat.id,state,signal);
    const frame=state.frames[1],action={name:'run_shell',args:{command:'printf x >> effect.txt'}},call={id:'call_'+id,type:'function',function:{name:action.name,arguments:JSON.stringify(action.args)}};
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
    if(['success','outcome-commit','lost-activation'].includes(kind)){
      check(kind+' activated once and changed real project',activations===1&&await readFile(root+'/effect.txt','utf8')==='x');
      const authorizations=store.db.prepare("SELECT data FROM state WHERE key LIKE 'worker-authorization:%'").all();
      check(kind+' retained exact durable worker authorization',authorizations.length===1&&JSON.parse(authorizations[0].data).callId===call.id);
      if(kind==='outcome-commit'){
        check('outcome COMMIT failure leaves executing uncertainty',injected&&failure&&store.getState('run:'+chat.id,null).frames[1].pending.stage==='executing');
        await runtime.executePending(chat.id,state,frame,signal);
        check('uncertain outcome recovery does not repeat command',activations===1&&await readFile(root+'/effect.txt','utf8')==='x');
      }
      if(kind==='lost-activation')check('lost activation remains uncertain in native result',store.events(chat.id).some(event=>JSON.stringify(event.data).includes('uncertain')));
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
console.log(JSON.stringify({platform:'actual Linux controller/broker/worker with disk SQLite',provider:'unused synthetic fixture',checks}));
