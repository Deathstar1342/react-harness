/** Build-time Linux staging only. No host installation or privileged operations. */
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='linux'||process.arch!=='x64')throw new Error('Stage the backend runtime on Linux x64; never reuse Windows native modules.');
const version='24.16.0',archive=`node-v${version}-linux-x64.tar.xz`;
// Official https://nodejs.org/dist/v24.16.0/SHASUMS256.txt, verified for M20.
const sha='d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9';
const response=await fetch(`https://nodejs.org/dist/v${version}/${archive}`,{redirect:'error'});
if(!response.ok)throw new Error('Runtime download failed');
const bytes=Buffer.from(await response.arrayBuffer());
if(createHash('sha256').update(bytes).digest('hex')!==sha)throw new Error('Runtime archive checksum mismatch');
await mkdir(root+'build/runtime',{recursive:true});await writeFile(root+'build/'+archive,bytes);
execFileSync('/usr/bin/tar',['-xJf',root+'build/'+archive,'--strip-components=1','-C',root+'build/runtime'],{stdio:'inherit'});
const node=root+'build/runtime/bin/node',npm=root+'build/runtime/lib/node_modules/npm/bin/npm-cli.js';
const env={...process.env,PATH:root+'build/runtime/bin:'+process.env.PATH};delete env.NODE_OPTIONS;delete env.NODE_PATH;
// Original lockfile supplies exact production dependency versions and integrity.
await cp(root+'package.json',root+'build/app/package.json');await cp(root+'package-lock.json',root+'build/app/package-lock.json');
execFileSync(node,[npm,'ci','--omit=dev'],{cwd:root+'build/app',env,stdio:'inherit'});
const actual=JSON.parse(execFileSync(node,['-e',"const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.close();require('node-pty');console.log(JSON.stringify({nodeVersion:process.versions.node,modules:process.versions.modules,platform:process.platform,arch:process.arch}))"],{cwd:root+'build/app',env,encoding:'utf8'}));
if(actual.nodeVersion!==version)throw new Error('Runtime version mismatch');
await writeFile(root+'build/runtime/manifest.json',JSON.stringify({...actual,nodeSha256:createHash('sha256').update(await readFile(node)).digest('hex')}));
console.log('Dedicated runtime staged; ABI/module load verified. Required PTY/sandbox execution is a separate gate.');
