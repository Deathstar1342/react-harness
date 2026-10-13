import { loadBackendConfig } from './provider-settings.js';
import { createApp } from './app.js';
import { ReloadingProvider } from './provider.js';
import path from 'node:path';
import { createManagedHooks } from './context.js';
import { Store } from './store.js';
import { WorkspaceTools } from './tools/index.js';
import { loadPromptExtensions } from './prompts.js';

const {config,file} = loadBackendConfig();
const promptExtensions = await loadPromptExtensions(config);
const provider = new ReloadingProvider(()=>({baseUrl:config.baseUrl,apiKey:config.apiKey,streaming:config.streaming,maxRetries:0}));
const store = new Store(path.join(config.dataDir,'state.sqlite'));
const {app} = await createApp({config,provider,store,providerSettingsFile:file,tools:new WorkspaceTools(),hooks:createManagedHooks(provider,store,config,{promptExtensions})});
app.addHook('onClose',async()=>store.close());
await app.listen({ host: config.host, port: config.port });
console.log(`Harness backend: http://${config.host}:${config.port}`);
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=> {void app.close().then(()=>process.exit(0));});
