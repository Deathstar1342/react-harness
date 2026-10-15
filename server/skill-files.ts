import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { z } from 'zod';
import { hash, safeRelative, scoped } from './tools/paths.js';

export const SKILL_LIMITS = Object.freeze({ header:4096, document:32_000, catalog:64, references:8, reference:16_000, depth:4, selected:4, total:128_000 });
export const skillName = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).refine(value=>{try{return safeRelative(value)===value;}catch{return false;}});
const referencePath = z.string().max(256).refine(value=>{
  try {return value===safeRelative(value) && /^resources\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:md|txt)$/.test(value) && value.split('/').length<=SKILL_LIMITS.depth;} catch{return false;}
});
export const skillMetadata = z.strictObject({ name:skillName, description:z.string().min(1).max(512).refine(value=>!/[\x00-\x1f\x7f]/.test(value)), references:z.array(referencePath).max(SKILL_LIMITS.references).refine(values=>new Set(values.map(v=>v.toLowerCase())).size===values.length) });
export type SkillMetadata = z.infer<typeof skillMetadata>;
export type SkillScope = 'project'|'personal';
export interface SkillDocument extends SkillMetadata { scope:SkillScope; content:string; hash:string; revision:string; resources:{path:string;content:string;hash:string}[] }
export interface SkillCatalog { entries:(SkillMetadata & {scope:SkillScope;shadowed:boolean})[]; diagnostics:{scope:SkillScope;entry:string;message:string}[] }
let discovering=0;
export function projectSkillPath(name:string) {return `.abyssus/skills/${skillName.parse(name)}/SKILL.md`;}

/** Deliberately not YAML. Each of three known keys has a JSON literal value. */
export function parseSkill(content:string, expectedName:string, headerOnly=false):SkillMetadata {
  if(content.includes('\0') || Buffer.from(content).toString('utf8')!==content || (!headerOnly && Buffer.byteLength(content)>SKILL_LIMITS.document))throw new Error('Skill must be bounded UTF-8 text.');
  const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if(!match || Buffer.byteLength(match[0])>SKILL_LIMITS.header)throw new Error('Skill needs a frontmatter header of at most 4096 bytes.');
  const values:Record<string,unknown>={};
  for(const line of match[1].split(/\r?\n/)) {
    const field=/^(name|description|references): (.+)$/.exec(line);
    if(!field || Object.hasOwn(values,field[1]))throw new Error('Skill header permits one name, description and references field, each a JSON literal.');
    values[field[1]]=JSON.parse(field[2]);
  }
  const metadata=skillMetadata.parse(values);
  if(metadata.name!==skillName.parse(expectedName))throw new Error('Skill header name must match its directory.');
  if(!headerOnly && !content.slice(match[0].length).trim())throw new Error('Skill workflow body is empty.');
  return metadata;
}

