import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentResponse } from '../shared/types.js';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { StarkProvider } from '../server/provider.js';
import { createManagedHooks } from '../server/context.js';
import { Store } from '../server/store.js';
import { BUDGET_STATE_KEY, type Reservation } from '../server/scheduler.js';
import { WorkspaceTools } from '../server/tools/index.js';

const roots: string[] = []; const servers: Server[] = [];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
const action = (name: string,args: Record<string,unknown>): AgentResponse => ({version:1,type:'action',message:'',action:{name,args}});
const final = (message: string): AgentResponse => ({version:1,type:'final',message});

async function fakeStark(responses: AgentResponse[]) {
  const requests: {model:string;messages:unknown[];tools?:unknown;response_format?:unknown}[] = [];
  const server = createServer(async(req,res)=> {
    if (req.url === '/v1/models') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'gemini-3.1-pro-preview'}]}));return;}
    const chunks: Buffer[] = [];for await(const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
    const response = responses.shift();
    if (!response) {res.statusCode=500;res.end();return;}
    res.setHeader('Content-Type','text/event-stream');
    const text = JSON.stringify(response);
    for(let index=0;index<text.length;index+=13) res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{content:text.slice(index,index+13)},finish_reason:null}]})}\n\n`);
    res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  });servers.push(server);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,requests};
}
describe('real HTTP provider + runtime + workspace integration',()=> {
  it('streams through architect/coder/critic, resumes persisted approval, and preserves the exact file diff',async()=> {
    const root = await mkdtemp(path.join(tmpdir(),'harness-integration-'));roots.push(root);
    const oldContent='Original label\n';const newContent='Updated label\n';
    const hash=createHash('sha256').update(oldContent).digest('hex');
    const fake=await fakeStark([
      action('delegate',{objective:'Update label',acceptanceCriteria:['Only change label.txt'],paths:['label.txt']}),
      action('read_file',{path:'label.txt'}),
      action('write_file',{path:'label.txt',content:newContent,baseHash:hash}),
      final('Updated label.txt.'),
      action('read_file',{path:'label.txt'}),
      action('review_result',{verdict:'pass',findings:['The actual file matches the requested label.']}),
      final('The label is updated and independently reviewed.'),
    ]);
    const config=readConfig({STARK_BASE_URL:fake.baseUrl,STARK_API_KEY:'test-only-provider-key',HARNESS_DATA_DIR:path.join(root,'state')});
    const build=async()=>{
      const store = new Store(path.join(config.dataDir,'state.sqlite'));
      const provider = new StarkProvider({baseUrl:fake.baseUrl,apiKey:config.apiKey,maxRetries:0});
      const built = await createApp({config,provider,store,tools:new WorkspaceTools(),hooks:createManagedHooks(provider,store,config)});
      built.app.addHook('onClose',async()=>store.close());
      return built;
    };
    const first=await build();
    const projectReply=await first.app.inject({method:'POST',url:'/api/projects',payload:{name:'Integration project',path:path.join(root,'project'),mode:'create'}});
    expect(projectReply.statusCode).toBe(201);const project=projectReply.json();
    await writeFile(path.join(project.path,'label.txt'),oldContent);
    const chat=(await first.app.inject({method:'POST',url:`/api/projects/${project.id}/chats`,payload:{approvalMode:'review'}})).json();
    await first.app.inject({method:'POST',url:`/api/chats/${chat.id}/messages`,payload:{content:'Update the label'}});await first.runtime.wait(chat.id);
    const approval=first.store.approvals(chat.id)[0];
    expect(first.store.chat(chat.id).status).toBe('awaiting_approval');
    expect(approval.inspection.before).toBe(oldContent);expect(approval.inspection.after).toBe(newContent);
    expect(await readFile(path.join(project.path,'label.txt'),'utf8')).toBe(oldContent);
    await first.app.close();
    const next=await build();
    try {
      expect(next.store.messages(chat.id)[0].content).toBe('Update the label');
      expect((await next.app.inject({method:'POST',url:`/api/approvals/${approval.id}`,payload:{decision:'approve'}})).statusCode).toBe(200);
      await next.runtime.wait(chat.id);
      expect(next.store.chat(chat.id).status).toBe('idle');
      expect(await readFile(path.join(project.path,'label.txt'),'utf8')).toBe(newContent);
      expect(next.store.messages(chat.id).at(-1)?.content).toContain('independently reviewed');
      expect(new Set(fake.requests.map(request=>request.model))).toEqual(new Set(Object.values(config.models)));
      expect(fake.requests.every(request=>request.tools===undefined && request.response_format===undefined)).toBe(true);
      expect(next.store.events(chat.id).some(event=>event.type==='delta')).toBe(true);
      const ledger = next.store.getState<Reservation[]>(BUDGET_STATE_KEY,[]);
      expect(ledger).toHaveLength(fake.requests.length);
      expect(ledger.every(entry=>entry.status==='estimated')).toBe(true);
      expect((await next.app.inject({method:'POST',url:`/api/approvals/${approval.id}`,payload:{decision:'approve'}})).statusCode).toBe(409);
    } finally {await next.app.close();}
  });
});
