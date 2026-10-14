import { describe,it,expect } from 'vitest';
import { assetPath,isDesktopURL,parseDistributions,pickerPath,startSchema,validateSender } from '../desktop/policy.js';
describe('desktop trust policy',()=>{
  it('enumerates only explicit supported WSL2 environments without choosing the default',()=>{
    expect(parseDistributions('* podman-machine-default Stopped 2\n Ubuntu-24.04 Stopped 2\n Debian Running 1\n Debian Running 2')).toEqual(['Ubuntu-24.04','Debian']);
  });
  it('validates sender contents, top frame and exact origin',()=>{
    const contents={};expect(()=>validateSender({sender:contents,senderFrame:{url:'abyssus://app/',parent:null}},contents)).not.toThrow();
    for(const url of ['file:///app','https://app','abyssus://app.evil/','abyssus://user@app/','abyssus://app:42/'])expect(isDesktopURL(url)).toBe(false);
    expect(()=>validateSender({sender:{},senderFrame:{url:'abyssus://app/',parent:null}},contents)).toThrow();
    expect(()=>validateSender({sender:contents,senderFrame:{url:'abyssus://app/',parent:{}}},contents)).toThrow();
  });
  it('maps selected namespace Unicode/spaces and refuses drive, other distro and traversal paths',()=>{
    expect(pickerPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\hello 世界','Ubuntu-24.04')).toBe('/home/user/hello 世界');
    for(const candidate of ['C:\\projects','\\\\wsl$\\Debian\\home\\user','\\\\wsl$\\Ubuntu-24.04\\mnt\\c\\x','\\\\wsl$\\Ubuntu-24.04\\home\\..\\etc'])expect(()=>pickerPath(candidate,'Ubuntu-24.04')).toThrow();
    expect(pickerPath('/home/user/project')).toBe('/home/user/project');
  });
  it('denies injected setup fields and incomplete migration selection',()=>{
    const valid={environment:{kind:'linux'},home:'/home/user/profile',mode:'existing'};
    expect(startSchema.safeParse(valid).success).toBe(true);
    for(const input of [{...valid,command:'sudo anything'},{...valid,mode:'migrate'},{...valid,legacyRoot:'/tmp/old'},{...valid,environment:{kind:'wsl',distribution:'podman-machine-default'}}])expect(startSchema.safeParse(input).success).toBe(false);
  });
  it('confines packaged asset paths including encoded traversal',()=>{
    for(const raw of ['abyssus://app/%2e%2e%2fsecret','abyssus://app/%5csecret','https://evil/'])expect(()=>assetPath('/packaged/ui',raw)).toThrow();
  });
});
