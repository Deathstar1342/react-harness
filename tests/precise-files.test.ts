import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, link, symlink} from 'node:fs/promises';
import {writeFileSync, unlinkSync} from 'node:fs';
import * as filesystem from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceTools} from '../server/tools/index.js';
import {WorkspaceFiles} from '../server/tools/files.js';
import {patchSnapshot} from '../server/tools/edits.js';
import {hash} from '../server/tools/paths.js';
import {readProjectInstructions} from '../server/project-instructions.js';
import {publishedTools, validateAction} from '../server/tool-registry.js';
import type {ToolContext} from '../shared/types.js';

vi.mock('node:fs/promises',async importOriginal=>({...await importOriginal<typeof import('node:fs/promises')>()}));

let root: string, tools: WorkspaceTools, context: ToolContext;
beforeEach(async()=>{root=await mkdtemp(path.join(tmpdir(),'m25-files-'));tools=new WorkspaceTools();context={projectRoot:root,chatId:'chat',agentId:'coder'};});
afterEach(async()=>{vi.restoreAllMocks();await tools.dispose();await rm(root,{recursive:true,force:true});});

describe('precise versioned file tools',()=>{
  it.each(['sync','unlink'])('retains both paths and uncertain evidence when move %s fails after exclusive creation',async point=>{
    const before=await tools.save(root,'source','retained bytes',null);
    if(point==='sync'){
      const open=filesystem.open;
      vi.spyOn(filesystem,'open').mockImplementation(async(...args:Parameters<typeof open>)=>{const handle=await open(...args);if(String(args[0])===path.join(root,'destination')&&args[1]==='wx')vi.spyOn(handle,'sync').mockRejectedValue(new Error('Injected fsync failure'));return handle;});
    }else{
      const unlink=filesystem.unlink;
      vi.spyOn(filesystem,'unlink').mockImplementation(async target=>{if(String(target)===path.join(root,'source'))throw new Error('Injected unlink failure');return unlink(target);});
    }
    const result=await tools.execute(context,{name:'rename_file',args:{path:'source',destination:'destination',baseHash:before.hash}});
    expect(result).toMatchObject({ok:false,data:{mutation:'uncertain',uncertain:true}});
    expect(await readFile(path.join(root,'source'),'utf8')).toBe('retained bytes');expect(await readFile(path.join(root,'destination'),'utf8')).toBe('retained bytes');
  });
  it('patches original line intervals without normalizing CRLF or unrelated bytes and rejects stale manual edits',async()=>{
    const before=await tools.save(root,'code','a\r\nb\r\nlast',null);
    const action={name:'patch_file',args:{path:'code',baseHash:before.hash,edits:[{startLine:2,deleteCount:1,text:'B\r\n'}]}};
    const preview=await tools.inspect(context,action);
    expect(preview.changes?.[0].after.content).toBe('a\r\nB\r\nlast');
    expect(preview.diff).toContain('-b');expect(preview.diff).toContain('+B');
    tools.setDirty(root,'code','editor',true);
    expect(await tools.execute(context,action)).toMatchObject({ok:false,data:{mutation:'not_started'}});
    tools.setDirty(root,'code','editor',false);
    await writeFile(path.join(root,'code'),'manual');
    expect(await tools.execute(context,action)).toMatchObject({ok:false,data:{mutation:'not_started'}});
    expect(await readFile(path.join(root,'code'),'utf8')).toBe('manual');
    expect(()=>patchSnapshot(before,[{startLine:2,deleteCount:2,text:''},{startLine:3,deleteCount:0,text:'x'}])).toThrow('nonoverlapping');
  });
  it('returns bounded ranges and whole-file versions; literal search pages reject changed source',async()=>{
    const content=Array.from({length:250},(_,i)=>`literal .* ${i}\r\n`).join('');
    const before=await tools.save(root,'text',content,null);
    const read=await tools.execute(context,{name:'read_file_range',args:{path:'text',startLine:101,count:2}});
    expect(read).toMatchObject({ok:true,data:{hash:before.hash,startLine:101,totalLines:250,nextLine:103,content:'literal .* 100\r\nliteral .* 101\r\n'}});
    const first=await tools.execute(context,{name:'search_page',args:{query:'.*',limit:100}});
    const data=first.data as {revision:string;nextOffset:number;matches:unknown[]};
    expect(data.matches).toHaveLength(100);expect(data.nextOffset).toBe(100);
    const next=await tools.execute(context,{name:'search_page',args:{query:'.*',offset:100,revision:data.revision,limit:100}});
    expect(next).toMatchObject({ok:true,data:{nextOffset:200}});
    await writeFile(path.join(root,'text'),content+'changed');
    expect(await tools.execute(context,{name:'search_page',args:{query:'.*',offset:100,revision:data.revision}})).toMatchObject({ok:false,data:{code:'CONFLICT'}});
    expect(await tools.execute(context,{name:'search_page',args:{query:'.*',offset:100}})).toMatchObject({ok:false});
    expect(()=>validateAction({name:'read_file_range',args:{path:'text',startLine:0,count:501}})).toThrow();
  });
  it('shows complete delete/move diffs and refuses source or destination dirty buffers/collisions',async()=>{
    const before=await tools.save(root,'source','original\n',null);
    const move={name:'rename_file',args:{path:'source',destination:'dest',baseHash:before.hash}};
    const preview=await tools.inspect(context,move);
    expect(preview.changes).toHaveLength(2);expect(preview.diff).toContain('--- /dev/null');expect(preview.diff).toContain('+++ /dev/null');
    tools.setDirty(root,'dest','editor',true);
    expect(await tools.execute(context,move)).toMatchObject({ok:false,data:{mutation:'not_started'}});
    tools.setDirty(root,'dest','editor',false);
    await writeFile(path.join(root,'dest'),'manual');
    expect(await tools.execute(context,move)).toMatchObject({ok:false,data:{mutation:'not_started'}});
    await rm(path.join(root,'dest'));
    expect(await tools.execute(context,move)).toMatchObject({ok:true,data:{hash:null,snapshots:[{path:'source',hash:null},{path:'dest',hash:before.hash}]}});
    const deletion={name:'delete_file',args:{path:'dest',baseHash:before.hash}};
    expect((await tools.inspect(context,deletion)).diff).toContain('-original');
    expect(await tools.execute(context,deletion)).toMatchObject({ok:true,data:{hash:null}});
  });
  it('bounds search discovery as well as retained matches and reports incomplete coverage',async()=>{
    const files=new WorkspaceFiles({maxFileBytes:10000,maxEntries:100,maxSearchFiles:3,leaseMs:45000});
    for(const name of ['a','b','c','d'])await writeFile(path.join(root,name),'needle');
    const result=await files.searchPage(root,'needle');
    expect(result.incomplete).toBe(true);expect(result.matches.map(match=>match.path)).toEqual(['a','b']);
  });
  it('never clobbers a late-created destination and preserves partial files after source/destination changes',async()=>{
    const files=new WorkspaceFiles({maxFileBytes:10000,maxEntries:100,maxSearchFiles:100,leaseMs:45000});
    const before=await tools.save(root,'source','original',null);
    let created=false;
    await expect(files.move(root,'source','dest',before.hash!,()=>{created=true;},()=>writeFileSync(path.join(root,'dest'),'manual'))).rejects.toMatchObject({code:'EEXIST'});
    expect(created).toBe(false);expect(await readFile(path.join(root,'dest'),'utf8')).toBe('manual');
    await rm(path.join(root,'dest'));
    await expect(files.move(root,'source','dest',before.hash!,()=>writeFileSync(path.join(root,'source'),'changed'))).rejects.toThrow('uncertain');
    expect(await readFile(path.join(root,'source'),'utf8')).toBe('changed');expect(await readFile(path.join(root,'dest'),'utf8')).toBe('original');
    await tools.save(root,'source','original',hash('changed'));await rm(path.join(root,'dest'));
    await expect(files.move(root,'source','dest',before.hash!,()=>{unlinkSync(path.join(root,'dest'));writeFileSync(path.join(root,'dest'),'replacement');})).rejects.toThrow('uncertain');
    expect(await readFile(path.join(root,'source'),'utf8')).toBe('original');expect(await readFile(path.join(root,'dest'),'utf8')).toBe('replacement');
  });
});

