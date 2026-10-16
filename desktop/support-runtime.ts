import { createHash } from 'node:crypto';
import { lstatSync,readFileSync,readdirSync,realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
const manifestSchema=z.object({version:z.literal(1),pythonVersion:z.literal('3.13.16'),platform:z.enum(['linux','win32']),arch:z.literal('x64'),executable:z.string(),files:z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/))}).strict();
/** Complete inventory, including stdlib/DLLs, before executing the bundled runtime. */
export function supportRuntime(root:string) {
  const canonical=realpathSync(root);
  if(canonical!==path.resolve(root)||lstatSync(root).isSymbolicLink())throw new Error('Support runtime location is unsafe. Repair runtime staging.');
  const file=path.join(root,'manifest.json');
  if(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink()||lstatSync(file).size>2*1024*1024)throw new Error('Invalid support runtime manifest.');
  const manifest=manifestSchema.parse(JSON.parse(readFileSync(file,'utf8')));
  if(manifest.platform!==process.platform||manifest.arch!==process.arch)throw new Error('The bundled support runtime does not match this platform.');
  const found=new Set<string>();let count=0,total=0;
  const visit=(directory:string)=>{for(const name of readdirSync(directory)){
    const target=path.join(directory,name),relative=path.relative(root,target).split(path.sep).join('/'),stat=lstatSync(target);
    if(stat.isSymbolicLink()||realpathSync(target)!==target||++count>20000)throw new Error('Unsafe support runtime member.');
    if(stat.isDirectory()){visit(target);continue;}
    if(!stat.isFile()||stat.nlink!==1||stat.size>64*1024*1024||(total+=stat.size)>512*1024*1024)throw new Error('Invalid support runtime member.');
    if(relative==='manifest.json')continue;
    if(!Object.hasOwn(manifest.files,relative)||createHash('sha256').update(readFileSync(target)).digest('hex')!==manifest.files[relative])throw new Error('Support runtime integrity check failed. Repair runtime staging.');
    found.add(relative);
  }};visit(root);
  if(Object.keys(manifest.files).some(name=>!found.has(name))||!found.has(manifest.executable))throw new Error('Support runtime files are missing.');
  return path.join(root,manifest.executable);
}
