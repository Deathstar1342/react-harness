import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {validateLocation}=require('../desktop/bootstrap.cjs') as {validateLocation:(v:string,i:string)=>string};
describe('Windows packaged bootstrap data isolation',()=>{
  it.each(['C:\\','\\\\server\\share','\\\\?\\C:\\data','C:\\a\\..\\data','C:\\data:stream','C:\\bad.\\data','relative'])('rejects unsafe location %s',value=>{expect(()=>validateLocation(value,'C:\\Windows')).toThrow();});
  it.skipIf(process.platform!=='win32')('probes an existing separate folder; refuses missing and overlapping folders',()=>{
    const root=mkdtempSync(path.join(tmpdir(),'abyssus-bootstrap-'));mkdirSync(path.join(root,'install'));mkdirSync(path.join(root,'data'));
    try{expect(validateLocation(path.join(root,'data'),path.join(root,'install'))).toBeTruthy();expect(()=>validateLocation(path.join(root,'missing'),path.join(root,'install'))).toThrow();expect(()=>validateLocation(root,path.join(root,'install'))).toThrow();}
    finally{rmSync(root,{recursive:true,force:true});}
  });
});
