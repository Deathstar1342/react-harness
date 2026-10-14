import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { boundedProcess, firstLine } from './process.js';
import { descriptorSchema, failureSchema, loopbackAddress } from './backend-wire.js';
import { parseDistributions, startSchema } from './policy.js';
import { signBackendRequest, verifyBackendProof } from '../server/lifecycle.js';
import type { BackendIdentity } from '../shared/types.js';
import type { DesktopStatus, Environment } from './contracts.js';
import type { BackendTarget } from './proxy.js';

export class DesktopController {
  state:DesktopStatus={platform:process.platform,phase:'setup',distributions:[],message:'Select the Linux environment and persistent profile to use.'};
  private child?:ChildProcessWithoutNullStreams;
  private key?:string;
  private identity?:BackendIdentity;
  private active?:BackendTarget;
  private busy=false;
  constructor(private readonly appRoot:string,private readonly changed:()=>void=()=>{}){}
  target(){return this.state.phase==='ready'?this.active:undefined;}
  private wsl(){return path.join(process.env.SystemRoot??'C:\\Windows','System32','wsl.exe');}
  async inventory() {
    if(process.platform==='win32')try{this.state.distributions=parseDistributions(await boundedProcess(this.wsl(),['--list','--verbose'],{cwd:process.env.SystemRoot??'C:\\Windows'}));}
    catch{this.state.message='WSL is unavailable. Install a supported Ubuntu/Debian WSL2 environment through your administrator.';}
    return this.state;
  }
  private command(environment:Environment,entry:'backend-entry.js'|'helper-entry.js',args:string[]=[]) {
    if(environment.kind==='wsl') {
      if(process.platform!=='win32'||!this.state.distributions.includes(environment.distribution))throw new Error('Select an available Ubuntu/Debian WSL2 environment');
      return {file:this.wsl(),args:['--distribution',environment.distribution,'--exec','/opt/abyssus/runtime/bin/node',`/opt/abyssus/app/desktop/${entry}`,...args],cwd:process.env.SystemRoot??'C:\\Windows'};
    }
    if(process.platform!=='linux')throw new Error('A Windows shell requires an explicitly selected WSL2 backend');
    const runtime=path.resolve(this.appRoot,'../runtime'),node=path.join(runtime,'bin/node');
    const manifest=z.object({nodeVersion:z.string(),modules:z.string(),platform:z.literal('linux'),arch:z.literal('x64'),nodeSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(readFileSync(path.join(runtime,'manifest.json'),'utf8')));
    if(createHash('sha256').update(readFileSync(node)).digest('hex')!==manifest.nodeSha256)throw new Error('Packaged Node runtime hash mismatch. Repair installation.');
    return {file:node,args:[path.join(this.appRoot,'desktop',entry),...args],cwd:this.appRoot};
  }
  async start(raw:unknown) {
    if(this.busy||this.child)throw new Error('An owned backend is still starting, running or draining. Finish its shutdown first.');
    const input=startSchema.parse(raw);this.busy=true;
    try {
      const command=this.command(input.environment,'backend-entry.js');
      this.state={...this.state,phase:'starting',selection:{environment:input.environment,home:input.home},message:'Checking the selected environment and profile…'};this.changed();
      const key=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex');
      // Strip all launch/control overrides inherited by Electron. User provider overrides
      // remain backend-only; no credentials are supplied to project processes.
      const env={...process.env};for(const name of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','HARNESS_INIT','HARNESS_LEGACY_ROOT','HARNESS_MIGRATION_RETRY','HARNESS_LAUNCH_KEY'])delete env[name];
      const child=spawn(command.file,command.args,{cwd:command.cwd,env,windowsHide:true,stdio:'pipe'});this.child=child;
      child.stderr.on('data',()=>{});
      child.once('close',()=>{
        if(this.child!==child)return;this.child=undefined;this.active=undefined;this.key=undefined;this.identity=undefined;
        const deliberate=this.state.phase==='stopping';this.state.phase=deliberate?'setup':'failed';
        this.state.message=deliberate?'Backend stopped after local cleanup.':'Backend exited. Keep this profile selected and explicitly reopen it to inspect recovery; no actions will be replayed.';this.changed();
      });
      const response=firstLine(child);child.stdin.write(JSON.stringify({home:input.home,mode:input.mode,legacyRoot:input.legacyRoot,key,token})+'\n');
      const frame=await response,failure=failureSchema.safeParse(frame);
      if(failure.success){this.state.checks=failure.data.checks;throw new Error(failure.data.error);}
      const descriptor=descriptorSchema.parse(frame),address=loopbackAddress(descriptor.address);
      const request=signBackendRequest(key,'readiness',descriptor.identity.instanceId);
      const proof=await fetch(address+'/api/backend/readiness',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(5000)}).then(r=>r.json());
      if(!verifyBackendProof(key,'readiness',request,proof)||proof.identity.profileId!==descriptor.identity.profileId||proof.identity.state!=='ready'||this.child!==child)throw new Error('Backend readiness identity mismatch');
      this.identity=descriptor.identity;this.key=key;this.active={address,token,sessionId:`${descriptor.identity.profileId}/${descriptor.identity.instanceId}`};
      this.state={...this.state,phase:'ready',sessionId:`${descriptor.identity.profileId}/${descriptor.identity.instanceId}`,checks:descriptor.checks,message:'Connected to the selected Linux profile.'};this.changed();
      return this.state;
    }catch(error){this.state.phase='failed';this.state.message=error instanceof Error?error.message:'Desktop launch failed';this.changed();throw error;}
    finally{this.busy=false;}
  }
  async stop() {
    if(this.busy)throw new Error('Wait for setup to finish before closing.');
    const child=this.child;if(!child)return;
    this.state.phase='stopping';this.state.message='Waiting for tools and system-install calls to finish. Closing does not roll back changes.';this.changed();
    const exited=child.exitCode!==null||child.signalCode!==null||!child.pid?Promise.resolve():once(child,'close');
    if(this.key&&this.identity&&this.active) {
      const request=signBackendRequest(this.key,'shutdown',this.identity.instanceId);
      const proof=await fetch(this.active.address+'/api/backend/shutdown',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(5000)}).then(r=>r.json());
      if(!verifyBackendProof(this.key,'shutdown',request,proof))throw new Error('Shutdown identity could not be verified');
    } else child.stdin.end(); // Owned process pipe EOF requests cleanup; never kill by PID/port.
    await exited;
  }
  async helper(action:'setup'|'repair'|'uninstall') {
    if(this.busy||this.state.phase!=='ready'||!this.state.selection)throw new Error('Open the selected profile before helper setup.');
    // Drain current API/tools/install calls before changing helper authority.
    await this.stop();
    this.busy=true;
    try {
      const command=this.command(this.state.selection.environment,'helper-entry.js',[action]);
      // No timeout/kill for privileged setup; actual OS exit and postchecks decide.
      const result=await new Promise<unknown>((resolve,reject)=>{
        const child=spawn(command.file,command.args,{cwd:command.cwd,windowsHide:true,stdio:['ignore','pipe','ignore'],env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''}});let output='';
        child.stdout.on('data',chunk=>{if(output.length<65536)output+=chunk.toString();});
        child.once('error',()=>reject(new Error('Helper setup adapter unavailable')));
        child.once('exit',code=>{try{if(code!==0)throw new Error();resolve(JSON.parse(output));}catch{reject(new Error('Helper operation cancelled, denied or unverified. Check trusted staging, systemd and OS authentication agent.'));}});
      });
      this.state.helper=z.object({available:z.boolean(),target:z.string().max(512).optional()}).strict().parse(result);
      this.state.message=action==='uninstall'?'Helper authority removed; packages, audit and user data preserved.':'Authenticated helper identity verified.';
      return this.state;
    }finally{this.busy=false;this.changed();}
  }
}
