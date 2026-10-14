/** Invoked only by the existing explicitly provisioned disposable helper CI.
 * This module never provisions, starts, repairs or removes the helper. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { parseAgentResponse, protocolInstructions } from '../server/protocol.js';
import { WorkspaceTools } from '../server/tools/index.js';
import { BUDGET_STATE_KEY } from '../server/scheduler.js';

export async function installPolicyIntegration(projectRoot:string) {
  assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.platform,'linux');assert.notEqual(process.getuid!(),0);
  const store=new Store(':memory:');
  let packageName='sl', stage=0, reviews=0;
  const config=readConfig({STARK_BASE_URL:'http://127.0.0.1:1/synthetic-unused',STARK_API_KEY:'synthetic-only',HARNESS_DATA_DIR:'/tmp/abyssus-m19-ci-data'});
  const {app,runtime,installs}=await createApp({store,config,tools:new WorkspaceTools(),hooks:{parse:parseAgentResponse,instructions:protocolInstructions},provider:{models:async()=>['synthetic-install-reviewer'],complete:async input=>{
    if(input.messages[0]?.content.startsWith('Evaluate a proposed')){
      reviews++;assert.equal(input.messages.length,2);assert.equal(input.model,'synthetic-install-reviewer');
      assert(!JSON.stringify(input).includes('decisionNonce'));assert(!JSON.stringify(input).includes('synthetic-only'));
      return {text:'{"decision":"approve","reason":"Specific disposable CI dependency requested."}',usage:{inputTokens:10,outputTokens:10}};
    }
    return {text:JSON.stringify(stage++===0?{message:'Recommend the explicit CI dependency.',action:'recommend_packages',parameters:{packages:[{name:packageName}],reason:'Required representative dependency in this disposable acceptance fixture.'}}:{message:'Recorded helper evidence received.',action:'complete',parameters:{}})};
  }}});
  try {
    const project=store.createProject('M19 disposable CI',projectRoot);
    const environment=(await app.inject('/api/system-installs/settings')).json();assert(environment.available);
    for(const [policy,name] of [['ask','sl'],['auto','figlet'],['ai','toilet']] as const){
      packageName=name;stage=0;
      const settings=(await app.inject('/api/system-installs/settings')).json();
      assert.equal((await app.inject({method:'PATCH',url:'/api/system-installs/settings',payload:{policy,reviewerModel:'synthetic-install-reviewer',revision:settings.revision}})).statusCode,200);
      const chat=store.createChat(project.id,`M19 ${policy}`,'autonomous');
      assert.equal((await app.inject({method:'POST',url:`/api/chats/${chat.id}/messages`,payload:{content:`Verify ${name} system dependency installation`}})).statusCode,202);
      await runtime.wait(chat.id);
      let item=store.installs().find(i=>i.chatId===chat.id)!;assert(item,'a durable helper request must exist');
      assert(item.preview?.packages.some(p=>p.name===name),'real fresh package closure required; noop is not policy installation evidence');
      if(policy==='ask'){
        assert.equal(item.state,'pending');assert.equal(store.chat(chat.id).status,'awaiting_approval');
        assert.equal((await app.inject({method:'POST',url:`/api/approvals/${item.id}`,payload:{decision:'approve'}})).statusCode,200);await runtime.wait(chat.id);
      }
      item=store.install(item.id);assert.equal(item.state,'succeeded',JSON.stringify({policy,state:item.state,code:item.code}));
      assert.equal(item.decision?.source,policy==='ask'?'human':policy);assert.equal(item.recoveryRequired,false);
      const version=item.preview!.packages.find(p=>p.name===name)!.version;
      assert.equal(execFileSync('/usr/bin/dpkg-query',['-W','-f=${Version}',name],{encoding:'utf8'}),version);
      assert.equal((await app.inject({method:'POST',url:`/api/approvals/${item.id}`,payload:{decision:'approve'}})).statusCode,policy==='ask'?409:404);
      console.log(`PASS M19 ${policy}: real helper preview/authorization/install, exact dpkg version, durable source and no duplicate dispatch`);
    }
    assert.equal(reviews,1);assert(store.getState<any[]>(BUDGET_STATE_KEY,[]).some(entry=>entry.role==='critic'&&entry.status==='reported'));
    // Already-installed names remain explicit no-ops, never invented success.
    const chat=store.createChat(project.id,'M19 noop','autonomous');packageName='sl';stage=0;
    await runtime.submit(chat.id,'Inspect installed dependency');await runtime.wait(chat.id);
    assert.equal(store.installs().find(i=>i.chatId===chat.id)!.state,'noop');assert.equal(reviews,1);
    console.log('PASS M19 real helper noop and synthetic reviewer account ledger');
  } finally {await app.close();store.close();}
}
