import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readConfig, publicSettings } from '../server/config.js';
import { loadPromptExtensions } from '../server/prompts.js';
import { createManagedHooks } from '../server/context.js';
import { Store } from '../server/store.js';

const roots: string[] = [];
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
async function file(content: string|Buffer) {const root=await mkdtemp(path.join(tmpdir(),'harness-prompts-'));roots.push(root);const filename=path.join(root,'architect.md');await writeFile(filename,content);return filename;}
describe('local role prompt configuration',()=>{
  it('loads configured role guidance without exposing files or text in browser settings',async()=>{
    const filename = await file('Return exactly the described JSON object. Preserve the UI labels.');
    const config = readConfig({ARCHITECT_PROMPT_FILE:filename});
    const prompts = await loadPromptExtensions(config);
    expect(prompts).toEqual({architect:'Return exactly the described JSON object. Preserve the UI labels.'});
    expect(JSON.stringify(publicSettings(config))).not.toContain(filename);
    expect(JSON.stringify(publicSettings(config))).not.toContain('Preserve the UI');
    const store = new Store(':memory:');
    try {
      const hooks = createManagedHooks({models:async()=>[],complete:async()=>{throw new Error('not called');}},store,config,{promptExtensions:prompts});
      expect(hooks.instructions('architect')).toContain('Preserve the UI labels.');
      expect(hooks.instructions('coder')).not.toContain('Preserve the UI labels.');
      expect(()=>hooks.parse('{"version":1,"type":"action","message":"","action":{"name":"invented","args":{}}}')).toThrow();
    } finally {store.close();}
  });
  it.each(['', 'x'.repeat(32001), Buffer.from([0xff,0xff]), 'text\0binary', 'private-key'])('rejects invalid or credential-containing guidance',async content=>{
    const filename=await file(content);
    const config=readConfig({ARCHITECT_PROMPT_FILE:filename,STARK_API_KEY:'private-key'});
    await expect(loadPromptExtensions(config)).rejects.toThrow('prompt file must be');
  });
  it('preserves defaults without configured files and fails clearly for missing files',async()=>{
    expect(await loadPromptExtensions(readConfig({}))).toEqual({});
    const filename=await file('ok');await rm(filename);
    await expect(loadPromptExtensions(readConfig({CRITIC_PROMPT_FILE:filename}))).rejects.toThrow('critic prompt file');
  });
});
