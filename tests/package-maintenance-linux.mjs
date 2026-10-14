/** Actual dpkg transactions in the disposable authorized GitHub Ubuntu runner. */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
if(process.platform!=='linux'||process.env.GITHUB_ACTIONS!=='true')throw new Error('Disposable Linux CI only');
const desktop='build/release/'+readdirSync('build/release').find(n=>n.endsWith('.deb'));
const sudo=(...args)=>execFileSync('/usr/bin/sudo',args,{stdio:'pipe'});
const refused=(...args)=>{let failed=false;try{sudo(...args);}catch{failed=true;}assert(failed,'Maintenance unexpectedly succeeded');};
const marker='/var/lib/abyssus-package/maintenance';
const receipt=readFileSync('/opt/abysSUS/package-integrity.json','utf8');
const holder=spawn('/opt/abyssus/runtime/bin/node',['-e',"require('/opt/abysSUS/resources/app/desktop/package-lease.node');console.log('held');process.stdin.resume();"],{stdio:['pipe','pipe','inherit']});
await once(holder.stdout,'data');
refused('/usr/bin/dpkg','--remove','react-harness');
assert.equal(readFileSync('/opt/abysSUS/package-integrity.json','utf8'),receipt);
holder.stdin.end();await once(holder,'exit');
console.log('PASS actual dpkg removal refused by native process lease without changing payload');
sudo('/usr/bin/dpkg','--unpack',desktop);
assert(existsSync(marker+'/desktop'));
let denied=false;try{execFileSync('/opt/abyssus/runtime/bin/node',['-e',"require('/opt/abysSUS/resources/app/desktop/package-lease.node')"],{stdio:'pipe'});}catch{denied=true;}assert(denied);
const file='/opt/abysSUS/resources/app/release.json',backup=file+'.ci-preserved';
sudo('/usr/bin/mv',file,backup);
try{refused('/usr/bin/dpkg','--configure','react-harness');assert(existsSync(marker+'/desktop'));}
finally{sudo('/usr/bin/mv',backup,file);}
sudo('/usr/bin/dpkg','--configure','react-harness');assert(!existsSync(marker));
console.log('PASS unpack interruption blocks launch; failed postinst retains marker; exact repair configures safely');
sudo('/usr/bin/dpkg','--install','build/bundled/abyssus-helper-staging.deb');
refused('/usr/bin/dpkg','--remove','abyssus-backend');
assert(existsSync('/usr/lib/abyssus-helper/launcher'));
sudo('/usr/bin/dpkg','--remove','abyssus-helper-staging');assert(!existsSync(marker));
console.log('PASS optional helper staging dependency protects backend and explicit removal preserves runtime');
