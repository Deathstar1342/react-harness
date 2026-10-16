import { afterEach,expect,it } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { supportRuntime } from '../desktop/support-runtime.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(path.join(tmpdir(),'m31-inventory-'));roots.push(root);writeFileSync(path.join(root,'python'),'fixture');writeFileSync(path.join(root,'manifest.json'),JSON.stringify({version:1,pythonVersion:'3.13.16',platform:process.platform,arch:'x64',executable:'python',files:{python:createHash('sha256').update('fixture').digest('hex')}}));return root;}
it('only resolves an executable after complete inventory validation',()=>{const root=fixture();expect(supportRuntime(root)).toBe(path.join(root,'python'));writeFileSync(path.join(root,'injected.py'),'injection');expect(()=>supportRuntime(root)).toThrow(/integrity/);});
it('rejects missing or changed members and linked executable files',()=>{
 const changed=fixture();writeFileSync(path.join(changed,'python'),'changed');expect(()=>supportRuntime(changed)).toThrow(/integrity/);
 const missing=fixture();rmSync(path.join(missing,'python'));expect(()=>supportRuntime(missing)).toThrow(/missing/);
 const linked=fixture();linkSync(path.join(linked,'python'),path.join(linked,'hardlink'));expect(()=>supportRuntime(linked)).toThrow(/member/);
});
it('rejects junctions or symlink directories before recursive execution discovery',()=>{const root=fixture(),outside=fixture();symlinkSync(outside,path.join(root,'alias'),process.platform==='win32'?'junction':'dir');expect(()=>supportRuntime(root)).toThrow(/Unsafe/);});
