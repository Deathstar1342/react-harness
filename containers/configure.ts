import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { verifyContainerStorage } from '../server/container-storage.js';
import { prepareProfile } from '../server/profile.js';
import { ProviderSettingsFile } from '../server/provider-settings.js';

process.umask(0o077);
try {
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error();
  verifyContainerStorage(process.env.HARNESS_STORAGE_ID ?? '');
  const profile=await prepareProfile({env:{HARNESS_HOME:'/abyssus'},cwd:'/app'});
  let muted=false;
  const output=new Writable({write(chunk,encoding,done){if(!muted)process.stdout.write(chunk,encoding);done();}});
  const rl=createInterface({input:process.stdin,output,terminal:true,historySize:0});
  const abort=new AbortController();rl.on('SIGINT',()=>abort.abort());rl.on('close',()=>abort.abort());
  try {
    const file=new ProviderSettingsFile(profile.paths.configFile,{}),current=file.config();
    console.log('Private provider setup. Blank inputs keep current values. Exact model IDs need work-side verification.');
    const baseUrl=(await rl.question('Provider API base URL: ',{signal:abort.signal})).trim()||current.baseUrl;
    process.stdout.write('Provider API key (hidden; blank keeps saved key): ');muted=true;
    let apiKey:string;
    try {apiKey=(await rl.question('',{signal:abort.signal}))||current.apiKey;}finally{muted=false;process.stdout.write('\n');}
    if(baseUrl!==current.baseUrl&&current.apiKey&&apiKey===current.apiKey)throw new Error();
    const models={...current.models};
    for(const role of ['architect','coder','critic'] as const)models[role]=(await rl.question(`${role} exact model ID (blank keeps current): `,{signal:abort.signal})).trim()||models[role];
    if(baseUrl!==current.baseUrl||apiKey!==current.apiKey||(['architect','coder','critic'] as const).some(role=>models[role]!==current.models[role]))file.write({baseUrl,apiKey,models});
    file.refreshIdentity();
    console.log('Private settings saved. No provider request was made.');
  } finally {rl.close();output.end();profile.ownership.close();}
} catch {console.error('Private setup stopped. Check ownership, inputs, or an already-running controller; private inputs are not printed.');process.exitCode=1;}
