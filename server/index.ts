import 'dotenv/config';
import { readConfig } from './config.js';
import { createApp } from './app.js';
import { StarkProvider } from './provider.js';
import { parseAgentResponse, protocolInstructions } from './protocol.js';
import { WorkspaceTools } from './tools/index.js';

const config = readConfig();
const provider = new StarkProvider({baseUrl:config.baseUrl,apiKey:config.apiKey,streaming:config.streaming,maxRetries:0});
const {app} = await createApp({config,provider,tools:new WorkspaceTools(),hooks:{parse:parseAgentResponse,instructions:protocolInstructions}});
await app.listen({ host: config.host, port: config.port });
console.log(`Harness backend: http://${config.host}:${config.port}`);
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=> {void app.close().then(()=>process.exit(0));});
