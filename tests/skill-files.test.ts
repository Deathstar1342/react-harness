import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,link,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SkillFiles,parseSkill,projectSkillPath} from '../server/skill-files.js';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
export const workflow=(name='verify',body='Inspect the changes. Run appropriate checks.',references:string[]=[])=>`---\nname: ${JSON.stringify(name)}\ndescription: "Verify completed work"\nreferences: ${JSON.stringify(references)}\n---\n${body}\n`;
async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'skills-'));roots.push(root);
  const home=path.join(root,'app'),project=path.join(root,'project');
  await mkdir(home);await mkdir(project);
  const put=async(scope:'project'|'personal',name:string,content=workflow(name))=>{
    const dir=path.join(scope==='project'?project:home,scope==='project'?'.abyssus/skills':'skills',name);
    await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'SKILL.md'),content);return dir;
  };
  return {home,project,put,files:new SkillFiles(project,home)};
}
describe('bounded workflow files',()=>{
  it('discovers metadata only, reports shadowing, then lazily loads bounded resources',async()=>{
    const f=await fixture();
    const dir=await f.put('project','verify',workflow('verify','Project workflow',['resources/check.md']));
    await f.put('personal','verify',workflow('verify','Personal workflow'));
    const catalog=await f.files.catalog();
    expect(catalog.entries).toHaveLength(2);expect(catalog.entries[1].shadowed).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain('Project workflow');
    await expect(f.files.load('project','verify')).rejects.toThrow();
    await mkdir(path.join(dir,'resources'));await writeFile(path.join(dir,'resources/check.md'),'Read this only on invocation.');
    const loaded=await f.files.load('project','verify');
    expect(loaded.resources[0].content).toContain('invocation');
    await writeFile(path.join(dir,'resources/check.md'),'New instructions');
    expect((await f.files.load('project','verify')).revision).not.toBe(loaded.revision);
  });
  it('never searches unrelated personal directories or creates missing roots',async()=>{
    const f=await fixture();await writeFile(path.join(f.home,'unrelated.md'),'private');
    expect((await f.files.catalog()).entries).toEqual([]);
    expect((await new SkillFiles(f.project,path.join(f.home,'absent')).catalog()).entries).toEqual([]);
  });
  it.each(['../escape','UPPER','con','a/b','a\\b','/absolute','file:name','a..','a_b','a'.repeat(65)])('rejects name %s',name=>{
    expect(()=>projectSkillPath(name)).toThrow();
  });
  it.each(['../secret.md','resources/../secret.md','/tmp/file.md','resources/a\\b.md','resources/.env','resources/a.js','resources/a/b/c/d.md','resources/a.md\u0000'])('rejects reference %s',reference=>{
    expect(()=>parseSkill(workflow('verify','body',[reference]),'verify')).toThrow();
  });
  it('rejects ambiguous metadata, aliases, extra keys, malformed encoding and unbounded bodies',()=>{
    for(const content of [workflow().replace('name: "verify"','name: verify'),workflow().replace('name: "verify"','name: "verify"\nname: "verify"'),workflow().replace('references: []','handler: "execute"\nreferences: []'),workflow('other'),workflow('verify','\0'),workflow('verify','x'.repeat(32000)),workflow('verify','\ud800'),workflow('verify','body',['resources/a.md','resources/A.md'])])expect(()=>parseSkill(content,'verify')).toThrow();
  });
  it('discovery does not decode malformed body bytes but full loading rejects them',async()=>{
    const f=await fixture(),dir=await f.put('project','verify');
    await writeFile(path.join(dir,'SKILL.md'),Buffer.concat([Buffer.from(workflow()),Buffer.from([0xff])]));
    expect((await f.files.catalog()).entries).toHaveLength(1);
    await expect(f.files.load('project','verify')).rejects.toThrow();
  });
  it('rejects linked documents and references',async()=>{
    const f=await fixture(),dir=await f.put('project','verify',workflow('verify','body',['resources/r.md']));
    await mkdir(path.join(dir,'resources'));await writeFile(path.join(f.project,'outside.md'),'outside');
    await link(path.join(f.project,'outside.md'),path.join(dir,'resources/r.md'));
    await expect(f.files.load('project','verify')).rejects.toThrow(/link/i);
    await rm(path.join(dir,'SKILL.md'));await link(path.join(f.project,'outside.md'),path.join(dir,'SKILL.md'));
    expect((await f.files.catalog()).diagnostics).toHaveLength(1);
  });
  it.skipIf(process.platform==='win32')('rejects linked catalog directories',async()=>{
    const f=await fixture();await mkdir(path.join(f.project,'.abyssus/skills'),{recursive:true});
    await symlink(f.home,path.join(f.project,'.abyssus/skills/verify'));
    expect((await f.files.catalog()).diagnostics).toHaveLength(1);
  });
  it('fails explicitly at catalog/header/resource count and byte limits',async()=>{
    const f=await fixture();for(let i=0;i<65;i++)await f.put('project',`s-${i}`);
    await expect(f.files.catalog()).rejects.toThrow(/64/);
    expect(()=>parseSkill(workflow('verify','body',Array.from({length:9},(_,i)=>`resources/a${i}.md`)),'verify')).toThrow();
    expect(()=>parseSkill(workflow().replace('Verify completed work','x'.repeat(4096)),'verify')).toThrow();
  });
});
