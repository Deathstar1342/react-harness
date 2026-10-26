import {afterEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceFiles} from '../server/tools/files.js';
import {hash} from '../server/tools/paths.js';
vi.mock('node:fs/promises',async original=>({...await original<typeof import('node:fs/promises')>()}));
const cleanup:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of cleanup.splice(0)){if(path.dirname(root)!==path.resolve(tmpdir())||!path.basename(root).startsWith('m34-mode-'))throw new Error('Fixture cleanup identity mismatch');await fs.rm(root,{recursive:true,force:true});}});
async function fixture(){const root=await fs.mkdtemp(path.join(tmpdir(),'m34-mode-'));cleanup.push(root);await fs.writeFile(path.join(root,'a.ts'),'after');return {root,files:new WorkspaceFiles({maxFileBytes:262144,maxEntries:512,maxSearchFiles:512,leaseMs:45000}),before:{path:'a.ts',content:'before',hash:hash('before'),mode:0o444},expected:{path:'a.ts',content:'after',hash:hash('after')}};}
it('permission restoration repeats the durable claim after save and refuses a stale second effect',async()=>{
 const t=await fixture();let claims=0;await expect(t.files.restoreCheckpoint(t.root,t.before,t.expected,()=>{if(++claims===2)throw new Error('Claim changed after save');})).rejects.toThrow(/Claim changed/);
 expect(claims).toBe(2);expect(await fs.readFile(path.join(t.root,'a.ts'),'utf8')).toBe('before');expect((await fs.stat(path.join(t.root,'a.ts'))).mode&0o200).not.toBe(0);
});
it('opened permission descriptor cannot authorize chmod after current path substitution',async()=>{
 const t=await fixture(),target=path.join(t.root,'a.ts'),replacement=path.join(t.root,'replacement.ts'),retained=path.join(t.root,'retained.ts');await fs.writeFile(replacement,'before');
 const originalRename=fs.rename;let published=false,substituted=false,chmods=0;
 vi.spyOn(fs,'rename').mockImplementation(async(a,b)=>{await originalRename(a,b);if(String(b)===target&&String(a).includes('.rh-write-'))published=true;});
 const originalOpen=fs.open;
 vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{const handle=await originalOpen(...args);if(published&&String(args[0])===target){const stat=handle.stat.bind(handle),chmod=handle.chmod.bind(handle);let reads=0;
  vi.spyOn(handle,'stat').mockImplementation(async(...values:any[])=>{if(++reads===2&&!substituted){substituted=true;await originalRename(target,retained);await originalRename(replacement,target);}return stat(...values as []);});
  vi.spyOn(handle,'chmod').mockImplementation(async mode=>{chmods++;return chmod(mode);});
 }return handle;});
 await expect(t.files.restoreCheckpoint(t.root,t.before,t.expected,()=>{})).rejects.toThrow(/identity changed/);expect(substituted).toBe(true);expect(chmods).toBe(0);expect(await fs.readFile(target,'utf8')).toBe('before');expect((await fs.stat(target)).mode&0o200).not.toBe(0);expect(await fs.readFile(retained,'utf8')).toBe('before');
});
