import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {Writable} from 'node:stream';
import {createInterface} from 'node:readline/promises';
import {z} from 'zod';
import {prepareProfile,privateDirectory,regularFile,durableWrite} from '../server/profile.js';
import {ProviderSettingsFile} from '../server/provider-settings.js';
import {normalizeProviderEndpoint} from '../server/config.js';

type Prompt=(label:string,secret?:boolean)=>Promise<string>;
export class SetupError extends Error {}
const line=z.string().max(1024).regex(/^[^\x00-\x1f\x7f\u2028\u2029]*$/);
const selectionPath=(root:string)=>path.join(root,'.source-setup','home');
export function savedHome(root:string):string|undefined {
  const filename=selectionPath(root);if(!existsSync(filename))return;
  privateDirectory(path.dirname(filename));regularFile(filename);
  const value=readFileSync(filename,'utf8');
  if(value.length>4096||!value.endsWith('\n')||value.slice(0,-1).includes('\n'))throw new SetupError('Saved profile selection is invalid. Preserve it and inspect it before retrying.');
  return value.slice(0,-1);
}
export async function configureSource(root:string,prompt:Prompt,env:NodeJS.ProcessEnv=process.env) {
  for(const name of ['HARNESS_DATA_DIR','HARNESS_LEGACY_ROOT','HARNESS_INIT','HARNESS_SELECT_DATA','HARNESS_MIGRATION_RETRY'])if(env[name]!==undefined)throw new SetupError('Remove explicit migration/data overrides before guided setup. Existing profiles are preserved.');
  const defaultHome=env.HARNESS_HOME??savedHome(root)??path.join(homedir(),'.local','share','abyssus-native');
  const home=(await prompt(`Profile folder [${defaultHome}]: `)).trim()||defaultHome;
  if(!path.isAbsolute(home)||home==='/'||home.startsWith('/mnt/')||/[\x00-\x1f\x7f]/.test(home))throw new SetupError('Choose an absolute Linux profile path outside Windows mounts.');
  const profile=await prepareProfile({env:{HARNESS_HOME:home,HARNESS_INIT:'1'},cwd:root,installRoot:root});
  try {
    const file=new ProviderSettingsFile(profile.paths.configFile,{}),current=file.config();
    const baseInput=(await prompt(`API base URL [${current.baseUrl||'blank: configure later'}]: `)).trim();
    const baseUrl=normalizeProviderEndpoint(baseInput||current.baseUrl);
    const keyInput=await prompt(current.apiKey?'API key (hidden; blank keeps saved key): ':'API key (hidden; blank configures later): ',true);
    const apiKey=line.refine(value=>value===''||Boolean(value.trim())).parse(keyInput||current.apiKey);
    if(baseUrl!==current.baseUrl&&current.apiKey&&!keyInput)throw new SetupError('A changed API endpoint requires a replacement key; the saved key is never sent to a new endpoint.');
    const models={} as Record<'architect'|'coder'|'critic',string>;
    for(const role of ['architect','coder','critic'] as const) {
      const answer=(await prompt(`${role} exact model ID [${current.models[role]}]: `)).trim()||current.models[role];
      models[role]=line.min(1).parse(answer);
    }
    file.write({baseUrl,apiKey,models});file.refreshIdentity();
    // The launcher records only the selected path, never provider values or credentials.
    privateDirectory(path.dirname(selectionPath(root)));durableWrite(selectionPath(root),`${profile.paths.home}\n`);
    return {home:profile.paths.home,configured:Boolean(baseUrl&&apiKey)};
  } finally {profile.ownership.close();}
}
export async function runGuidedSetup(root=path.resolve(import.meta.dirname,'..')) {
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new SetupError('Configuration needs an interactive terminal.');
  let muted=false;
  const output=new Writable({write(chunk,encoding,done){if(!muted)process.stdout.write(chunk,encoding);done();}});
  const controller=new AbortController();
  const rl=createInterface({input:process.stdin,output,terminal:true,historySize:0});
  rl.on('SIGINT',()=>controller.abort());
  rl.on('close',()=>controller.abort());
  const prompt:Prompt=async(label,secret=false)=>{
    if(secret){process.stdout.write(label);muted=true;}
    try {return await rl.question(secret?'':label,{signal:controller.signal});}
    finally {if(secret){muted=false;process.stdout.write('\n');}}
  };
  console.log('Configure your private profile. Exact model IDs must match your work catalog; defaults are not live verified. Blank values keep saved settings.');
  try {
    const result=await configureSource(root,prompt);
    console.log(result.configured?'Provider configuration saved privately. Use Settings → Test connection at work.':'Profile ready. Configure your provider later in Settings.');
  } finally {rl.close();output.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)runGuidedSetup().catch(error=>{
  // Validation/OS errors may contain rejected inputs. Never print them or a stack with secrets.
  console.error(error instanceof SetupError?error.message:'Configuration stopped. Check the selected profile/permissions and single-line values; private inputs are not printed.');process.exitCode=1;
});
