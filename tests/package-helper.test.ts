import { describe,it,expect } from 'vitest';
import { helperCanonical,helperMac,packageRequestSchema,PackageHelperClient } from '../server/package-helper.js';
import { randomUUID } from 'node:crypto';
import { LinuxSandbox } from '../server/tools/sandbox.js';
import { WorkspaceTools } from '../server/tools/index.js';

describe('M18 trusted helper client',()=>{
  it('canonicalizes sorted ASCII JSON and signs the whole action/target body',()=>{
    expect(helperCanonical({z:1,a:{b:'é'}})).toBe('{"a":{"b":"\\u00e9"},"z":1}');
    expect(helperMac({action:'execute',body:{target:'a'}},'test')).not.toBe(helperMac({action:'prepare',body:{target:'a'}},'test'));
  });
  it('accepts only structured apt names and exact optional versions',()=>{
    const base={requestId:randomUUID(),targetId:'a'.repeat(64),manager:'apt',packages:[{name:'hello'}]};
    expect(packageRequestSchema.safeParse(base).success).toBe(true);
    for(const name of ['--help','./evil.deb','a;id','a\nb','hello:amd64','../hello'])expect(packageRequestSchema.safeParse({...base,packages:[{name}]}).success).toBe(false);
    expect(packageRequestSchema.safeParse({...base,options:[]}).success).toBe(false);
    expect(packageRequestSchema.safeParse({...base,packages:[{name:'hello',version:'1;id'}]}).success).toBe(false);
    expect(packageRequestSchema.safeParse({...base,packages:[{name:'hello'},{name:'hello'}]}).success).toBe(false);
  });
  it.skipIf(process.platform==='linux')('fails closed without a supported Linux client',async()=>{
    await expect(PackageHelperClient.connect()).rejects.toThrow('HELPER_UNSUPPORTED_CLIENT');
  });
  it.skipIf(process.platform!=='linux')('rejects helper state and ancestor roots for registration and file tools',async()=>{
    const sandbox=new LinuxSandbox(),tools=new WorkspaceTools();
    for(const root of ['/var/lib/abyssus-helper','/var/lib','/etc/abyssus-helper','/run/abyssus-helper','/usr/lib/abyssus-helper']){
      expect(()=>sandbox.validateRoot(root)).toThrow();
      await expect(tools.read(root,'audit.sqlite')).rejects.toThrow();
    }
    await tools.dispose();
  });
});
