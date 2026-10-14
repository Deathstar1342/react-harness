import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Store } from '../server/store.js';
import { InstallService } from '../server/installs.js';
import { ReloadingProvider } from '../server/provider.js';
import { createManagedHooks } from '../server/context.js';
import { readConfig } from '../server/config.js';
import { BUDGET_STATE_KEY } from '../server/scheduler.js';
import { randomUUID } from 'node:crypto';
import { fakeHelper } from './install-fixture.js';

let server:Server|undefined;
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}});
it.each([429,502,503,504])('review HTTP %s makes one transport attempt then asks; ordinary defaults retain retries',async status=>{
  const bodies:Record<string,unknown>[]=[];
  server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk; bodies.push(JSON.parse(body));res.writeHead(status,{'retry-after':'0'});res.end('not logged');});
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const provider=new ReloadingProvider(()=>({baseUrl,apiKey:'synthetic',streaming:false}));
  const store=new Store(':memory:'),config=readConfig({STARK_BASE_URL:baseUrl,STARK_API_KEY:'synthetic'}),{helper}=fakeHelper();
  const service=new InstallService(store,'reviewer',createManagedHooks(provider,store,config).complete!,async()=>helper);
  try{
    const project=store.createProject('Test','/workspace'),chat=store.createChat(project.id,'Test','autonomous');
    service.update({policy:'ai',revision:0});const item=service.create(randomUUID(),chat.id,'frame','architect',0,{packages:[{name:'hello'}],reason:'Test'});
    expect(await service.advance(item.id,()=>true,new AbortController().signal)).toBeNull();expect(bodies).toHaveLength(1);
    expect(store.install(item.id).state).toBe('pending');expect(helper.execute).not.toHaveBeenCalled();
    expect(store.getState<any[]>(BUDGET_STATE_KEY,[])).toMatchObject([{role:'critic',status:'uncertain',requests:1}]);
    expect(bodies[0]).not.toHaveProperty('noRetry');expect(bodies[0]).not.toHaveProperty('tools');expect(bodies[0]).not.toHaveProperty('response_format');
    await expect(provider.complete({model:'ordinary',messages:[{role:'user',content:'ordinary'}]})).rejects.toThrow();
    expect(bodies).toHaveLength(4); // Existing default: initial attempt plus two retries.
  }finally{await service.close();store.close();}
});
