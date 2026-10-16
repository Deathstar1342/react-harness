import {assertNativePath,nativeStorageActive} from './native-storage.js';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { applicationHome, installationRoot, profilePaths } from './locations.js';
import { ProviderSettingsFile } from './provider-settings.js';

const fail = (message:string) => new Error(message);
export function privateDirectory(directory:string) {
  assertNativePath(directory,true,true);
  mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('Application directory must not be a link');
  if (!nativeStorageActive() && process.platform!=='win32' && (stat.uid!==process.getuid!() || (stat.mode & 0o077)!==0)) throw fail('Application directory must be owned by this user with mode 0700');
}
export function regularFile(filename:string,privateClass=true) {
  assertNativePath(filename,privateClass);
  const stat=lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1) throw fail('Application files must be regular and unlinked');
}
export function durableWrite(filename:string, value:string) {
  assertNativePath(filename,true,true);
  if(existsSync(filename))regularFile(filename);
  const temporary=`${filename}.${randomUUID()}.tmp`;
  const fd=openSync(temporary,'wx',0o600);
  try {writeFileSync(fd,value);fsyncSync(fd);} finally {closeSync(fd);}
  assertNativePath(temporary);assertNativePath(filename,true,true);
  renameSync(temporary,filename);
  // Windows does not support opening directories for fsync. File contents are flushed on both platforms.
  if (process.platform!=='win32') {const dir=openSync(path.dirname(filename),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
}
const json = <T>(filename:string):T => {regularFile(filename);if(lstatSync(filename).size>1024*1024)throw fail('Profile metadata exceeds 1 MiB');return JSON.parse(readFileSync(filename,'utf8')) as T;};
const hash = (filename:string) => {
  regularFile(filename);const fd=openSync(filename,'r'),digest=createHash('sha256'),buffer=Buffer.alloc(65536);
  try {for(let n;(n=readSync(fd,buffer,0,buffer.length,null))>0;)digest.update(buffer.subarray(0,n));return digest.digest('hex');}finally{closeSync(fd);}
};
function treeHash(directory:string):string {
  const digest=createHash('sha256');let count=0;
  const visit=(dir:string,relative:string,depth:number)=>{
    if(depth>64)throw fail('Profile tree is too deep');
    for(const name of readdirSync(dir).sort()) {
      if(++count>10000)throw fail('Profile has too many files');
      const filename=path.join(dir,name),rel=path.join(relative,name),stat=lstatSync(filename);
      if(stat.isSymbolicLink())throw fail('Profile tree must not contain links');
      if(stat.isDirectory()){digest.update(JSON.stringify(['directory',rel]));visit(filename,rel,depth+1);}
      else digest.update(JSON.stringify(['file',rel,hash(filename)]));
    }
  };
  visit(directory,'',0);return digest.digest('hex');
}

/** Never unlink this file: the OS releases SQLite's lock after exit/crash. */
export class ProfileOwnership {
  private db?:DatabaseSync;
  constructor(directory:string) {
    assertNativePath(directory,true,true);
    mkdirSync(directory,{recursive:true,mode:0o700});
    if (lstatSync(directory).isSymbolicLink()) throw fail('Ownership directory must not be a link');
    const canonical=realpathSync(directory),filename=path.join(canonical,'.backend-owner.sqlite');
    if (!existsSync(filename)) {try{closeSync(openSync(filename,'wx',0o600));}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
    regularFile(filename);
    const db=new DatabaseSync(filename);
    try {db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');this.db=db;}
    catch {db.close();throw fail('Profile is owned by another backend; stop that instance before starting or migrating');}
  }
  close() {this.db?.close();this.db=undefined;}
}

export function lockResources(directories:string[]) {
  const locks:ProfileOwnership[]=[];
  try {
    for(const dir of directories) {mkdirSync(dir,{recursive:true,mode:0o700});if(lstatSync(dir).isSymbolicLink())throw fail('Resource directory must not be a link');}
    const canonical=[...new Set(directories.map(dir=>realpathSync(dir)))].sort();
    for(const dir of canonical) locks.push(new ProfileOwnership(dir));
    return {close:()=>{for(const lock of locks.reverse())lock.close();}};
  } catch(error) {for(const lock of locks.reverse())lock.close();throw error;}
}

function copyArtifacts(source:string,destination:string) {
  let count=0,bytes=0;
  const visit=(from:string,to:string,depth:number)=>{
    if(depth>64)throw fail('Legacy artifact tree is too deep');
    for(const name of readdirSync(from)) {
      if(depth===0 && ['state.sqlite','state.sqlite-wal','state.sqlite-shm','.backend-owner.sqlite','.backend-owner.sqlite-journal'].includes(name))continue;
      if(++count>10000)throw fail('Legacy artifact tree exceeds 10000 entries');
      const src=path.join(from,name),dest=path.join(to,name),stat=lstatSync(src);
      if(stat.isSymbolicLink())throw fail('Legacy artifacts must not contain links');
      if(stat.isDirectory()){privateDirectory(dest);visit(src,dest,depth+1);}
      else {
        regularFile(src);bytes+=stat.size;if(bytes>1024*1024*1024)throw fail('Legacy artifact tree exceeds 1 GiB');
        copyFileSync(src,dest);chmodSync(dest,0o600);
        const fd=openSync(dest,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
      }
    }
  };
  visit(source,destination,0);
}

interface Receipt {
  version:1; id:string; phase:'preparing'|'ready'|'committed'; source?:string; createdAt:string;
  database:boolean; configHash?:string; databaseHash?:string; treeHash?:string;
}
interface Marker {protocol:'native-tools-v1';version:1; id:string; migrationId:string; source?:string}
export interface ProfileOptions {env?:NodeJS.ProcessEnv; cwd?:string; installRoot?:string; checkpoint?:(phase:string)=>void}
export interface PreparedProfile {paths:ReturnType<typeof profilePaths>; id:string; ownership:ProfileOwnership; receipt:Receipt}

function legacyCandidates(roots:string[]) {
  return [...new Set(roots.map(root=>path.resolve(root)))].filter(root=>existsSync(path.join(root,'.env')) && Object.keys(normalizeLegacyConfig(root).values).length>0 || existsSync(path.join(root,'.harness','state.sqlite')) ||
    existsSync(path.join(root,'.harness')) && readdirSync(path.join(root,'.harness')).length>0);
}
function normalizeLegacyConfig(root:string) {
  // Reuse the bounded UTF-8/link validation. No dotenv values enter process.env.
  const filename=path.join(root,'.env');
  new ProviderSettingsFile(filename,{});
  let text=existsSync(filename) ? readFileSync(filename,'utf8') : '';
  const values=parse(text);
  for (const key of ['HARNESS_DATA_DIR','HARNESS_WORKSPACE_ROOT','ARCHITECT_PROMPT_FILE','CODER_PROMPT_FILE','CRITIC_PROMPT_FILE']) {
    const value=values[key];
    if (value!==undefined && (value!=='' || key==='HARNESS_DATA_DIR') && !path.isAbsolute(value)) {
      const absolute=path.resolve(root,value);
      const quote=["'",'"','`'].find(q=>!absolute.includes(q) && !(q==='"' && /\\[nr]/.test(absolute)));
      if (!quote || /[\r\n]/.test(absolute)) throw fail('Legacy path cannot be represented safely in dotenv');
      text+=`\n${key}=${quote}${absolute}${quote}\n`;
    }
  }
  return {text,values:parse(text)};
}

export async function prepareProfile(options:ProfileOptions={}):Promise<PreparedProfile> {
  const env=options.env ?? process.env,cwd=options.cwd ?? process.cwd();
  const paths=profilePaths(applicationHome(env));
  privateDirectory(paths.home);
  const ownership=new ProfileOwnership(paths.home);
  const journal=path.join(paths.home,'migration.json');
  try {
    let receipt=existsSync(journal) ? json<Receipt>(journal) : undefined;
    if (receipt && (receipt.version!==1 || !/^[a-f0-9-]{36}$/.test(receipt.id) || !['preparing','ready','committed'].includes(receipt.phase))) throw fail('Unsupported migration receipt; recover the selected home explicitly');
    const stageOf=(r:Receipt)=>path.join(paths.home,`migration-${r.id}`);
    const commitReady=(r:Receipt) => {
      const stage=stageOf(r);
      if(json<Marker>(path.join(stage,'profile.json')).protocol!=='native-tools-v1')throw fail('Incompatible prototype staging; preserve it and initialize a fresh HARNESS_HOME.');
      if (treeHash(stage)!==r.treeHash) throw fail('Migration staging changed; preserve it and recover explicitly');
      if (existsSync(paths.profile)) throw fail('Destination profile exists; refusing to overwrite or merge');
      renameSync(stage,paths.profile);
      options.checkpoint?.('published');
      r.phase='committed';durableWrite(journal,JSON.stringify(r));
    };
    if (existsSync(paths.profile)) {
      privateDirectory(paths.profile);
      const marker=json<Marker>(path.join(paths.profile,'profile.json'));
      if(marker.protocol!=='native-tools-v1')throw fail('Incompatible prototype profile. Choose a fresh HARNESS_HOME and initialize native-tools-v1; existing files and projects are preserved.');
      if (marker.version!==1 || !/^[a-f0-9-]{36}$/.test(marker.id) || !receipt || marker.migrationId!==receipt.id || receipt.phase==='preparing') throw fail('Profile and migration receipt disagree; recover explicitly');
      if (env.HARNESS_LEGACY_ROOT && path.resolve(env.HARNESS_LEGACY_ROOT)!==receipt.source) throw fail('This home already has a different profile; no merge is permitted');
      if (receipt.phase==='ready') {
        if(treeHash(paths.profile)!==receipt.treeHash)throw fail('Published migration changed before completion; recover explicitly');
        receipt.phase='committed';durableWrite(journal,JSON.stringify(receipt));
      }
      return {paths,id:marker.id,ownership,receipt};
    }
    if (receipt?.phase==='committed') throw fail('Selected profile is missing; restore it instead of starting an empty profile');
    if (receipt?.phase==='ready') {
      if(!receipt.source) {
        commitReady(receipt);
        return {paths,id:json<Marker>(path.join(paths.profile,'profile.json')).id,ownership,receipt};
      }
      // Source may have changed since an interrupted backup. Never silently publish that snapshot.
      if(env.HARNESS_MIGRATION_RETRY!=='1')throw fail('Migration was interrupted before publication; set HARNESS_MIGRATION_RETRY=1 with the same source for a fresh snapshot');
    }
    if (receipt && env.HARNESS_MIGRATION_RETRY!=='1') throw fail('Migration was interrupted; original and staging files are retained. Set HARNESS_MIGRATION_RETRY=1 with the same source to retry');
    const selected=env.HARNESS_LEGACY_ROOT ? path.resolve(env.HARNESS_LEGACY_ROOT) : undefined;
    if (receipt && selected!==receipt.source) throw fail('Retry must select the original migration source');
    const candidates=legacyCandidates([cwd,options.installRoot ?? installationRoot,...(selected?[selected]:[])]);
    if (!selected && candidates.length && env.HARNESS_INIT!=='1') throw fail(`Legacy profiles found at ${candidates.join(', ')}. Select exactly one with HARNESS_LEGACY_ROOT; profiles are never merged`);
    if (selected && !candidates.includes(selected)) throw fail('Selected legacy source is missing; refusing to initialize an empty profile');
    if (!selected && env.HARNESS_INIT!=='1') throw fail('No initialized profile. Select HARNESS_LEGACY_ROOT or set HARNESS_INIT=1 to explicitly create a new profile');
    if(selected) {
      const legacy=normalizeLegacyConfig(selected);
      const explicit=env.HARNESS_DATA_DIR??legacy.values.HARNESS_DATA_DIR;
      const sourceDb=path.join(explicit?path.resolve(selected,explicit):path.join(selected,'.harness'),'state.sqlite');
      if(!existsSync(sourceDb))throw fail('Selected source has no state.sqlite; old prototype migration is unsupported. Initialize a fresh HARNESS_HOME.');
      regularFile(sourceDb);
      const database=new DatabaseSync(sourceDb,{readOnly:true});
      try {
        const hasState=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state'").get();
        if(!hasState||database.prepare("SELECT data FROM state WHERE key='prototype:protocol'").get()?.data!==JSON.stringify('native-tools-v1'))throw fail('Incompatible prototype state. Old-profile migration is unsupported; initialize a fresh HARNESS_HOME. Original data is preserved.');
      }finally{database.close();}
    }
    if(receipt)durableWrite(path.join(paths.home,`interrupted-${receipt.id}.json`),JSON.stringify(receipt));
    receipt={version:1,id:randomUUID(),phase:'preparing',source:selected,createdAt:new Date().toISOString(),database:false};
    durableWrite(journal,JSON.stringify(receipt));
    const stage=stageOf(receipt);privateDirectory(stage);privateDirectory(path.join(stage,'config'));privateDirectory(path.join(stage,'state'));
    options.checkpoint?.('preparing');
    const sourceConfigLock=selected ? new ProfileOwnership(selected) : undefined;
    let sourceLock:ProfileOwnership|undefined,source:DatabaseSync|undefined;
    try {
      const legacy=selected ? normalizeLegacyConfig(selected) : {text:'',values:{ } as Record<string,string>};
      // An explicit legacy data override remains in place; only the historical default is relocated.
      const explicitData=env.HARNESS_DATA_DIR ?? legacy.values.HARNESS_DATA_DIR;
      if(selected && explicitData!==undefined && (!explicitData || !existsSync(path.join(path.resolve(selected,explicitData),'state.sqlite'))))throw fail('Selected legacy data override has no state.sqlite; refusing an empty replacement profile');
      const sourceDb=selected && !explicitData ? path.join(selected,'.harness','state.sqlite') : undefined;
      if (sourceDb && existsSync(path.dirname(sourceDb)) && !existsSync(sourceDb)) throw fail('Legacy data directory has no state.sqlite; inspect the missing source before retry');
      durableWrite(path.join(stage,'config','.env'),legacy.text);
      if (sourceDb && existsSync(sourceDb)) {
        for(const filename of [sourceDb,`${sourceDb}-wal`,`${sourceDb}-shm`])if(existsSync(filename))regularFile(filename);
        sourceLock=new ProfileOwnership(path.dirname(sourceDb));
        source=new DatabaseSync(sourceDb);
        // Exclude writers through cutover. Old versions do not hold our ownership lock when idle;
        // callers must stop them explicitly. BEGIN IMMEDIATE detects active write transactions.
        source.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
        const reader=new DatabaseSync(sourceDb,{readOnly:true});
        // SQLite backup reads committed WAL pages consistently; never copy the live main file.
        try{await backup(reader,path.join(stage,'state','state.sqlite'));}finally{reader.close();}
        const snapshot=new DatabaseSync(path.join(stage,'state','state.sqlite'));
        try {
          const check=snapshot.prepare('PRAGMA integrity_check').get();
          if (check?.integrity_check!=='ok') throw fail('Migration database integrity check failed');
          for(const table of ['projects','chats','messages','events','state','approvals']) {
            if (!snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw fail('Source is not a recognized Harness database');
          }
          snapshot.exec('PRAGMA journal_mode=DELETE');
        } finally {snapshot.close();}
        const fd=openSync(path.join(stage,'state','state.sqlite'),'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
        receipt.database=true;receipt.databaseHash=hash(path.join(stage,'state','state.sqlite'));
        copyArtifacts(path.dirname(sourceDb),path.join(stage,'state'));
      }
      if(selected && normalizeLegacyConfig(selected).text!==legacy.text)throw fail('Legacy configuration changed during migration; retry after stopping its writer');
      const marker:Marker={protocol:'native-tools-v1',version:1,id:randomUUID(),migrationId:receipt.id,source:selected};
      durableWrite(path.join(stage,'profile.json'),JSON.stringify(marker));
      receipt.configHash=hash(path.join(stage,'config','.env'));
      receipt.treeHash=treeHash(stage);
      receipt.phase='ready';durableWrite(journal,JSON.stringify(receipt));
      options.checkpoint?.('ready');commitReady(receipt);
      return {paths,id:marker.id,ownership,receipt};
    } finally {source?.close();sourceLock?.close();sourceConfigLock?.close();}
  } catch(error) {ownership.close();throw error;}
}
