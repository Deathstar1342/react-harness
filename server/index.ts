import 'dotenv/config';
import { readConfig } from './config.js';
import { createApp } from './app.js';
import { StarkProvider } from './provider.js';
import path from 'node:path';
import { createManagedHooks } from './context.js';
import { Store } from './store.js';
import { WorkspaceTools } from './tools/index.js';

const config = readConfig();
const provider = new StarkProvider({baseUrl:config.baseUrl,apiKey:config.apiKey,streaming:config.streaming,maxRetries:0});
const store = new Store(path.join(config.dataDir,'state.sqlite'));
const {app} = await createApp({config,provider,store,tools:new WorkspaceTools(),hooks:createManagedHooks(provider,store,config)});
app.addHook('onClose',async()=>store.close());
await app.listen({ host: config.host, port: config.port });
console.log(`Harness backend: http://${config.host}:${config.port}`);
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=> {void app.close().then(()=>process.exit(0));});
