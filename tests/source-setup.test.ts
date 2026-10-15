import {it,expect,afterEach} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {configureSource,savedHome} from '../scripts/source-setup.js';
import {prepareProfile} from '../server/profile.js';
import {ProviderSettingsFile} from '../server/provider-settings.js';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const base=mkdtempSync(path.join(tmpdir(),'source-setup-')),root=path.join(base,'checkout'),home=path.join(base,'private');mkdirSync(root);roots.push(base);return {root,home,env:{HARNESS_HOME:home},file:path.join(home,'profile/config/.env')};}
const answers=(values:string[])=>async()=>{if(!values.length)throw new Error('Unexpected prompt');return values.shift()!;};
const initial=['','https://provider.invalid/v1','synthetic-key-#-$-value','exact-architect','exact-coder','exact-critic'];
it('writes a native profile privately and records only its path for launch, without mutating process credentials',async()=>{
  const t=fixture(),before=process.env.STARK_API_KEY;
  const result=await configureSource(t.root,answers([...initial]),t.env);
  const config=new ProviderSettingsFile(t.file,{}).config();
  expect(config.apiKey).toBe(initial[2]);expect(config.baseUrl).toBe(initial[1]);expect(config.models.coder).toBe(initial[4]);expect(result.configured).toBe(true);
  expect(JSON.parse(readFileSync(path.join(t.home,'profile/profile.json'),'utf8')).protocol).toBe('native-tools-v1');
  expect(savedHome(t.root)).toBe(t.home);expect(readFileSync(path.join(t.root,'.source-setup/home'),'utf8')).not.toContain(initial[2]);expect(process.env.STARK_API_KEY).toBe(before);
  if(process.platform==='linux')expect(statSync(t.file).mode&0o777).toBe(0o600);
});
it('reruns preserve saved credentials, explicit model IDs and profile identity on blank answers',async()=>{
  const t=fixture();await configureSource(t.root,answers([...initial]),t.env);
  const marker=readFileSync(path.join(t.home,'profile/profile.json'),'utf8');
  await configureSource(t.root,answers(['','','','','','']),{});
  expect(new ProviderSettingsFile(t.file,{}).config().apiKey).toBe(initial[2]);expect(new ProviderSettingsFile(t.file,{}).config().models.coder).toBe(initial[4]);expect(readFileSync(path.join(t.home,'profile/profile.json'),'utf8')).toBe(marker);
});
it('cannot move a saved key to another endpoint without explicitly replacing it',async()=>{
  const t=fixture();await configureSource(t.root,answers([...initial]),t.env);const original=readFileSync(t.file,'utf8');
  await expect(configureSource(t.root,answers(['','https://different.invalid/v1','']),t.env)).rejects.toThrow('replacement key');expect(readFileSync(t.file,'utf8')).toBe(original);
});
it('cancellation or invalid credentials leave existing configuration untouched',async()=>{
  const t=fixture();await configureSource(t.root,answers([...initial]),t.env);const original=readFileSync(t.file,'utf8');
  for(const key of ['bad\nkey',' ',"all'\"`quotes"]){await expect(configureSource(t.root,answers(['','',key,'','','']),t.env)).rejects.toThrow();expect(readFileSync(t.file,'utf8')).toBe(original);}
  let prompts=0;await expect(configureSource(t.root,async()=>{if(++prompts===3)throw new Error('cancelled');return '';},t.env)).rejects.toThrow('cancelled');expect(readFileSync(t.file,'utf8')).toBe(original);
});
it('refuses an owned active profile rather than overwriting settings during execution',async()=>{
  const t=fixture();await configureSource(t.root,answers([...initial]),t.env);const original=readFileSync(t.file,'utf8');
  const held=await prepareProfile({env:t.env,cwd:t.root,installRoot:t.root});
  try{await expect(configureSource(t.root,answers(['']),t.env)).rejects.toThrow('owned');expect(readFileSync(t.file,'utf8')).toBe(original);}finally{held.ownership.close();}
});
it('rejects old profile protocols, data redirects and multiline launcher selections without erasing files',async()=>{
  const t=fixture();await configureSource(t.root,answers([...initial]),t.env);const marker=path.join(t.home,'profile/profile.json'),original=readFileSync(t.file,'utf8');
  const data=JSON.parse(readFileSync(marker,'utf8'));data.protocol='old-json';writeFileSync(marker,JSON.stringify(data));
  await expect(configureSource(t.root,answers(['']),t.env)).rejects.toThrow('Incompatible');expect(readFileSync(t.file,'utf8')).toBe(original);
  await expect(configureSource(t.root,answers([]),{...t.env,HARNESS_DATA_DIR:'elsewhere'})).rejects.toThrow('overrides');
  writeFileSync(path.join(t.root,'.source-setup/home'),'/one\n/two\n');expect(()=>savedHome(t.root)).toThrow('invalid');expect(existsSync(t.file)).toBe(true);
});
it('pins the bootstrap archive to the independently verified existing runtime checksum',()=>{
  const root=path.resolve(import.meta.dirname,'..'),common=readFileSync(path.join(root,'scripts/source-common.sh'),'utf8'),stage=readFileSync(path.join(root,'scripts/stage-runtime.mjs'),'utf8');
  const version=common.match(/^SOURCE_NODE_VERSION=(.*)$/m)![1],sha=common.match(/^SOURCE_NODE_SHA=(.*)$/m)![1];expect(stage).toContain(`version='${version}'`);expect(stage).toContain(`sha='${sha}'`);
});
it('refuses profile locations overlapping source before writing profile or launcher data',async()=>{
  const t=fixture();
  for(const home of [t.root,path.join(t.root,'private'),path.dirname(t.root)])await expect(configureSource(t.root,answers([home]),t.env)).rejects.toThrow('separate');
  expect(existsSync(path.join(t.root,'.source-setup'))).toBe(false);expect(existsSync(t.file)).toBe(false);
});
