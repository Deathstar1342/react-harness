/** Fixed-image identity observation. Never imports or executes project code. */
import {lstatSync,readFileSync} from 'node:fs';
const insist=value=>{if(!value)throw new Error('PROJECT_IDENTITY_REFUSED');};
try {
 let raw='';for await(const chunk of process.stdin){raw+=chunk;insist(raw.length<=8192);}
 const input=JSON.parse(raw),keys=['version','nonce','launchId','storageId','sessionId','project'];
 insist(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).sort().join('|')===keys.sort().join('|'));
 insist(input.version===1&&/^[a-f0-9]{64}$/.test(input.nonce));
 for(const key of ['launchId','storageId','sessionId','project'])insist(typeof input[key]==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input[key]));
 insist(process.getuid()>0&&readFileSync('/workspace/.storage-id','utf8')===input.storageId+'\n');
 const identity=file=>{const value=lstatSync(file,{bigint:true});insist(value.isDirectory()&&!value.isSymbolicLink());return {dev:String(value.dev),ino:String(value.ino)};};
 const workspace=identity('/workspace'),projectIdentity=identity('/workspace/'+input.project);
 insist(workspace.dev===projectIdentity.dev&&workspace.ino!==projectIdentity.ino);
 console.log(JSON.stringify({...input,workspace,identity:projectIdentity}));
}catch{console.error('PROJECT_IDENTITY_REFUSED');process.exitCode=1;}
