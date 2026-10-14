import { startBackend } from './bootstrap.js';

try {
  const backend=await startBackend();
  console.log(`Harness backend: ${backend.address}`);
  // One-time, five-minute code displayed deliberately to the local operator.
  // No reusable API/lifecycle capability is logged or embedded in a URL.
  console.log(`Browser pairing code (single use, 5 minutes): ${backend.auth.pairingCode}`);
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{
    void backend.close().then(()=>process.exit(0),()=>{console.error('Backend shutdown failed; ownership is retained until process exit');process.exitCode=1;});
  });
} catch(error) {
  const message=error instanceof Error ? error.message : 'Unknown startup failure';
  const secrets=[process.env.STARK_API_KEY,process.env.HARNESS_LAUNCH_KEY].filter(Boolean) as string[];
  console.error(secrets.reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),message));
  process.exitCode=1;
}
