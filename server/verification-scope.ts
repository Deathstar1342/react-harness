import { createHash } from 'node:crypto';
import type { ToolService } from '../shared/types.js';
import { safeRelative } from './tools/paths.js';

export interface ScopeSnapshot { status: 'observed'|'unknown'; digest?: string; files: number; bytes: number; reason?: string; }
export interface VerificationSnapshot { before: ScopeSnapshot; after: ScopeSnapshot; bindingValid: boolean; }
const LIMITS = {entries:128,depth:8,bytes:1_000_000,timeMs:2000} as const;
export const unknownScope = (reason: string): ScopeSnapshot => ({status:'unknown',files:0,bytes:0,reason});

/** Stability of confined visible text within explicit scope, not the whole
 * workspace, shell environment, test authenticity, or a filesystem lock. */
export async function snapshotScope(tools: Pick<ToolService,'read'|'list'>, root: string, paths: string[]|undefined): Promise<ScopeSnapshot> {
  if (!paths?.length) return unknownScope('Verification needs explicit bounded assignment paths; scope is unknown.');
  const deadline=Date.now()+LIMITS.timeMs;
  let timedOut=false, timer:ReturnType<typeof setTimeout>|undefined;
  const capture=async():Promise<ScopeSnapshot>=>{
    let entries=0,bytes=0;
    const files=new Map<string,string|null>(),directories=new Set<string>();
    const check=()=>{if(timedOut||Date.now()>deadline)throw new Error('Verification scope snapshot exceeded its time limit.');};
    async function visit(input:string,depth:number):Promise<void> {
      check();if(depth>LIMITS.depth || ++entries>LIMITS.entries)throw new Error('Verification scope exceeds its entry/depth bound; use a smaller explicit scope.');
      const filename=safeRelative(input,true);
      // The default report is the only fixed runtime bookkeeping path. Custom
      // report paths and generated-looking directories are NOT silently ignored.
      if(filename==='.react-harness-test-results.xml')return;
      if(files.has(filename)||directories.has(filename))return;
      let children:Awaited<ReturnType<ToolService['list']>>;
      try {children=await tools.list(root,filename);}
      catch {
        const file=await tools.read(root,filename);check();bytes+=Buffer.byteLength(file.content);
        if(bytes>LIMITS.bytes)throw new Error('Verification scope exceeds its byte bound.');
        files.set(filename,file.hash);return;
      }
      check();directories.add(filename);
      for(const entry of children) {
        const child=safeRelative(entry.path);
        if(filename && !child.startsWith(`${filename}/`))throw new Error('Verification scope returned an out-of-scope entry.');
        if(entry.type==='directory')await visit(child,depth+1);
        else {
          check();if(++entries>LIMITS.entries)throw new Error('Verification scope exceeds its entry bound.');
          if(child==='.react-harness-test-results.xml')continue;
          const file=await tools.read(root,child);check();bytes+=Buffer.byteLength(file.content);
          if(bytes>LIMITS.bytes)throw new Error('Verification scope exceeds its byte bound.');
          files.set(child,file.hash);
        }
      }
    }
    try {
      for(const filename of paths)await visit(filename,0);
      if(![...files.values()].some(value=>value!==null))return unknownScope('No readable source file was observed in the explicit verification scope.');
      return {status:'observed',digest:createHash('sha256').update(JSON.stringify({scope:[...paths].sort(),directories:[...directories].sort(),files:[...files].sort(([a],[b])=>a.localeCompare(b))})).digest('hex'),files:files.size,bytes};
    } catch(error) {return {status:'unknown',files:files.size,bytes,reason:error instanceof Error?error.message:'Cannot safely snapshot verification scope.'};}
  };
  try {
    return await Promise.race([capture(),new Promise<ScopeSnapshot>(resolve=>{timer=setTimeout(()=>{timedOut=true;resolve(unknownScope('Verification scope snapshot exceeded its time limit.'));},LIMITS.timeMs);})]);
  } finally {if(timer)clearTimeout(timer);}
}
