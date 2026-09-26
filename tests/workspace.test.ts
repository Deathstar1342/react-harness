import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { parseAgentResponse, protocolInstructions } from '../server/protocol.js';
import { WorkspaceTools } from '../server/tools/index.js';
import type { DirectoryListing, WorkspaceSettings } from '../shared/types.js';

const cleanup: (()=>Promise<void>)[] = [];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(),'harness-workspace-'));
  cleanup.push(async()=>{if(path.dirname(root)!==path.resolve(tmpdir()) || !path.basename(root).startsWith('harness-workspace-')) throw new Error('Unexpected cleanup path');await rm(root,{recursive:true,force:true});});
  const config = readConfig({HARNESS_DATA_DIR:path.join(root,'state'),HARNESS_WORKSPACE_ROOT:path.join(root,'default')});
  const build = async()=>{
    const result=await createApp({config,tools:new WorkspaceTools(),provider:{models:async()=>[],complete:async()=>{throw new Error('Model calls not expected');}},hooks:{parse:parseAgentResponse,instructions:protocolInstructions}});
    return result;
  };
  const first=await build();
  let current=first;
  cleanup.push(()=>current.app.close());
  return {root,config,first,restart:async()=>{await current.app.close();current=await build();return current;}};
}
describe('workspace settings and folder explorer API',()=>{
  it('allocates distinct projects without requiring paths and initializes Git',async()=>{
    const {first,config}=await fixture();
    const replies=await Promise.all([1,2].map(()=>first.app.inject({method:'POST',url:'/api/projects',payload:{name:'My new project',mode:'create'}})));
    expect(replies.map(reply=>reply.statusCode)).toEqual([201,201]);
    const projects=replies.map(reply=>reply.json());
    expect(new Set(projects.map(project=>project.path)).size).toBe(2);
    for(const project of projects) {
      expect(path.dirname(project.path)).toBe(await realpath(config.workspaceRoot));
      expect((await stat(path.join(project.path,'.git'))).isDirectory()).toBe(true);
    }
  });
  it('persists a chosen workspace across restart without moving existing projects',async()=>{
    const t=await fixture();
    const original=(await t.first.app.inject({method:'POST',url:'/api/projects',payload:{name:'Original',mode:'create'}})).json();
    const chosen=path.join(t.root,'chosen');
    const result=await t.first.app.inject({method:'PATCH',url:'/api/workspace',payload:{workspaceRoot:chosen}});
    expect(result.statusCode).toBe(200);
    expect(result.json<WorkspaceSettings>()).toEqual({workspaceRoot:chosen,defaultWorkspaceRoot:t.config.workspaceRoot});
    const next=await t.restart();
    expect((await next.app.inject('/api/workspace')).json<WorkspaceSettings>().workspaceRoot).toBe(chosen);
    const created=(await next.app.inject({method:'POST',url:'/api/projects',payload:{name:'New',mode:'create'}})).json();
    expect(path.dirname(created.path)).toBe(await realpath(chosen));
    expect(next.store.projects().find(item=>item.id===original.id)?.path).toBe(original.path);
    expect((await stat(original.path)).isDirectory()).toBe(true);
  });
  it('browses folders and imports the selected directory without copying or altering files',async()=>{
    const {first,root}=await fixture();
    const selected=path.join(root,'existing');
    await mkdir(selected);await mkdir(path.join(root,'.hidden'));
    await writeFile(path.join(root,'not-a-folder.txt'),'not a directory');
    await writeFile(path.join(selected,'manual.txt'),'Keep this manual change');
    const response=await first.app.inject(`/api/directories?path=${encodeURIComponent(root)}`);
    expect(response.statusCode).toBe(200);
    const listing=response.json<DirectoryListing>();
    expect(listing.entries.map(item=>item.name)).toContain('existing');
    expect(listing.entries.map(item=>item.name)).not.toContain('.hidden');
    expect(listing.entries.map(item=>item.name)).not.toContain('not-a-folder.txt');
    expect(listing.path).toBe(await realpath(root));
    expect(listing.parentPath).toBe(path.dirname(await realpath(root)));
    expect(listing.roots.some(item=>item.name==='Home')).toBe(true);
    const imported=await first.app.inject({method:'POST',url:'/api/projects',payload:{name:'Existing',path:selected,mode:'import'}});
    expect(imported.statusCode).toBe(201);
    expect(imported.json().path).toBe(await realpath(selected));
    expect(await readFile(path.join(selected,'manual.txt'),'utf8')).toBe('Keep this manual change');
  });
  it('validates workspace and folder selections before side effects',async()=>{
    const {first,root,config}=await fixture();
    await writeFile(path.join(root,'plain-file'),'x');
    for(const workspaceRoot of ['relative',path.parse(root).root,path.join(root,'plain-file')]) expect((await first.app.inject({method:'PATCH',url:'/api/workspace',payload:{workspaceRoot}})).statusCode).toBe(400);
    expect((await first.app.inject('/api/workspace')).json<WorkspaceSettings>().workspaceRoot).toBe(config.workspaceRoot);
    expect((await first.app.inject({method:'POST',url:'/api/projects',payload:{name:'Bad import',mode:'import'}})).statusCode).toBe(400);
    expect((await first.app.inject('/api/directories?path=relative')).statusCode).toBe(400);
    expect((await first.app.inject({method:'GET',url:'/api/directories',headers:{origin:'https://untrusted.example'}})).statusCode).toBe(403);
    expect((await first.app.inject({method:'PATCH',url:'/api/workspace',headers:{origin:'https://untrusted.example'},payload:{workspaceRoot:root}})).statusCode).toBe(403);
  });
});
