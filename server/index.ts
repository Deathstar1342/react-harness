import { startBackend } from './bootstrap.js';

try {
  const backend=await startBackend();
  console.log(`Harness backend: ${backend.address}`);
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{
    void backend.close().then(()=>process.exit(0),()=>{console.error('Backend shutdown failed; ownership is retained until process exit');process.exitCode=1;});
  });
} catch(error) {
  const message=error instanceof Error ? error.message : 'Unknown startup failure';
  const secrets=[process.env.STARK_API_KEY,process.env.HARNESS_LAUNCH_KEY].filter(Boolean) as string[];
  console.error(secrets.reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),message));
  process.exitCode=1;
}
