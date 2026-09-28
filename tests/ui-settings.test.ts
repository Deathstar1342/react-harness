import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../client/WorkspaceDialogs';
import { ConnectionResults } from '../client/SettingsControls';
import { ActivityDrawer, ApprovalCard, TestRun } from '../client/Panels';
import { conversationErrors, visibleMessages } from '../client/conversation';
import { saveChatApproval, savePreferences, testConnection } from '../client/settings';
import type { ConnectionReport, Message, RunEvent } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('focused chat and settings', () => {
  it('distinguishes current-chat approval and future-chat default, retains workspace, and offers Debug off and connection checks', () => {
    const html = renderToStaticMarkup(createElement(SettingsDialog, { onClose() {} }));
    for (const text of ['Current chat', 'Default for future chats', 'Debug mode off', 'Test connection', 'Default workspace', 'Save workspace', 'account request and token budgets', 'changes save immediately']) expect(html).toContain(text);
    expect(html).toContain('role="switch" aria-checked="false"');
    expect(html).not.toMatch(/streaming|JSON mode|API key.*input/i);
  });
  it('shows user/architect/system and failed tools by default while preserving every message in Debug', () => {
    const messages: Message[] = ['user', 'architect', 'coder', 'critic', 'tool', 'system'].map((role, index) => ({ id: String(index), role: role as Message['role'], content: `${role} content`, chatId: 'c', createdAt: '' }));
    messages.push({ id: 'failure', role: 'tool', chatId: 'c', content: 'Permission denied', createdAt: '', metadata: { ok: false } });
    expect(visibleMessages(messages, false).map(message => message.role)).toEqual(['user', 'architect', 'system', 'tool']);
    expect(visibleMessages(messages, false).at(-1)?.content).toBe('Permission denied');
    expect(visibleMessages(messages, true)).toEqual(messages);
  });
  it('keeps runtime and caught tool failures visible without leaking successful traces into focused errors', () => {
    const events: RunEvent[] = [
      { id: 1, chatId: 'c', type: 'tool', data: { result: { ok: true, output: 'internal success' } }, createdAt: '' },
      { id: 2, chatId: 'c', type: 'tool', data: { result: { ok: false, output: 'Stale file version' } }, createdAt: '' },
      { id: 3, chatId: 'c', type: 'error', data: { message: 'Provider unavailable' }, createdAt: '' },
      { id: 4, chatId: 'c', type: 'tool_output', data: { output: 'trace' }, createdAt: '' },
    ];
    expect(conversationErrors(events)).toEqual([{ id: 2, message: 'Stale file version' }, { id: 3, message: 'Provider unavailable' }]);
  });
  it('deduplicates durable system/tool failures while retaining event-only errors in both views', () => {
    const messages: Message[] = [
      { id: 'system', chatId: 'c', role: 'system', content: 'Provider failed', createdAt: '' },
      { id: 'tool', chatId: 'c', role: 'tool', content: 'Runner failed: ', metadata: { ok: false, agentId: 'coder-1', name: 'run_tests' }, createdAt: '' },
    ];
    const events: RunEvent[] = [
      { id: 1, chatId: 'c', type: 'error', data: { message: 'Provider failed' }, createdAt: '' },
      { id: 2, chatId: 'c', type: 'tool', data: { agentId: 'coder-1', action: { name: 'run_tests' }, result: { ok: false, output: 'Runner failed: truncated long output' } }, createdAt: '' },
      { id: 3, chatId: 'c', type: 'tool', data: { agentId: 'coder-2', action: { name: 'run_tests' }, result: { ok: false, output: 'Runner failed: other attempt' } }, createdAt: '' },
      { id: 4, chatId: 'c', type: 'error', data: { message: 'Event-only failure' }, createdAt: '' },
    ];
    for (const debug of [false, true]) {
      const visible = visibleMessages(messages, debug);
      expect(visible).toHaveLength(2);
      expect(conversationErrors(events, visible)).toEqual([{ id: 3, message: 'Runner failed: other attempt' }, { id: 4, message: 'Event-only failure' }]);
    }
  });
  it('hides internal Activity without Debug, retains tests and failure indicators, and keeps approval actions usable', () => {
    const report = { id: 't', runner: 'pytest', command: 'pytest', status: 'failed' as const, output: 'Failure evidence', createdAt: '', tests: [{ name: 'failing test', status: 'failed' as const, error: 'AssertionError' }] };
    const normal = renderToStaticMarkup(createElement(ActivityDrawer, { events: [], tests: [report] }));
    expect(normal).not.toContain('Activity'); expect(normal).toContain('Tests'); expect(normal).toContain('Review results');
    const debug = renderToStaticMarkup(createElement(ActivityDrawer, { debug: true, events: [], tests: [] }));
    expect(debug).toContain('Activity');
    const evidence = renderToStaticMarkup(createElement(TestRun, { report }));
    expect(evidence).toContain('AssertionError');
    const approval = renderToStaticMarkup(createElement(ApprovalCard, { approval: { id: 'p', chatId: 'c', agentId: 'coder', createdAt: '', status: 'pending', action: { name: 'write_file', args: { path: 'f', content: 'new', baseHash: 'version' } }, inspection: { effect: 'write', risk: 'routine', description: 'Change file', diff: '-old\n+new' } }, refresh: async () => {} }));
    expect(approval).toContain('Approve'); expect(approval).toContain('Deny'); expect(approval).toContain('version'); expect(approval).toContain('-old');
  });
  it('renders explicit per-role not-checked results with escaped diagnostic text', () => {
    const report: ConnectionReport = { ok: false, completedAt: '', checks: [{ target: 'catalog', status: 'failed', message: 'Catalog <error>' }, { target: 'coder', status: 'skipped', message: 'Reply test not sent.' }] };
    const html = renderToStaticMarkup(createElement(ConnectionResults, { report }));
    expect(html).toContain('did not all pass'); expect(html).toContain('not checked'); expect(html).toContain('&lt;error&gt;');
  });
  it('uses disjoint preference and current-chat mutation endpoints and surfaces rejected writes', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    await savePreferences({ defaultApprovalMode: 'review' });
    await saveChatApproval('chat/id', 'balanced');
    expect(fetcher.mock.calls.map(call => [call[0], call[1].method, JSON.parse(call[1].body)])).toEqual([
      ['/api/preferences', 'PATCH', { defaultApprovalMode: 'review' }],
      ['/api/chats/chat%2Fid', 'PATCH', { approvalMode: 'balanced' }],
    ]);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: 'Pause the chat first' }), { status: 409 }));
    await expect(saveChatApproval('c', 'review')).rejects.toMatchObject({ status: 409, message: 'Pause the chat first' });
  });
  it('passes cancellation and a bounded request signal to the probe without adding provider settings', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    await testConnection(controller.signal);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('/api/connection-check'); expect(options.method).toBe('POST'); expect(options.body).toBe('{}');
    expect(options.signal.aborted).toBe(false);
    controller.abort(); expect(options.signal.aborted).toBe(true);
  });
});
