import { afterEach,expect,it } from 'vitest';
import { mkdtempSync,writeFileSync,rmSync,linkSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
import { readDesktopLaunch } from '../containers/desktop-session.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(path.join(tmpdir(),'m31-launch-'));roots.push(root);const file=path.join(root,'launch.json');const value={version:1,storageId:randomUUID(),launchId:randomUUID(),key:randomBytes(32).toString('hex'),token:randomBytes(32).toString('hex')};writeFileSync(file,JSON.stringify(value),{mode:0o600});return {root,file,value};}
it('loads only the exact bounded storage-bound private desktop capability',()=>{const t=fixture();expect(readDesktopLaunch(t.value.storageId,t.file)).toEqual(t.value);expect(()=>readDesktopLaunch(randomUUID(),t.file)).toThrow(/storage/);});
it('rejects incomplete, extra, oversized and hard-linked launch files',()=>{const t=fixture();for(const raw of ['{}',JSON.stringify({...t.value,command:'x'}),'x'.repeat(2049)]){writeFileSync(t.file,raw);expect(()=>readDesktopLaunch(t.value.storageId,t.file)).toThrow();}writeFileSync(t.file,JSON.stringify(t.value));linkSync(t.file,path.join(t.root,'alias'));expect(()=>readDesktopLaunch(t.value.storageId,t.file)).toThrow(/capability/);});
it.skipIf(process.platform==='win32')('refuses a capability readable by other host users',()=>{const t=fixture();chmodSync(t.file,0o644);expect(()=>readDesktopLaunch(t.value.storageId,t.file)).toThrow(/capability/);});
