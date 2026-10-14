import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Runtime } from '../server/runtime.js';
import { WorkspaceTools } from '../server/tools/index.js';
import { readConfig } from '../server/config.js';
import { roleInstructions } from '../server/prompts.js';
import { validateNativeHistory } from '../server/provider.js';
import type { Action, CompletionResult, ModelProvider, PlanStepRef, ToolResult, ToolService } from '../shared/types.js';
import { nativeReply } from './native-fixture.js';

export type Input = Parameters<ModelProvider['complete']>[0];
export type Reply = CompletionResult | ((input: Input) => CompletionResult | Promise<CompletionResult>);
export const call = (name: string, args: Record<string,unknown> = {}) => nativeReply(name, args);
export const complete = () => call('submit_completion', {summary: 'Bounded assignment evidence submitted; later scope remains.'});
export const pass = () => call('review_result', {verdict: 'pass', findings: ['Inspected recorded evidence for the assigned criterion.']});
export const stateOf = (input: Input) => JSON.parse(input.messages.find(message=>message.content.startsWith('Authoritative task state'))!.content.split('\n').slice(1).join('\n'));
export const testResult = (status: 'passed'|'failed'|'error'|'skipped'): ToolResult => ({
  ok: status === 'passed', output: `Synthetic command/report: ${status}`, data: { exitCode: status === 'failed' ? 1 : 0,
    testReport: {id: `synthetic-${status}`,runner:'synthetic',command:'full suite',createdAt:'2026-10-14',status:status === 'skipped' ? 'passed' : status,tests:status === 'error' ? [] : [{name:'acceptance',status}],output:'Synthetic fixture, not a host or live-provider execution'},
  },
});

/** Real SQLite/runtime/file tools; only provider and command outcomes are synthetic. */
export async function orchestrationFixture(phases = 1) {
  const root = await mkdtemp(path.join(tmpdir(), 'm23-scenario-'));
  const store = new Store(':memory:');
  const workspace = new WorkspaceTools();
  const project = store.createProject('M23 evaluation', root), chat = store.createChat(project.id, 'Scenario', 'autonomous');
  const plan = store.revisePlan(chat.id, {phases: Array.from({length:phases}, (_, i)=>({id:`phase-${i+1}`,title:`Phase ${i+1}`,steps:[{id:`step-${i+1}`,title:`Deliver phase ${i+1}`,status:'pending' as const}]}))});
  const reference = (phase = 1): PlanStepRef => ({planId:plan.id!, planVersion:plan.version!, phaseId:`phase-${phase}`,stepId:`step-${phase}`});
  const replies: Reply[] = [], requests: Input[] = [], executed: Action[] = [], commandResults: ToolResult[] = [];
  const tools: ToolService = {
    inspect: async (context, action) => ['run_tests','run_shell','execute_python'].includes(action.name) ? {effect:'execute',risk:'routine',description:'Synthetic command fixture'} : workspace.inspect(context, action),
    execute: async (context, action) => {
      executed.push(structuredClone(action));
      if (['run_tests','run_shell','execute_python'].includes(action.name)) {
        const result = commandResults.shift(); if (!result) throw new Error('Missing synthetic command result'); return result;
      }
      return workspace.execute(context, action);
    },
    read: workspace.read.bind(workspace), list: workspace.list.bind(workspace), save: workspace.save.bind(workspace), setDirty: workspace.setDirty.bind(workspace), dispose: workspace.dispose.bind(workspace),
  };
  const provider: ModelProvider = {models:async()=>[],complete:async input=>{
    validateNativeHistory(input.messages);
    requests.push({...input,messages:structuredClone(input.messages)});
    const reply = replies.shift(); if (!reply) throw new Error('Unexpected scenario provider request');
    return typeof reply === 'function' ? await reply(input) : reply;
  }};
  const config = readConfig({});
  const runtime = new Runtime(store,provider,tools,config,{instructions:roleInstructions});
  const delegate = (phase = 1, extra: Record<string,unknown> = {}) => call('delegate',{objective:`Deliver phase ${phase}`,acceptanceCriteria:[`Inspect evidence for phase ${phase}; preserve manual.txt`],paths:['result.txt','README.md'],planStep:reference(phase),...extra});
  return {root,store,chat,plan,reference,replies,requests,executed,commandResults,tools,runtime,config,provider,delegate,
    seed: (name='result.txt',content='Original observed file')=>writeFile(path.join(root,name),content),
    run: async(text='Implement the full plan; preserve manual.txt')=>{await runtime.submit(chat.id,text);await runtime.wait(chat.id);},
    close:async()=>{await runtime.close();await workspace.dispose();store.close();await rm(root,{recursive:true,force:true});},
  };
}
