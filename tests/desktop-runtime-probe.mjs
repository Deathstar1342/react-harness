import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { LinuxSandbox } from '../build/app/server/tools/sandbox.js';
import { runtimeChecks } from '../build/app/desktop/runtime-check.js';
assert.equal(process.platform,'linux');assert.equal(process.versions.node,'24.16.0');
const project=mkdtempSync(tmpdir()+'/abyssus-staged-project-'),home=mkdtempSync(tmpdir()+'/abyssus-staged-home-');
const checks=await runtimeChecks();assert(checks.slice(0,5).every(c=>c.ok),JSON.stringify(checks));
const sandbox=new LinuxSandbox();sandbox.configure({home,protectedPaths:[],projects:()=>[project]});
const launched=await sandbox.launch(project,['/opt/node/bin/node','-e',"const{DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').close();console.log(process.versions.node);if(require('fs').existsSync('/opt/abyssus/app')||require('fs').existsSync('/etc/abyssus-helper/client.json'))process.exit(7)"],true);
try{assert.equal(execFileSync(launched.file,launched.args,{cwd:project,env:launched.env,encoding:'utf8'}).trim(),'24.16.0');}
finally{await launched.close();rmSync(project,{recursive:true,force:true});rmSync(home,{recursive:true,force:true});}
console.log('PASS staged Node24 SQLite/node-pty plus actual M17 namespace/registry bridge; app/helper assets absent');
