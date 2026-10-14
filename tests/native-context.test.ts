import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { createManagedHooks } from '../server/context.js';
import { readConfig } from '../server/config.js';
import { validateNativeHistory } from '../server/provider.js';
import { estimateTokens } from '../server/scheduler.js';
import { publishedTools } from '../server/tool-registry.js';
import type { Frame, RunState } from '../server/runtime.js';
import type { ModelMessage } from '../shared/types.js';
import { nativeReply } from './native-fixture.js';

const stores:Store[]=[],roots:string[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(pending=false) {
  const store=new Store(':memory:');stores.push(store);const project=store.createProject('Native context','/workspace'),chat=store.createChat(project.id,'Task','review');
  const calls=Array.from({length:4},(_,i)=>nativeReply('read_file',{path:`file-${i}`}).toolCalls![0]);
  const messages:ModelMessage[]=[{role:'user',content:'Preserve human edits'},...Array.from({length:30},()=>({role:'assistant' as const,content:'Historical observation '+ 'x'.repeat(2000)})),{role:'assistant',content:'Read evidence',tool_calls:calls},...calls.slice(0,pending?2:4).map(call=>({role:'tool' as const,tool_call_id:call.id,content:'Observed file contents'}))];
  const frame:Frame={id:'frame',role:'coder',messages,repairs:0};
  store.setState(`run:${chat.id}`,{frames:[frame],steering:[],generation:0,steps:0,planOnly:false} satisfies RunState);
  const provider={models:async()=>[],complete:vi.fn(async()=>({text:'Observed prior work; preserve human edits. Completion remains unverified.',finishReason:'stop'}))};
  const config=readConfig({CODER_INPUT_TOKEN_LIMIT:'32000',MODEL_MAX_OUTPUT_TOKENS:'256'});
  return {store,chat,frame,calls,provider,hooks:createManagedHooks(provider,store,config)};
}
it('keeps a native batch indivisible across the recent-history compaction boundary',async()=>{
  const t=fixture(),original=structuredClone(t.frame.messages);
  const result=await t.hooks.prepareMessages!(t.chat.id,t.frame,[{role:'system',content:'Trusted instructions'},...t.frame.messages],new AbortController().signal);
  validateNativeHistory(result);expect(result.filter(m=>m.role==='tool')).toHaveLength(4);
  expect(result.find(m=>m.role==='assistant'&&m.tool_calls)?.role).toBe('assistant');
  const summary=t.store.events(t.chat.id).find(e=>e.type==='context_summary')!;
  expect(t.store.getState<{messages:ModelMessage[]}>((summary.data as any).archiveKey,{messages:[]}).messages).toEqual(original);
});
it('refuses to compact an unresolved batch and leaves pending history untouched',async()=>{
  const t=fixture(true),original=structuredClone(t.frame.messages);
  await expect(t.hooks.prepareMessages!(t.chat.id,t.frame,[{role:'system',content:'Trusted'},...t.frame.messages],new AbortController().signal)).rejects.toThrow();
  expect(t.frame.messages).toEqual(original);expect(t.provider.complete).not.toHaveBeenCalled();
});
it('accounts for native arguments, result IDs and published schemas',()=>{
  const call=nativeReply('write_file',{path:'a',content:'🌍'.repeat(1000),baseHash:null}).toolCalls![0];
  const history:ModelMessage[]=[{role:'assistant',content:'',tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:'Observed result'}];
  expect(estimateTokens(history)).toBeGreaterThan(4000);expect(estimateTokens(history,publishedTools('coder'))).toBeGreaterThan(estimateTokens(history)+1000);
});
it('rejects old populated state without changing its bytes or deleting files',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'native-profile-'));roots.push(root);const filename=path.join(root,'state.sqlite');
  const old=new DatabaseSync(filename);old.exec("CREATE TABLE state(key TEXT PRIMARY KEY,data TEXT); INSERT INTO state VALUES('private-project','preserve');");old.close();
  const bytes=readFileSync(filename);expect(()=>new Store(filename)).toThrow('fresh application home');expect(readFileSync(filename)).toEqual(bytes);
});
