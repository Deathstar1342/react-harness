import { describe,expect,it } from 'vitest';
import { actionSchema, parseToolArguments, publishedTools, validateAction, toolRegistry, validateToolResult, RESULT_LIMITS } from '../server/tool-registry.js';
import { parseNativeJSON } from '../server/native-json.js';
import { protocolInstructions } from '../server/protocol.js';
const action=(name:string,args:unknown)=>({name,args});
const cases: [string, Record<string, unknown>][] = [
  ['list_files', {}], ['read_file', { path: 'README.md' }], ['search', { query: 'hello', path: 'src' }],
  ['write_file', { path: 'empty.txt', content: '', baseHash: null }], ['write_file', { path: 'a', content: 'new', baseHash: 'a'.repeat(64) }],
  ['run_shell', { command: 'pwd', timeoutMs: 1 }], ['execute_python', { code: 'print(1)', timeoutMs: 600_000 }],
  ['git_status', {}], ['git_diff', { path: 'src/a.ts' }], ['run_tests', { command: 'pytest', reportPath: 'report.xml' }],
  ['set_plan', { phases: [{ id: 'phase', title: 'Implementation', steps: [{ id: 'step', title: 'Check', status: 'in_progress' }] }] }],
  ['delegate', { objective: 'Check implementation', acceptanceCriteria: ['Tests pass'], paths: ['src'] }],
  ['review', { focus: 'Evidence' }], ['ask_user', { question: 'Which option?' }],
  ['review_result', { verdict: 'pass', findings: [] }], ['review_result', { verdict: 'changes_requested', findings: ['Missing verification'] }],
];


describe('single native tool registry',()=>{
 it.each(cases)('validates published %s arguments',(name,args)=>{expect(parseToolArguments(name,JSON.stringify(args))).toEqual({name,args});expect(actionSchema.parse({name,args})).toEqual({name,args});});
 it.each([
    action('unknown_action', {}), action('git_status', { command: 'rm' }),
    action('write_file', { path: 'a', content: 'x' }),
    action('write_file', { path: 'a', content: 'x', baseHash: '' }),
    action('write_file', { path: 'a', content: 'x', baseHash: 123 }),
    action('run_shell', { command: 'x', timeoutMs: '100' }),
    action('run_shell', { command: ' ', timeoutMs: 1 }),
    action('run_shell', { command: 'x', timeoutMs: 0 }),
    action('run_shell', { command: 'x', timeoutMs: 600_001 }),
    action('run_shell', { command: 'x', timeoutMs: 1.5 }),
    action('read_file', { path: 'a\0b' }), action('read_file', { path: '' }),
    action('delegate', { objective: 'task', acceptanceCriteria: [] }),
    action('review_result', { verdict: 'approved', findings: [] }),
    action('review_result', { verdict: 'pass', findings: 'all good' }),
    action('review_result', { verdict: 'pass', findings: [], approved: true }),
    action('set_plan', { phases: [{ id: 'p', title: 'p', steps: [{ id: 's', title: 's', status: 'passed' }] }] }),
    action('set_plan', { phases: [{ id: 'p', title: 'p', steps: [], extra: true }] }),
    action('set_plan', { phases: [{ id: 'p', title: 'p', steps: [] }, { id: 'p', title: 'other', steps: [] }] }),
    action('set_plan', { phases: [{ id: 'p', title: 'p', steps: [{ id: 's', title: 's', status: 'done' }, { id: 's', title: 'other', status: 'pending' }] }] }),

 ])('rejects invalid native arguments %#',value=>expect(()=>parseToolArguments(value.name,JSON.stringify(value.args))).toThrow());
 it.each(cases)('rejects extra %s fields',(name,args)=>expect(()=>parseToolArguments(name,JSON.stringify({...args,unrecognized:true}))).toThrow());
 it('rejects every argument prefix and duplicate decoded keys',()=>{
   const full=JSON.stringify({path:'a',content:'do not execute partial streams',baseHash:null});
   for(let end=0;end<full.length;end++)expect(()=>parseToolArguments('write_file',full.slice(0,end))).toThrow();
   for(const raw of ['{"path":"a","path":"b"}','{"path":"a","pa\\u0074h":"b"}','{"nested":{"a":1,"a":2}}'])expect(()=>parseNativeJSON(raw)).toThrow();
 });
 it('publishes role and mode restrictions and enforces them independently',()=>{
   expect(publishedTools('critic').map(t=>t.function.name)).not.toContain('recommend_packages');
   expect(publishedTools('coder','plan').map(t=>t.function.name)).not.toContain('write_file');
   expect(publishedTools('install_reviewer').map(t=>t.function.name)).toEqual(['install_decision']);
   expect(()=>validateAction({name:'run_shell',args:{command:'pwd'}},'critic','execute')).toThrow();
   expect(()=>validateAction({name:'delegate',args:{objective:'x',acceptanceCriteria:['x']}},'architect','plan')).toThrow();
   for(const d of toolRegistry.values()){expect(d.handler).toBeTypeOf('function');expect(d.inspect).toBeTypeOf('function');expect(d.result.safeParse({ok:true,output:'evidence'}).success).toBe(true);}
 });
 it('keeps instructions native, truthful and bounded',()=>{
   for(const role of ['architect','coder','critic'] as const){expect(protocolInstructions(role)).toContain('native tools');expect(protocolInstructions(role)).not.toContain('JSON recommendation');}
   expect(protocolInstructions('coder','Preserve manual work')).toContain('Preserve manual work');
   expect(()=>protocolInstructions('coder','x'.repeat(32001))).toThrow();
 });
 it('enforces output bytes and finite bounded serializable result data',()=>{
   const cyclic:any={};cyclic.self=cyclic;
   let deep:any={};for(let i=0;i<RESULT_LIMITS.depth+1;i++)deep={child:deep};
   for(const data of [cyclic,deep,BigInt(1),()=>{},NaN,{value:Infinity},'x'.repeat(RESULT_LIMITS.dataBytes),Array(RESULT_LIMITS.dataNodes+1).fill(null)])expect(()=>validateToolResult({ok:true,output:'evidence',data})).toThrow(/Invalid native tool result/);
   expect(()=>validateToolResult({ok:true,output:'é'.repeat(Math.floor(RESULT_LIMITS.outputBytes/2)+1)})).toThrow();
   expect(()=>validateToolResult({ok:true,output:'valid',unexpected:true})).toThrow();
   expect(validateToolResult({ok:false,output:'Observed failure',data:{exitCode:1,optional:undefined}}).ok).toBe(false);
 });
});
