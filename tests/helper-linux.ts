/** Required disposable Ubuntu CI only. Never run on a developer workstation. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { PackageHelperClient } from '../server/package-helper.js';
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

admin('setup',String(process.getuid!()));
let client=await connect();
const hello=await client.hello();
assert.equal(hello.target.distribution,'ubuntu');
const prepare=()=>client.prepare({requestId:randomUUID(),targetId:hello.target.id,manager:'apt',packages:[{name:'hello'}]});
console.log('PASS real setup, static launcher, non-root authenticated socket/hello');
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
console.log('PASS real apt install, authenticated preview, forged/expired/reused decision, installed no-op');
admin('repair');client=await connect();
assert.equal((await client.status(record.requestId)).state,'succeeded');
assert.equal((await client.hello()).target.id,hello.target.id);
console.log('PASS repair rotates authority while preserving target/audit/outcome');
admin('uninstall');
assert.equal(sudo('/usr/bin/test','-f','/var/lib/abyssus-helper/audit.sqlite'),'');
assert.match(execFileSync('/usr/bin/dpkg-query',['-W','-f=${Status}','hello'],{encoding:'utf8'}),/install ok installed/);
await assert.rejects(PackageHelperClient.connect());
console.log('PASS uninstall removes authority and preserves audit/packages');
