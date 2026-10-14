/** Required disposable Ubuntu CI only. Never run on a developer workstation. */
import assert from 'node:assert/strict';
import { execFileSync,spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { PackageHelperClient,helperCanonical,helperMac,helperProtocol } from '../server/package-helper.js';
import { readFileSync,writeFileSync,mkdtempSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect as socketConnect } from 'node:net';
import { once } from 'node:events';
import { LinuxSandbox } from '../server/tools/sandbox.js';
import type { PackageHelperRecord } from '../shared/types.js';

assert.equal(process.env.GITHUB_ACTIONS,'true','Disposable GitHub runner required');
assert.equal(process.platform,'linux');assert.notEqual(process.getuid!(),0);
const admin=(...args:string[])=>execFileSync('sudo',['/usr/lib/abyssus-helper/launcher',...args],{encoding:'utf8'});
const sudo=(...args:string[])=>execFileSync('sudo',args,{encoding:'utf8'});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function connect(){
  let last:unknown;
  for(let i=0;i<30;i++)try{const client=await PackageHelperClient.connect();await client.hello();return client;}catch(error){last=error;await delay(1000);}
  throw last;
}
const decision=(record:PackageHelperRecord)=>({requestId:record.requestId,previewDigest:record.previewDigest,decisionNonce:randomBytes(32).toString('hex'),expiresAt:Date.now()+60000});
async function wire(value:unknown):Promise<Record<string,unknown>>{
  return new Promise((resolve,reject)=>{
    const socket=socketConnect('/run/abyssus-helper/control.sock');let result='';
    socket.setTimeout(10000,()=>socket.destroy(new Error('probe timeout')));
    socket.once('connect',()=>socket.write(JSON.stringify(value)+'\n'));
    socket.on('data',chunk=>{result+=chunk.toString();if(result.endsWith('\n')){resolve(JSON.parse(result));socket.end();}});
    socket.once('error',reject);
  });
}
async function fixture(mode:string){
  const child=spawn('sudo',['/usr/bin/python3','-I','-S','/root/abyssus-helper-ci.py',mode]);
  let output='';child.stdout.on('data',chunk=>{output+=chunk.toString();});
  child.stderr.pipe(process.stderr);
  for(let i=0;i<200&&!output.includes('\n');i++){if(child.exitCode!==null)throw new Error('fixture exited');await delay(10);}
  assert(output.includes('\n'),'fixture did not become ready');
  return {child,output:()=>output};
}

admin('setup',String(process.getuid!()));
let client=await connect();
const hello=await client.hello();
assert.equal(hello.target.distribution,'ubuntu');
const prepare=()=>client.prepare({requestId:randomUUID(),targetId:hello.target.id,manager:'apt',packages:[{name:'hello'}]});
console.log('PASS real setup, static launcher, non-root authenticated socket/hello');
sudo('/usr/bin/touch','/usr/lib/python3/dist-packages/abyssus_unvalidated_sentinel.py');
sudo('/usr/bin/chmod','0666','/usr/lib/python3/dist-packages/abyssus_unvalidated_sentinel.py');
execFileSync('/usr/bin/python3',['-I','-S','-c',"import sys,importlib.util;sys.path.insert(0,'/usr/lib/abyssus-helper');import apt_adapter;assert importlib.util.find_spec('abyssus_unvalidated_sentinel') is None;assert '/usr/lib/python3/dist-packages' not in sys.path"]);
sudo('/usr/bin/rm','/usr/lib/python3/dist-packages/abyssus_unvalidated_sentinel.py');
console.log('PASS private apt import directory excludes unrelated writable distro module');
const project=mkdtempSync(tmpdir()+'/abyssus-project-');
writeFileSync(project+'/source.txt','visible project');
const sandbox=new LinuxSandbox();
const confined=await sandbox.launch(project,['/usr/bin/bash','--noprofile','--norc','-c','test -f source.txt && test ! -e /etc/abyssus-helper/client.json && test ! -e /var/lib/abyssus-helper/audit.sqlite && test ! -e /run/abyssus-helper/control.sock && test ! -e /usr/lib/abyssus-helper/launcher && printf M18_CONFINED']);
try{assert.equal(execFileSync(confined.file,confined.args,{env:confined.env,cwd:project,encoding:'utf8'}),'M18_CONFINED');}finally{await confined.close();}
console.log('PASS live helper credentials/socket/audit/code absent inside actual agent namespace');
// Credential read and socket connection both fail for a different local UID.
assert.throws(()=>sudo('-u','nobody','/usr/bin/cat','/etc/abyssus-helper/client.json'));
assert.throws(()=>sudo('-u','nobody','/usr/bin/python3','-I','-S','-c',"import socket;s=socket.socket(socket.AF_UNIX);s.connect('/run/abyssus-helper/control.sock')"));
const descriptor=JSON.parse(readFileSync('/etc/abyssus-helper/client.json','utf8')) as {key:string};
const envelope={protocol:helperProtocol,nonce:randomBytes(32).toString('hex'),expiresAt:Date.now()+10000,action:'hello',body:{}};
const signed={...envelope,mac:helperMac(envelope,descriptor.key)};
assert.equal((await wire({...signed,mac:'0'.repeat(64)})).error,'AUTH_FAILED');
assert.equal((await wire(signed)).ok,true);
assert.equal((await wire(signed)).error,'REPLAY');
const expired={...envelope,nonce:randomBytes(32).toString('hex'),expiresAt:Date.now()-1};
assert.equal((await wire({...expired,mac:helperMac(expired,descriptor.key)})).error,'AUTH_EXPIRED');
const hostileBody={requestId:randomUUID(),targetId:hello.target.id,manager:'apt',packages:[{name:'--help'}]};
const hostile={...envelope,nonce:randomBytes(32).toString('hex'),action:'prepare',body:hostileBody};
assert.equal((await wire({...hostile,mac:helperMac(hostile,descriptor.key)})).error,'INVALID_REQUEST');
console.log('PASS unauthorized UID, forged envelope, nonce replay, expired envelope, helper-side option injection');
const locked=await fixture('lock');
await assert.rejects(prepare(),/PACKAGE_MANAGER_BUSY/);
sudo('/usr/bin/kill','-TERM',locked.output().trim());await once(locked.child,'close');
console.log('PASS actual dpkg frontend lock conflict without package effects');
const stale=await prepare(),staleDecision=decision(stale);await client.authorize(staleDecision);
sudo('/usr/bin/touch','/etc/apt/preferences.d/abyssus-ci-stale');
assert.equal((await client.execute(staleDecision)).code,'STALE_PREVIEW');
sudo('/usr/bin/rm','/etc/apt/preferences.d/abyssus-ci-stale');
console.log('PASS changed privileged apt input invalidates exact preview');
const record=await prepare();
assert.equal(record.state,'prepared');assert(record.preview.packages.some(p=>p.name==='hello'));
const dec=decision(record);
await assert.rejects(client.authorize({...dec,previewDigest:'0'.repeat(64)}),/STALE_PREVIEW/);
await assert.rejects(client.authorize({...dec,expiresAt:Date.now()-1}),/DECISION_EXPIRED/);
await client.authorize(dec);
const installed=await client.execute(dec);
assert.equal(installed.state,'succeeded',JSON.stringify(installed));
await assert.rejects(client.execute(dec),/INVALID_STATE/);
assert.equal((await prepare()).state,'noop');
await assert.rejects(client.prepare({requestId:randomUUID(),targetId:hello.target.id,manager:'apt',packages:[{name:'hello',version:'0.0'}]}),/EXISTING_PACKAGE_CHANGE/);
console.log('PASS real apt install, authenticated preview, forged/expired/reused decision, installed no-op');
// Normal-user writable code/config must fail before Python imports.
for(const file of ['/usr/lib/abyssus-helper/core.py','/usr/lib/abyssus-helper','/etc/abyssus-helper/config.json','/usr/share']){
  sudo('/usr/bin/chmod','g+w',file);
  assert.throws(()=>admin('repair'),/UNTRUSTED_HELPER_PATH/);
  sudo('/usr/bin/chmod','g-w',file);
}
const hostileCwd=mkdtempSync(tmpdir()+'/abyssus-hostile-');
writeFileSync(hostileCwd+'/sitecustomize.py',"open('/tmp/abyssus-hostile-loaded','w').write('bad')");
writeFileSync(hostileCwd+'/apt.py',"open('/tmp/abyssus-hostile-loaded','w').write('bad')");
execFileSync('sudo',['/usr/bin/env',`PYTHONPATH=${hostileCwd}`,'APT_CONFIG=/tmp/nonexistent','LD_LIBRARY_PATH=/tmp','/usr/lib/abyssus-helper/launcher','repair'],{cwd:hostileCwd});
assert(!existsSync('/tmp/abyssus-hostile-loaded'));
client=await connect();
console.log('PASS writable code/config/parent rejection and hostile cwd/environment isolation');
admin('repair');client=await connect();
assert.equal((await client.status(record.requestId)).state,'succeeded');
assert.equal((await client.hello()).target.id,hello.target.id);
console.log('PASS repair rotates authority while preserving target/audit/outcome');
const interruption=await client.prepare({requestId:randomUUID(),targetId:hello.target.id,manager:'apt',packages:[{name:'cowsay'}]});
assert.equal(interruption.state,'prepared');
const interruptedDecision=decision(interruption);await client.authorize(interruptedDecision);
const observer=await fixture('interrupt');
await assert.rejects(client.execute(interruptedDecision),/HELPER_REPLY_UNCERTAIN/);
if(observer.child.exitCode===null)await once(observer.child,'close');
assert.match(observer.output(),/INTERRUPTED_REAL_DPKG/);
admin('repair');client=await connect();
assert.equal((await client.status(interruption.requestId)).state,'uncertain');
await assert.rejects(client.execute(interruptedDecision),/RECOVERY_REQUIRED|INVALID_STATE|DECISION_EXPIRED/);
const reconciliation=await client.reconcile(interruption.requestId);
assert.equal(reconciliation.state,'uncertain');
assert(reconciliation.reconciliation);
console.log('PASS actual dpkg descendant interruption, restart/repair no replay, explicit observations retain uncertainty');
admin('uninstall');
assert.equal(sudo('/usr/bin/test','-f','/var/lib/abyssus-helper/audit.sqlite'),'');
assert.match(execFileSync('/usr/bin/dpkg-query',['-W','-f=${Status}','hello'],{encoding:'utf8'}),/install ok installed/);
await assert.rejects(PackageHelperClient.connect());
console.log('PASS uninstall removes authority and preserves audit/packages');
