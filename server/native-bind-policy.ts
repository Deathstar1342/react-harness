/** Controller-local presentation of a host-attested Windows bind layout.
 * This digest-bound record cannot create host proof authority or arbitrary paths.
 * It is installed once before profile access by a fixed trusted launch only.
 */
import { createHash } from 'node:crypto';
import { lstatSync,readFileSync,realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
const hex=z.string().regex(/^[a-f0-9]{64}$/),image=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identity=z.object({dev:z.string().regex(/^[0-9]{1,30}$/),ino:z.string().regex(/^[0-9]{1,30}$/)}).strict();
export const nativeBindPolicySchema=z.object({version:z.literal(1),revision:z.literal(1),platform:z.literal('win32'),storageClass:z.literal('native-ntfs'),phase:z.enum(['initialize','controller']),
 storageId:z.uuid(),launchId:z.uuid(),proofId:z.uuid(),probeRevision:z.literal(1),engineId:z.string().min(1).max(256).regex(/^[!-~]+$/),context:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),controllerImage:image,probeImage:image,
 issuedAt:z.number().int().safe().positive(),expiresAt:z.number().int().safe().positive(),slots:z.object({state:identity,config:identity,workspace:identity,control:identity}).strict(),
 broker:z.object({sessionId:z.uuid(),host:z.string().max(64),port:z.number().int().min(1024).max(65535)}).strict().nullable()}).strict();
type Policy=z.infer<typeof nativeBindPolicySchema>;
const rootsFor=(phase:Policy['phase'])=>phase==='initialize'?{state:'/initialize/state',config:'/initialize/config',workspace:'/initialize/workspace',control:'/run/abyssus-broker'}:{state:'/abyssus',config:'/abyssus/profile/config',workspace:'/workspace',control:'/run/abyssus-broker'};
export class NativeBindPolicy {
 readonly roots:ReturnType<typeof rootsFor>;
 private constructor(readonly record:Policy){this.roots=rootsFor(record.phase);}
 static load(env:NodeJS.ProcessEnv):NativeBindPolicy|undefined {
  if(env.HARNESS_NATIVE_BIND_DIGEST===undefined)return undefined;
  const expected=hex.parse(env.HARNESS_NATIVE_BIND_DIGEST),file='/run/abyssus-broker/native-bind.json';
  if(process.platform!=='linux'||env.HARNESS_EXECUTION_MODE!=='container')throw new Error('Native bind policy is restricted to fixed container launch');
  const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>16384||realpathSync(file)!==file)throw new Error('Invalid fixed bind policy');
  const raw=readFileSync(file);if(createHash('sha256').update(raw).digest('hex')!==expected)throw new Error('Native bind policy digest changed');
  const record=nativeBindPolicySchema.parse(JSON.parse(raw.toString('utf8'))),now=Date.now();
  if(record.launchId!==env.HARNESS_LAUNCH_ID||record.storageId!==env.HARNESS_STORAGE_ID||record.issuedAt>now||record.expiresAt<now||record.expiresAt-record.issuedAt>30000||record.expiresAt<=record.issuedAt)throw new Error('Native bind policy is stale or changed');
  if(new Set(Object.values(record.slots).map(v=>v.dev+':'+v.ino)).size!==4)throw new Error('Native bind slots must be distinct');
  if(record.phase==='controller'&&!record.broker||record.phase==='initialize'&&record.broker)throw new Error('Native bind phase changed');
  if(record.broker&&!privateBrokerHost(record.broker.host))throw new Error('Unproven broker host');
  const result=new NativeBindPolicy(record);result.verifyRoots();return result;
 }
 verifyRoots(){
  for(const [name,root] of Object.entries(this.roots)){
   const st=lstatSync(root,{bigint:true}),expected=this.record.slots[name as keyof Policy['slots']];
   if(!st.isDirectory()||st.isSymbolicLink()||realpathSync(root)!==root||String(st.dev)!==expected.dev||String(st.ino)!==expected.ino)throw new Error('Attested bind root changed');
  }
  // A declared config mount nested under state is allowed; no undeclared mount
  // can inherit the permission presentation exception by path prefix alone.
  const declared=new Set(Object.values(this.roots)),seen=new Set<string>();
  for(const line of readFileSync('/proc/self/mountinfo','utf8').trim().split('\n')){
   const raw=line.split(' ')[4];if(!raw)throw new Error('Invalid mount inventory');
   const mount=raw.replace(/\\([0-7]{3})/g,(_,v:string)=>String.fromCharCode(parseInt(v,8)));
   if(declared.has(mount)){seen.add(mount);const readonly=line.split(' ')[5]?.split(',').includes('ro');if(readonly!==(mount===this.roots.control))throw new Error('Bind access mode changed');}
   if(Object.values(this.roots).some(root=>mount.startsWith(root+'/'))&&!declared.has(mount))throw new Error('Undeclared nested bind mount');
  }
  if(seen.size!==declared.size)throw new Error('Attested mount is absent');
 }
 permits(filename:string,privateClass=true):boolean {
  if(!path.posix.isAbsolute(filename)||path.posix.normalize(filename)!==filename||filename.length>4096)return false;
  const entries=Object.entries(this.roots).filter(([,root])=>filename===root||filename.startsWith(root+'/')).sort((a,b)=>b[1].length-a[1].length);
  if(!entries.length||privateClass&&entries[0]![0]==='workspace')return false;
  this.verifyRoots();const [name,root]=entries[0]!,relative=path.posix.relative(root,filename),parts=relative?relative.split('/'):[];
  if(parts.length>64)return false;let current=root;
  for(const part of parts){current+='/'+part;const st=lstatSync(current,{bigint:true});if(st.isSymbolicLink()||!st.isDirectory()&&!st.isFile()||st.isFile()&&st.nlink!==1n||String(st.dev)!==this.record.slots[name as keyof Policy['slots']].dev||realpathSync(current)!==current)return false;}
  return true;
 }
}
export function privateBrokerHost(host:string){
 if(host==='host.docker.internal')return true;
 const fields=host.split('.');if(fields.length!==4||fields.some(x=>!/^\d{1,3}$/.test(x)||String(Number(x))!==x||Number(x)>255))return false;
 const a=Number(fields[0]),b=Number(fields[1]);return a===10||a===172&&b>=16&&b<=31||a===192&&b===168;
}