/** Fixed-root, descriptor-bounded reads; discovery does not read workflow bodies. */
async function readBounded(root:string, relative:string, limit:number, header=false):Promise<string> {
  const target=await scoped(root,relative);
  const handle=await open(target.absolute,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
  try {
    const before=await handle.stat({bigint:true});
    if(!before.isFile() || before.nlink!==1n || before.size>BigInt(header?SKILL_LIMITS.document:limit))throw new Error('Skill files must be regular, non-linked and within byte bounds.');
    const buffer=Buffer.alloc(limit+1);let size=0;
    while(size<buffer.length) {const read=await handle.read(buffer,size,buffer.length-size,null);if(!read.bytesRead)break;size+=read.bytesRead;}
    let bytes=buffer.subarray(0,size);
    if(header) {
      // Decode only complete header bytes: a UTF-8 body character can straddle the cap.
      const marker=bytes.indexOf(Buffer.from('\n---\n'),4), crlf=bytes.indexOf(Buffer.from('\r\n---\r\n'),5);
      const end=marker>=0?marker+5:crlf>=0?crlf+7:-1;
      if(end<0 || end>limit)throw new Error('Skill header is missing or exceeds its byte bound.');
      bytes=bytes.subarray(0,end);
    } else if(size>limit)throw new Error('Skill file exceeds its byte bound.');
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    if(text.includes('\0'))throw new Error('Skill files must be UTF-8 text without NUL.');
    await scoped(root,relative);
    const after=await lstat(target.absolute,{bigint:true});
    if(before.ino!==after.ino || before.dev!==after.dev || before.ctimeNs!==after.ctimeNs || before.size!==after.size)throw new Error('Skill file changed during read.');
    return text;
  } finally {await handle.close();}
}

export async function validateProjectSkillResources(root:string,name:string,content:string) {
  const metadata=parseSkill(content,name);let bytes=Buffer.byteLength(content);
  for(const reference of metadata.references) {
    bytes+=Buffer.byteLength(await readBounded(root,`.abyssus/skills/${name}/${reference}`,SKILL_LIMITS.reference));
    if(bytes>SKILL_LIMITS.total)throw new Error('Workflow and references exceed 128000 bytes.');
  }
}

export class SkillFiles {
  constructor(readonly projectRoot:string,readonly applicationHome:string) {}
  private location(scope:SkillScope) {
    if(scope!=='project'&&scope!=='personal')throw new Error('Invalid skill scope.');
    return scope==='project'?{root:this.projectRoot,prefix:'.abyssus/skills'}:{root:this.applicationHome,prefix:'skills'};
  }
  async catalog() {
    if(discovering>=2)throw new Error('Skill discovery is busy; retry after the current bounded scan.');
    discovering++;
    try {return await this.discover();}finally{discovering--;}
  }
  private async discover():Promise<SkillCatalog> {
    const entries:SkillCatalog['entries']=[],diagnostics:SkillCatalog['diagnostics']=[];
    for(const scope of ['project','personal'] as const) {
      const {root,prefix}=this.location(scope);
      let directory;
      try {if(scope==='personal'&&(await lstat(root)).isSymbolicLink())throw new Error('Unsafe personal skill root.');const target=await scoped(root,prefix);directory=await opendir(target.absolute);}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw new Error(`Cannot safely discover ${scope} workflow metadata.`);}
      const names:string[]=[];let scanned=0;
      for await(const entry of directory) {
        if(++scanned>SKILL_LIMITS.catalog)throw new Error('Skill catalog exceeds 64 entries per scope.');
        if(!entry.isDirectory() || entry.isSymbolicLink() || !skillName.safeParse(entry.name).success) {diagnostics.push({scope,entry:entry.name.slice(0,64),message:'Invalid name or unsafe entry; skill unavailable.'});continue;}
        names.push(entry.name);
      }
      for(const name of names.sort()) {
        try {
          const metadata=parseSkill(await readBounded(root,`${prefix}/${name}/SKILL.md`,SKILL_LIMITS.header,true),name,true);
          entries.push({...metadata,scope,shadowed:scope==='personal'&&entries.some(e=>e.scope==='project'&&e.name===name)});
        }catch{diagnostics.push({scope,entry:name,message:'Invalid, missing, changed, oversized or linked metadata; skill unavailable.'});}
        if(Buffer.byteLength(JSON.stringify({entries,diagnostics}))>64_000)throw new Error('Catalog metadata exceeds 64000 bytes.');
      }
    }
    return {entries,diagnostics};
  }
  async load(scope:SkillScope,name:string):Promise<SkillDocument> {
    name=skillName.parse(name);
    try {return await this.loadDocument(scope,name);}catch{throw new Error(`Cannot safely load ${scope}/${name}: missing, changed, malformed, oversized or linked workflow/resources.`);}
  }
  private async loadDocument(scope:SkillScope,name:string):Promise<SkillDocument> {
    const {root,prefix}=this.location(scope),base=`${prefix}/${name}`;
    if(scope==='personal'&&(await lstat(root)).isSymbolicLink())throw new Error('Unsafe personal skill root.');
    const content=await readBounded(root,`${base}/SKILL.md`,SKILL_LIMITS.document);
    const metadata=parseSkill(content,name),resources:SkillDocument['resources']=[];
    let bytes=Buffer.byteLength(content);
    for(const relative of metadata.references) {
      const content=await readBounded(root,`${base}/${relative}`,SKILL_LIMITS.reference);
      bytes+=Buffer.byteLength(content);
      if(bytes>SKILL_LIMITS.total)throw new Error('Selected skill resources exceed 128000 bytes.');
      resources.push({path:relative,content,hash:hash(content)});
    }
    const revision=hash(JSON.stringify([hash(content),resources.map(r=>[r.path,r.hash])]));
    return {...metadata,scope,content,hash:hash(content),revision,resources};
  }
}
