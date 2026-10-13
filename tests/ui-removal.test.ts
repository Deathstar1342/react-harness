import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { Overflow, RemovalDialog, removeChat, removeProject } from '../client/RemovalDialog';

afterEach(()=>vi.unstubAllGlobals());
const project={id:'project/id',name:'Imported <project>',path:'/exact/imported/path',createdAt:''};
const props={project,blocked:false,onClose:()=>{},onRemoved:()=>{},onFailure:()=>{}};
it('project dialog exposes all three choices and an escaped exact path',()=>{
  const html=renderToStaticMarkup(createElement(RemovalDialog,props));
  for(const label of ['Remove from app only','Delete project and files','Cancel','/exact/imported/path','Imported &lt;project&gt;']) expect(html).toContain(label);
  expect(html).toContain('aria-labelledby="removal-title"');
});
it('chat confirmation explains that files remain and dirty editors disable deletion',()=>{
  const html=renderToStaticMarkup(createElement(RemovalDialog,{...props,blocked:true,chat:{id:'chat',projectId:project.id,title:'<chat>',status:'paused',approvalMode:'review',createdAt:'',updatedAt:''}}));
  expect(html).toContain('Project files will remain');expect(html).toContain('Save or discard');expect(html).toContain('disabled=""');expect(html).toContain('&lt;chat&gt;');
});
it('overflow has a named keyboard button, disclosure state and independent action region',()=>{
  const html=renderToStaticMarkup(createElement(Overflow,{label:'Chat My chat',onRemove:()=>{}}));
  expect(html).toContain('aria-label="Chat My chat options"');expect(html).toContain('aria-expanded="false"');expect(html).toContain('aria-controls=');
});
it('sends explicit deletion modes and preserves the exact confirmed path without normalization',async()=>{
  const fetcher=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({ok:true})));vi.stubGlobal('fetch',fetcher);
  await removeProject(project.id,{mode:'app-only'});expect(fetcher.mock.calls[0][0]).toBe('/api/projects/project%2Fid');expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({mode:'app-only'});
  const body={mode:'disk' as const,canonicalPath:'C:\\Imported folder\\Exact case',confirmationToken:'token'};await removeProject(project.id,body);expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(body);
  await removeChat('chat/id');expect(fetcher.mock.calls[2][0]).toBe('/api/chats/chat%2Fid');expect(fetcher.mock.calls[2][1].method).toBe('DELETE');expect(fetcher.mock.calls[2][1].body).toBe('{}');
});
it('surfaces backend removal failure instead of claiming success',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'File deletion incomplete; records retained'}),{status:409})));
  await expect(removeProject(project.id,{mode:'app-only'})).rejects.toThrow('records retained');
});