describe('known-scope instruction discovery',()=>{
  it('loads root and only applicable ancestors with deterministic nearest priority and stable absent coverage',async()=>{
    await mkdir(path.join(root,'src','child'),{recursive:true});await mkdir(path.join(root,'sibling'));
    await writeFile(path.join(root,'AGENTS.md'),'root rule');await writeFile(path.join(root,'src','AGENTS.md'),'src rule');await writeFile(path.join(root,'src','child','AGENTS.md'),'nearest rule');await writeFile(path.join(root,'sibling','AGENTS.md'),'irrelevant sibling');
    const snapshot=await readProjectInstructions(tools,root,['src/child/file']);
    expect(snapshot.message.content).toContain('nearest rule');expect(snapshot.message.content).toContain('src rule');expect(snapshot.message.content).not.toContain('irrelevant sibling');
    expect((await readProjectInstructions(tools,root,['src/child/file','missing/file'])).hash).toBe(snapshot.hash);
    await writeFile(path.join(root,'src','child','AGENTS.md'),'');
    expect((await readProjectInstructions(tools,root,['src/child/file'])).hash).not.toBe(snapshot.hash);
  });
  it('fails closed on nested linked/oversized guidance and bounded target depth/count',async()=>{
    await mkdir(path.join(root,'src'));await writeFile(path.join(root,'data'),'rules');
    await link(path.join(root,'data'),path.join(root,'src','AGENTS.md'));
    await expect(readProjectInstructions(tools,root,['src/file'])).rejects.toThrow('Cannot safely read');
    await rm(path.join(root,'src','AGENTS.md'));await writeFile(path.join(root,'src','AGENTS.md'),'é'.repeat(16001));
    await expect(readProjectInstructions(tools,root,['src/file'])).rejects.toThrow('32,000');
    await expect(readProjectInstructions(tools,root,Array.from({length:101},(_,i)=>`x${i}`))).rejects.toThrow('narrow scope');
    await expect(readProjectInstructions(tools,root,['a/'.repeat(17)+'file'])).rejects.toThrow('depth 16');
  });
  it('restricts architect maintenance to canonical AGENTS patches in execution mode',async()=>{
    const action={name:'maintain_instructions',args:{path:'src/AGENTS.md',baseHash:null,edits:[{startLine:1,deleteCount:0,text:'Commands: npm test\n'}]}};
    expect(()=>validateAction(action,'architect','execute')).not.toThrow();
    expect(()=>validateAction(action,'architect','plan')).toThrow();expect(()=>validateAction(action,'coder','execute')).toThrow();
    expect(()=>validateAction({...action,args:{...action.args,path:'src/code.ts'}},'architect','execute')).toThrow();
    expect(publishedTools('architect','execute').some(tool=>tool.function.name==='write_file')).toBe(false);
    expect(await tools.execute(context,action)).toMatchObject({ok:true});
    expect(await readFile(path.join(root,'src','AGENTS.md'),'utf8')).toBe('Commands: npm test\n');
  });
});
