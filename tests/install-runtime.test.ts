import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { readConfig } from '../server/config.js';
import { parseAgentResponse, protocolInstructions } from '../server/protocol.js';
import { BUDGET_STATE_KEY } from '../server/scheduler.js';
import type { ModelProvider, PackageHelperRecord, ToolService } from '../shared/types.js';
import { SettingsDialog } from '../client/WorkspaceDialogs.js';
import { ApprovalCard } from '../client/Panels.js';
import { deferred, fakeHelper } from './install-fixture.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
const recommendation=JSON.stringify({message:'System dependency needed',action:'recommend_packages',parameters:{packages:[{name:'hello'}],reason:'Print a greeting for the requested build'}});
async function fixture(responses=[recommendation,JSON.stringify({message:'Done',action:'complete',parameters:{}})]) {
  const store=new Store(':memory:'),{helper,records}=fakeHelper();
  const config=readConfig({STARK_BASE_URL:'http://127.0.0.1/v1',STARK_API_KEY:'PRIVATE_CONFIG_KEY',HARNESS_DATA_DIR:'/uncreated-install-test-data'});
  const provider:ModelProvider={models:async()=>['reviewer'],complete:vi.fn(async input=>input.messages[0]?.content.startsWith('Evaluate a proposed')?{text:'{"decision":"approve","reason":"Specific needed dependency"}',usage:{inputTokens:20,outputTokens:12}}:{text:responses.shift()??JSON.stringify({message:'Done',action:'complete',parameters:{}})})};
  const tools:ToolService={inspect:vi.fn(),execute:vi.fn(),read:async(_root,path)=>({path,content:'',hash:null}),list:async()=>[],save:vi.fn(),setDirty:vi.fn(),dispose:async()=>{},removeScope:async(_root,_chat,mutate)=>mutate()};
  const t=await createApp({config,provider,store,tools,hooks:{parse:parseAgentResponse,instructions:protocolInstructions},packageHelper:async()=>helper});
  const project=store.createProject('Test','/not-present-test-project'),chat=store.createChat(project.id,'New chat','autonomous');
  cleanup.push(async()=>{await t.app.close();store.close();});
  const start=async(content='Build')=>{const response=await t.app.inject({method:'POST',url:`/api/chats/${chat.id}/messages`,payload:{content}});expect(response.statusCode).toBe(202);await t.runtime.wait(chat.id);};
  return {...t,helper,records,config,provider,tools,project,chat,start};
}
describe('system install runtime and public API',()=>{
  it('workspace autonomy still asks and ordinary approval executes exactly once',async()=>{
    const t=await fixture();await t.start();const [item]=t.store.installs();
    expect(t.store.chat(t.chat.id).status).toBe('awaiting_approval');expect(t.helper.execute).not.toHaveBeenCalled();
    const res=await t.app.inject({method:'POST',url:`/api/approvals/${item.id}`,payload:{decision:'approve'}});expect(res.statusCode).toBe(200);
    await t.runtime.wait(t.chat.id);expect(t.helper.execute).toHaveBeenCalledTimes(1);expect(t.tools.execute).not.toHaveBeenCalled();
    expect(t.store.install(item.id).state).toBe('succeeded');expect(t.store.chat(t.chat.id).status).toBe('idle');
    expect((await t.app.inject({method:'POST',url:`/api/approvals/${item.id}`,payload:{decision:'approve'}})).statusCode).toBe(409);
  });
  it('explicit new preview uses a new request and never inherits an expired approval',async()=>{
    const t=await fixture();await t.start();const [item]=t.store.installs();
    // Deterministic expired durable preview, without waiting two minutes.
    t.store.saveInstall({...item,expiresAt:Date.now()-1});
    expect((await t.app.inject({method:'POST',url:`/api/approvals/${item.id}`,payload:{decision:'approve'}})).statusCode).toBe(409);
    const refreshed=await t.app.inject({method:'POST',url:`/api/system-installs/${item.id}/refresh`,payload:{}});expect(refreshed.statusCode).toBe(200);
    await t.runtime.wait(t.chat.id);const next=refreshed.json().id;
    expect(next).not.toBe(item.id);expect(t.store.install(next).state).toBe('pending');expect(t.store.getApproval(next).status).toBe('pending');expect(t.helper.execute).not.toHaveBeenCalled();
  });
  it('settings policy is independent and persists snapshots/default models',async()=>{
    const t=await fixture();const models=t.store.chat(t.chat.id).models;
    await t.app.inject({method:'PATCH',url:'/api/preferences',payload:{defaultApprovalMode:'autonomous'}});
    let view=(await t.app.inject('/api/system-installs/settings')).json();expect(view.policy).toBe('ask');
    expect((await t.app.inject({method:'PATCH',url:'/api/system-installs/settings',payload:{policy:'ai',reviewerModel:'independent-reviewer',revision:view.revision}})).statusCode).toBe(200);
    await t.start();const item=t.store.installs()[0];expect(item.settings.reviewerModel).toBe('independent-reviewer');expect(item.state).toBe('succeeded');
    expect(t.store.chat(t.chat.id).models).toEqual(models);
    expect(t.store.getState<any[]>(BUDGET_STATE_KEY,[])).toEqual(expect.arrayContaining([expect.objectContaining({role:'critic',status:'reported',tokens:32})]));
    expect(JSON.stringify((await t.app.inject('/api/system-installs/history')).json())).not.toMatch(/PRIVATE_CONFIG_KEY|decisionNonce|control.sock/);
  });
  it('all new mutation endpoints retain host/origin/JSON and strict body restrictions',async()=>{
    const t=await fixture();await t.start();const id=t.store.installs()[0].id;
    for(const [method,url,payload] of [['PATCH','/api/system-installs/settings',{policy:'auto',revision:0}],['POST',`/api/system-installs/${id}/refresh`,{}],['POST',`/api/system-installs/${id}/status`,{}],['POST',`/api/system-installs/${id}/reconcile`,{}]] as const){
      expect((await t.app.inject({method,url,payload,headers:{origin:'https://evil.example'}})).statusCode).toBe(403);
      expect((await t.app.inject({method,url,payload,headers:{host:'evil.example'}})).statusCode).toBe(403);
      expect((await t.app.inject({method,url,payload:'{}',headers:{'content-type':'text/plain'}})).statusCode).toBe(415);
      expect((await t.app.inject({method,url,payload:{...payload,decisionNonce:'forged'}})).statusCode).toBe(400);
    }
    expect(t.helper.execute).not.toHaveBeenCalled();
  });
  it('plan-only rejects the action under auto policy without preparation',async()=>{
    const t=await fixture();t.installs.update({policy:'auto',revision:0});await t.start('/plan Build');
    expect(t.helper.prepare).not.toHaveBeenCalled();expect(t.store.installs()).toHaveLength(0);expect(t.store.messages(t.chat.id).some(m=>m.content.includes('unavailable in this mode'))).toBe(true);
  });
  it('mode/steering during final context refresh prevents execute',async()=>{
    const t=await fixture();t.installs.update({policy:'auto',revision:0});const block=deferred<PackageHelperRecord>();
    const authorize=t.helper.authorize.getMockImplementation()!;
    t.helper.authorize.mockImplementationOnce(async input=>{const row=await authorize(input);await block.promise;return row;});
    const running=t.start();await vi.waitFor(()=>expect(t.helper.authorize).toHaveBeenCalled());
    await t.runtime.submit(t.chat.id,'/plan Wait');block.resolve(t.records.values().next().value!);await running;
    expect(t.helper.execute).not.toHaveBeenCalled();expect(t.store.installs()[0].state).toBe('stale');
  });
  it('deletion preserves pending correlation and history survives later removal',async()=>{
    const t=await fixture();await t.start();const item=t.store.installs()[0];
    expect((await t.app.inject({method:'DELETE',url:`/api/chats/${t.chat.id}`,payload:{}})).statusCode).toBe(409);
    await t.runtime.control(t.chat.id,'pause');expect(t.store.install(item.id).state).toBe('stale');
    expect((await t.app.inject({method:'DELETE',url:`/api/chats/${t.chat.id}`,payload:{}})).statusCode).toBe(200);
    expect((await t.app.inject('/api/system-installs/history')).json().items[0].id).toBe(item.id);
  });
  it('removal itself expires pending previews, clears obsolete awaiting status and retains correlation',async()=>{
    const t=await fixture();await t.start();const item=t.store.installs()[0];t.store.saveInstall({...item,expiresAt:Date.now()-1});
    const removed=await t.app.inject({method:'DELETE',url:`/api/chats/${t.chat.id}`,payload:{}});
    expect(removed.statusCode,removed.body).toBe(200);
    expect(t.store.install(item.id)).toMatchObject({state:'stale',code:'PREVIEW_EXPIRED'});
  });
  it('shows independent settings directly after workspace approvals and renders package metadata as text',async()=>{
    const settings=renderToStaticMarkup(createElement(SettingsDialog,{onClose(){}}));
    expect(settings.indexOf('System installs')).toBeGreaterThan(settings.indexOf('Default for future chats'));
    expect(settings.indexOf('System installs')).toBeLessThan(settings.indexOf('Debug mode'));
    for(const name of ['Ask every time','Auto-approve','AI review','Install reviewer model'])expect(settings).toContain(name);
    const t=await fixture();await t.start();const approval=t.store.getApproval(t.store.installs()[0].id);approval.install!.recommendation.reason='<script>evil()</script>';
    const markup=renderToStaticMarkup(createElement(ApprovalCard,{approval,refresh:async()=>{}}));
    for(const value of ['Linux target:','hello','1.0','root','triggers','No upgrades','Preview expires'])expect(markup).toContain(value);
    expect(markup).not.toContain('<script>');expect(markup).not.toContain('decisionNonce');
  });
});
