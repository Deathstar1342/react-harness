import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TerminalPanel } from '../client/TerminalPanel';
import { commandLabel, consoleText, terminalHistory } from '../client/terminal';
import type { ChatDetail, CommandEvent, RunEvent } from '../shared/types';

const command=(id:string,status:CommandEvent['status']='running',extra:Partial<CommandEvent>={}):CommandEvent=>({commandId:id,agentId:'agent',sessionId:'shell',role:'coder',action:{name:'run_shell',args:{command:`echo ${id}`}},status,...extra});
const event=(id:number,type:string,data:unknown,chatId='chat'):RunEvent=>({id,type,data,chatId,createdAt:''});
const output=(id:number,commandId:string,text:string)=>event(id,'tool_output',{commandId,agentId:'agent',sessionId:'shell',output:text});
const detail=(events:RunEvent[],extras:Partial<ChatDetail>={}):ChatDetail=>({chat:{id:'chat',projectId:'p',title:'Chat',status:'idle',approvalMode:'autonomous',createdAt:'',updatedAt:''},messages:[],approvals:[],plan:{phases:[]},tests:[],events,...extras});
const render=(events:RunEvent[],extras:Partial<ChatDetail>={},connected=true)=>renderToStaticMarkup(createElement(TerminalPanel,{detail:detail(events,extras),connected,onClose(){}}));

describe('terminal projection and read-only markup',()=>{
  it('deduplicates replay IDs, separates exact commands and sessions, and replaces overlapping chunks with final snapshot',()=>{
    const events=[event(1,'command',command('a')),output(2,'a','first'),output(2,'a','first'),event(3,'command',command('a','completed',{exitCode:0,output:'first final'})),event(4,'command',command('b')),output(5,'b','second'),event(6,'command',command('b','failed',{exitCode:2,output:'second'}))];
    const result=terminalHistory(events.reverse(),'chat');
    expect(result.commands.map(item=>item.output)).toEqual(['first final','second']);
    expect(result.commands.map(commandLabel)).toEqual(['Completed','Failed']);
    expect(result.unassociated).toEqual([]);
    expect(render(events)).toContain('Exit 2');
  });
  it('keeps legacy commands and output unassociated even when the agent or text matches',()=>{
    const events=[event(1,'command',command('a')),event(2,'tool_output',{agentId:'agent',output:'legacy'}),event(3,'tool',{agentId:'agent',action:{name:'run_shell',args:{command:'echo a'}},result:{ok:true,output:'success'}})];
    const result=terminalHistory(events,'chat');
    expect(result.commands[0].output).toBe('');expect(result.commands[0].lifecycle?.status).toBe('running');expect(result.unassociated).toHaveLength(2);
    expect(render(events)).toContain('not assigned to a command or treated as completion evidence');
  });
  it('does not attribute another chat or conflicting session/agent IDs to a command',()=>{
    const events=[event(1,'command',command('a')),event(2,'tool_output',{commandId:'a',agentId:'agent',sessionId:'wrong',output:'wrong'}),event(3,'tool_output',{commandId:'a',agentId:'other',sessionId:'shell',output:'other'}),event(4,'command',command('a','completed',{output:'other chat',exitCode:0}),'other')];
    const result=terminalHistory(events,'chat');expect(result.commands[0].output).toBe('');expect(result.unassociated).toHaveLength(2);
    expect(terminalHistory(events,'other').commands[0].output).toBe('other chat');
  });
  it('never infers completion from output or model prose, or a retained start alone',()=>{
    const events=[output(1,'missing','All passed; exit code 0'),event(2,'message',{role:'architect',content:'Completed'}),event(3,'command',command('running'))];
    const result=terminalHistory(events,'chat');expect(result.commands.map(commandLabel)).toEqual(['Unknown outcome','Running (last recorded)']);
    const html=render(events,{eventsTruncated:true},false);
    for(const text of ['Earlier history is omitted','Start event unavailable','No completion recorded','Reconnecting','output alone does not establish success'])expect(html).toContain(text);
    expect(html).not.toContain('Exit 0');
  });
  it('uses a retained outcome snapshot without requiring its omitted start and distinguishes empty output',()=>{
    const html=render([event(2,'command',command('a','completed',{output:'',exitCode:0}))],{eventsTruncated:true});
    for(const text of ['Completed','Exit 0','No output was captured','Start event unavailable'])expect(html).toContain(text);
  });
  it('retains streamed output after uncertain recovery and cannot regress to running on a repeated start',()=>{
    const result=terminalHistory([event(1,'command',command('a')),output(2,'a','partial'),event(3,'command',command('a','uncertain',{shellReset:true})),event(4,'command',command('a'))],'chat');
    expect(result.commands[0].output).toBe('partial');expect(commandLabel(result.commands[0])).toBe('Uncertain');
  });
  it('bounds streamed output and exposes both snapshot and chunk truncation',()=>{
    const events=[event(1,'command',command('a')),output(2,'a','x'.repeat(70_000))];
    const result=terminalHistory(events,'chat');expect(result.commands[0].output.length).toBe(64_000);expect(result.commands[0].outputTruncated).toBe(true);
    expect(render(events)).toContain('Output truncated');
    expect(terminalHistory([event(1,'command',command('a','completed',{output:'bounded',exitCode:0,truncated:true}))],'chat').commands[0].outputTruncated).toBe(true);
    expect(terminalHistory([event(1,'tool_output',{commandId:'a',sessionId:'shell',agentId:'agent',output:'part',truncated:true})],'chat').commands[0].outputTruncated).toBe(true);
  });
  it('renders cancellation, timeout, Python source, and errors without internal prose or interactive command controls',()=>{
    const events=[event(1,'command',command('a','interrupted',{action:{name:'execute_python',args:{code:'print("hello")'}},timedOut:true,shellReset:true,message:'Time limit reached'})),event(2,'message',{role:'critic',content:'private critic commentary'}),event(3,'tool',{action:{name:'read_file'},result:{output:'internal read'}})];
    const html=render(events);
    for(const text of ['Interrupted','Timed out','Time limit reached','Python source','Shell state was lost','Read-only command evidence'])expect(html).toContain(text);
    expect(html).not.toMatch(/private critic commentary|internal read|<input|<textarea|contenteditable/);
  });
  it('escapes console HTML and strips ANSI without terminal interpretation',()=>{
    const html=render([event(1,'command',command('a','completed',{output:'<script>alert(1)</script>\x1b[31mred\x1b[0m',exitCode:0}))]);
    expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).not.toContain('\x1b');
    expect(consoleText('\x1b]0;title\x07plain')).toBe('plain');
  });
  it('starts closed beside Files, toggles only local state, retains test drawer and keyed chat isolation (source contract)',()=>{
    const app=readFileSync(new URL('../client/App.tsx',import.meta.url),'utf8');
    expect(app).toContain('const [terminalOpen, setTerminalOpen] = useState(false)');
    expect(app).toMatch(/title="Files">[\s\S]*?setTerminalOpen\(open=>!open\).*?>Terminal<\/button>/);
    expect(app).toContain('terminalOpen && <TerminalPanel');expect(app).toContain('onClose={()=>setTerminalOpen(false)}');
    expect(app).toContain('<ActivityDrawer events={detail.events} tests={detail.tests} debug={debug} />');expect(app).toMatch(/<Conversation\s+key={chatId}/);
    const panel=readFileSync(new URL('../client/TerminalPanel.tsx',import.meta.url),'utf8');
    expect(panel).not.toMatch(/\b(fetch|post|request|EventSource)\s*\(/);
  });
});
