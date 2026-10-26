import {lstat,opendir,realpath} from 'node:fs/promises';
import path from 'node:path';
import type {FileSnapshot,CheckpointAccess} from '../shared/types.js';
import {assertNativePath} from './native-storage.js';
import {hash,isProtected,safeRelative} from './tools/paths.js';

export const checkpointLimits=Object.freeze({files:512,fileBytes:256*1024,bytes:8*1024*1024,entries:10000,depth:32,diffBytes:200000,projectCount:8,projectBytes:32*1024*1024,totalCount:64,totalBytes:64*1024*1024,journals:32});
export const checkpointPolicy='source-text-v1';
export interface CheckpointFile extends FileSnapshot {mode:number}
export interface CheckpointTree {rootIdentity:string;files:CheckpointFile[];revision:string;digest:string;bytes:number;excluded:{path:string;reason:string}[];excludedCount:number;directories:string[]}
const omitted=new Set(['node_modules','bower_components','vendor','dist','build','coverage','target','out','obj','__pycache__','venv','env','logs','test-results','playwright-report']);
const publicDots=new Set(['.github','.gitignore','.gitattributes','.dockerignore','.editorconfig']);
export function checkpointExclusion(relative:string):string|undefined {
 const parts=relative.split('/');
 if(parts.some(p=>isProtected(p)))return 'Git metadata or credential path';
 if(parts.some(p=>omitted.has(p.toLowerCase())))return 'Dependency, build or runtime output';
 if(/\.(?:png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|svgz|woff2?|ttf|otf|eot|mp[34]|wav|ogg|flac|webm|mov|avi|pdf|zip|7z|gz|bz2|xz|tar|jar|war|wasm|exe|dll|so|dylib|a|o|class|psd|blend|glb|gltf|fbx)$/i.test(relative))return 'Binary asset/archive/font/media';
 if(parts.some(p=>/^(?:provider-settings|provider-keys|assignment-evidence|verification-ledger|prompt-ledger)(?:\.|$)/i.test(p)))return 'Private application/provider ledger';
 if(parts.some(p=>/\.(?:db|sqlite(?:3)?|log|pyc|pyo)(?:-(?:wal|shm|journal))?$/i.test(p)||/^stark-probe/i.test(p)))return 'Private/runtime data';
 if(parts[0]==='.abyssus'&&parts.length>1&&parts[1]!=='skills')return 'Private application state';
 if(parts[0]==='.abyssus'&&!parts.slice(1).some(p=>p.startsWith('.')))return undefined;
 if(parts.some(p=>p.startsWith('.')&&!publicDots.has(p)))return 'Private or cache path';
 return undefined;
}
export const manifestDigest=(files:CheckpointFile[])=>hash(JSON.stringify(files.map(f=>[f.path,f.hash,f.mode,f.content])));
const stamp=(s:Awaited<ReturnType<typeof lstat>>,directory=false)=>[String(s.dev),String(s.ino),String(s.birthtimeMs),...(directory?[]:[String(s.ctimeMs),String(s.mtimeMs),String(s.size),String(s.mode)])].join(':');
/** Enumerate every eligible entry. Unlike file browsing, unsafe/unreadable source is never silently skipped. */
export async function checkpointTree(root:string,access:Pick<CheckpointAccess,'read'>):Promise<CheckpointTree> {
 assertNativePath(root,false);
 if(path.resolve(root)!==root||await realpath(root)!==root)throw new Error('Checkpoint requires the canonical registered project path');
 const initial=await lstat(root);if(!initial.isDirectory()||initial.isSymbolicLink())throw new Error('Checkpoint project identity is unsafe');
 const rootIdentity=stamp(initial,true),files:CheckpointFile[]=[],directories:string[]=[],observations:unknown[]=[['',rootIdentity]],aliases=new Set<string>();
 const excluded:CheckpointTree['excluded']=[];let excludedCount=0,excludedBytes=0,visited=0,bytes=0;
 const walk=async(relative:string,depth:number)=>{
  if(depth>checkpointLimits.depth)throw new Error('Checkpoint directory depth exceeds limit');
  const directory=path.join(root,relative),before=await lstat(directory);
  if(!before.isDirectory()||before.isSymbolicLink()||before.dev!==initial.dev)throw new Error('Checkpoint refuses links, special entries and mounted trees');
  const names:string[]=[];
  for await(const entry of await opendir(directory)){if(++visited>checkpointLimits.entries)throw new Error('Checkpoint traversal exceeds entry limit');names.push(entry.name);}
  names.sort();
  for(const name of names){
   const filename=relative?`${relative}/${name}`:name,reason=checkpointExclusion(filename);
   if(reason){excludedCount++;const item={path:filename.slice(0,1024),reason},size=Buffer.byteLength(JSON.stringify(item));if(excluded.length<100&&excludedBytes+size<=16000){excluded.push(item);excludedBytes+=size;}continue;}
   if(filename.length>1024||filename.split('/').some(p=>p.length>240||/[<>"|?*]/.test(p))||safeRelative(filename)!==filename)throw new Error('Checkpoint path is unsafe');
   const alias=filename.normalize('NFC').toLowerCase();if(aliases.has(alias))throw new Error('Checkpoint has a case or Unicode path alias');aliases.add(alias);
   const absolute=path.join(root,filename),info=await lstat(absolute);
   if(info.isSymbolicLink()||info.dev!==initial.dev||!info.isFile()&&!info.isDirectory()||info.isFile()&&info.nlink!==1)throw new Error('Checkpoint refuses linked or special source entries');
   if(info.isDirectory()){directories.push(filename);observations.push([filename,stamp(info,true)]);await walk(filename,depth+1);continue;}
   if(files.length>=checkpointLimits.files||info.size>checkpointLimits.fileBytes)throw new Error('Checkpoint source exceeds file count or file size limit');
   const file=await access.read(root,filename),after=await lstat(absolute);
   if(file.hash===null||stamp(info)!==stamp(after)||hash(file.content)!==file.hash)throw new Error('Checkpoint source changed while reading');
   const size=Buffer.byteLength(file.content);bytes+=size;
   if(size>checkpointLimits.fileBytes||bytes>checkpointLimits.bytes)throw new Error('Checkpoint source exceeds byte limit');
   files.push({...file,mode:info.mode&0o777});observations.push([filename,stamp(after),file.hash]);
  }
  if(stamp(before)!==stamp(await lstat(directory)))throw new Error('Checkpoint directory changed while reading');
 };
 await walk('',0);assertNativePath(root,false);
 if(stamp(await lstat(root),true)!==rootIdentity)throw new Error('Checkpoint project identity changed');
 files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 return {rootIdentity,files,revision:hash(JSON.stringify(observations)),digest:manifestDigest(files),bytes,excluded,excludedCount,directories};
}
