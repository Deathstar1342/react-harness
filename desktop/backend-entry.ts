/** Executed only by the dedicated Linux Node runtime, never Electron's Node. */
import { createInterface } from 'node:readline';
import { startBackend } from '../server/bootstrap.js';
import { launchSchema } from './backend-wire.js';
import { runtimeChecks } from './runtime-check.js';
import { installationRoot } from '../server/locations.js';
let size=0;
process.stdin.on('data',(b:Buffer)=>{size+=b.length;if(size>16384)process.exit(2);});
const lines=createInterface({input:process.stdin});
const timer=setTimeout(()=>process.exit(2),15000);
lines.once('line',async line=>{
  clearTimeout(timer);
  try {
    const input=launchSchema.parse(JSON.parse(line));
    const checks=await runtimeChecks();
    if(checks.slice(0,3).some(c=>!c.ok))throw new Error('Runtime prerequisites failed');
    const backend=await startBackend({cwd:installationRoot,installRoot:installationRoot,desktop:true,transportToken:input.token,
      env:{...process.env,HARNESS_HOME:input.home,HARNESS_LAUNCH_KEY:input.key,
        ...(input.mode==='initialize'?{HARNESS_INIT:'1'}:{}),...(input.mode==='migrate'?{HARNESS_LEGACY_ROOT:input.legacyRoot}:{})}});
    process.stdout.write(JSON.stringify({address:backend.address,identity:backend.lifecycle.identity(),checks})+'\n');
    const close=()=>{void backend.close().then(()=>process.exit(0),()=>{process.stderr.write('Backend cleanup failed; ownership retained.\n');});};
    // Main crash/pipe loss drains tools and helper calls. It never replays them.
    process.stdin.once('end',close);process.once('SIGTERM',close);process.once('SIGINT',close);
    backend.app.server.once('close',()=>{void backend.close().then(()=>process.exit(0),()=>{});});
    if(process.stdin.readableEnded)close();
  } catch {
    process.stderr.write('Backend startup failed. Check profile, migration receipt, runtime and ownership.\n');process.exitCode=1;lines.close();process.stdin.destroy();
  }
});
