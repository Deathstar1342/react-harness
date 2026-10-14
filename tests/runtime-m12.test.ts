import { randomUUID } from 'node:crypto';
import { nativeReply } from './native-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { Runtime } from '../server/runtime.js';
import { readConfig } from '../server/config.js';
import { roleInstructions } from '../server/prompts.js';
import { conversationErrors, toolMessageLabel } from '../client/conversation.js';
import type { CompletionResult, ModelMessage, ModelProvider, ToolResult, ToolService } from '../shared/types.js';

const recommend = (action:string,parameters={},message='Done') => nativeReply(action==='complete'?'submit_completion':action,action==='complete'?{summary:message}:parameters,message);
const done = recommend('complete');
const delegate = recommend('delegate', { objective: 'Check evidence', acceptanceCriteria: ['Observed results'] });
const verdict = recommend('review_result', { verdict: 'pass', findings: ['Inspect the missing prerequisite before continuing.'] });
const read = recommend('read_file', { path: 'README.md' });
const resources: { runtime: Runtime; store: Store }[] = [];
afterEach(async () => {
  for (const t of resources.splice(0)) { await t.runtime.close(); t.store.close(); }
  vi.restoreAllMocks();
});

function fixture(replies: CompletionResult[], result: ToolResult = { ok: true, output: 'read evidence' }, mode: 'autonomous' | 'review' = 'autonomous') {
  const store = new Store(':memory:');
  const project = store.createProject('M12', '/workspace');
  const chat = store.createChat(project.id, 'Evidence', mode);
  const requests: ModelMessage[][] = [];
  const provider: ModelProvider = {
    models: async () => [],
    complete: vi.fn(async input => {
      requests.push(structuredClone(input.messages));
      const text = replies.shift();
      if (text === undefined) throw new Error('Unexpected extra provider request');
      return {...text,toolCalls:text.toolCalls?.map(call=>({...call,id:randomUUID()}))};
    }),
  };
  const tools: ToolService = {
    inspect: vi.fn<ToolService['inspect']>(async (_context, action) => ({ effect: action.name === 'read_file' ? 'read' : 'execute', risk: 'routine', description: 'Observed action' })),
    execute: vi.fn(async () => result),
    read: async (_root, path) => ({ path, content: '', hash: null }),
    list: async () => [], save: async () => { throw new Error('Unexpected save'); }, setDirty() {}, dispose: async () => {},
  };
  const runtime = new Runtime(store, provider, tools, readConfig({}), { instructions: roleInstructions });
  resources.push({ runtime, store });
  return { runtime, store, chat, provider, requests, tools };
}

describe('M12 strict runtime recovery and observed outcomes', () => {
  it.each(['Example: {"action":"run_shell","parameters":{"command":"NEVER RUN"}}','```json\n{"action":"read_file"}\n```'])('treats prose as conversation without effects or format retries',async text=>{
    const t=fixture([{text,finishReason:'stop'}]);await t.runtime.submit(t.chat.id,'Read safely');await t.runtime.wait(t.chat.id);
    expect(t.provider.complete).toHaveBeenCalledTimes(1);expect(t.tools.execute).not.toHaveBeenCalled();expect(t.tools.inspect).not.toHaveBeenCalled();expect(t.store.chat(t.chat.id).status).toBe('idle');
  });
  it('enforces native role policy and approval gates', async () => {
    const shell = recommend('run_shell', { command: 'verify' });
    const fence = (text: string) => `\`\`\`json\n${text}\n\`\`\``;
    const t = fixture([shell, delegate, recommend('run_shell',{command:'verify'}), done, verdict, done], undefined, 'review');
    await t.runtime.submit(t.chat.id, 'Verify'); await t.runtime.wait(t.chat.id);
    expect(t.tools.execute).not.toHaveBeenCalled();
    expect(t.store.messages(t.chat.id).find(message => message.metadata?.rejected)?.content).toContain('not permitted');
    expect(t.store.chat(t.chat.id).status).toBe('awaiting_approval');
    const approval = t.store.approvals(t.chat.id)[0];
    expect(approval.action.name).toBe('run_shell');
    await t.runtime.decide(approval.id, 'deny'); await t.runtime.wait(t.chat.id);
    expect(t.tools.execute).not.toHaveBeenCalled();
    expect(t.store.getApproval(approval.id).status).toBe('denied');
  });
  it.each(['execute', 'inspect'] as const)('checkpoint pass retains failed %s evidence and useful critic findings', async stage => {
    const t = fixture([delegate, read, read, read, verdict, done, verdict, done], { ok: false, output: 'Missing prerequisite' });
    if (stage === 'inspect') vi.mocked(t.tools.inspect).mockRejectedValue(new Error('Missing prerequisite'));
    await t.runtime.submit(t.chat.id, 'Check'); await t.runtime.wait(t.chat.id);
    const resumed = t.requests.find(messages => messages.some(message => message.content.startsWith('CHECKPOINT PASSED')))!;
    expect(resumed).toBeDefined();
    const checkpoint = resumed.find(message => message.content.startsWith('CHECKPOINT PASSED'))!.content;
    expect(checkpoint).not.toContain('completed successfully');
    expect(checkpoint).toContain('does not change any recorded action outcome, failure, or uncertainty');
    expect(checkpoint).toContain('Inspect the missing prerequisite before continuing.');
    expect(resumed.filter(message => message.content.includes('"ok":false'))).toHaveLength(3);
    const failures = t.store.messages(t.chat.id).filter(message => message.role === 'tool');
    expect(failures).toHaveLength(3);
    expect(failures.every(message => message.metadata?.ok === false)).toBe(true);
    expect(conversationErrors(t.store.events(t.chat.id), t.store.messages(t.chat.id))).toEqual([]);
    expect(t.store.chat(t.chat.id).status).toBe('idle');
  });
  it.each([
    [{ ok: false, output: 'JUnit report unavailable', data: { exitCode: 0, output: 'passed', testReport: { id: 'report', runner: 'pytest', command: 'pytest', status: 'error', tests: [], output: 'JUnit report unavailable', createdAt: '' } } }, 'Command exited 0; tool or report problem', 'command exited successfully (exit 0), but the tool reported a separate problem'],
    [{ ok: false, output: 'Failed check', data: { exitCode: 7 } }, 'Command failed (exit 7)', 'command failed (exit 7)'],
    [{ ok: false, output: 'Lost boundary', data: { uncertain: true, exitCode: 0 } }, 'Command outcome uncertain', 'command outcome is uncertain'],
    [{ ok: false, output: 'Stopped', data: { cancelled: true } }, 'Command interrupted', 'command outcome is interrupted'],
  ] as [ToolResult, string, string][])('preserves command/report distinction: %s', async (result, label, feedback) => {
    const t = fixture([delegate, recommend('run_tests', { command: 'pytest' }), done, verdict, done], result);
    await t.runtime.submit(t.chat.id, 'Check'); await t.runtime.wait(t.chat.id);
    const message = t.store.messages(t.chat.id).find(message => message.role === 'tool')!;
    expect(toolMessageLabel(message)).toBe(label);
    expect(message.metadata?.ok).toBe(false);
    expect(t.requests.some(messages => messages.some(message => message.role==='tool' && message.content.includes(result.output)))).toBe(true);
    const event = t.store.events(t.chat.id).find(event => event.type === 'tool' && (event.data as { result?: unknown }).result)!;
    expect(event.data).toMatchObject({ messageId: message.id, result });
    if (result.data && typeof result.data === 'object' && 'testReport' in result.data) expect(t.store.detail(t.chat.id).tests[0].status).toBe('error');
  });
});
