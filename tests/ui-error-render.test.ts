import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDetail, Project } from '../shared/types.js';
import { useConversation } from '../client/useConversation.js';
import { Conversation } from '../client/App.js';

vi.mock('../client/useConversation.js', () => ({ useConversation: vi.fn() }));
const project: Project = { id: 'p', name: 'Project', path: '/workspace', createdAt: '' };
let detail: ChatDetail;
function render(debug = false, error = '') {
  vi.mocked(useConversation).mockReturnValue({ detail, error, stream: '', connection: 'connected', fileRevision: 0, refresh: async () => {} });
  return renderToStaticMarkup(createElement(Conversation, {
    chatId: 'c', project, configured: true, debug, onChange() {}, onInspectFile(){},onFiles() {}, onChanges() {}, onFileRevision() {}, onSkillsDirty() {}, draft: '', setDraft() {},
  }));
}
beforeEach(() => {
  detail = {
    chat: { id: 'c', projectId: 'p', title: 'Chat', status: 'idle', approvalMode: 'review', createdAt: '', updatedAt: '' },
    messages: [
      { id: 'u1', chatId: 'c', role: 'user', content: 'Old turn', createdAt: '2026-10-13T00:00:00Z' },
      { id: 'u2', chatId: 'c', role: 'user', content: 'New turn', createdAt: '2026-10-13T00:02:00Z' },
    ],
    events: [{ id: 2, chatId: 'c', type: 'tool', data: { result: { ok: false, output: 'Historical failure <text>' } }, createdAt: '2026-10-13T00:01:00Z' }],
    approvals: [], plan: { phases: [] }, tests: [],
  };
});

describe('rendered conversation error boundaries', () => {
  it.each([false, true])('keeps historical failures before later turns and outside the composer, debug=%s', debug => {
    const html = render(debug);
    expect(html.indexOf('Old turn')).toBeLessThan(html.indexOf('Historical failure'));
    expect(html.indexOf('Historical failure')).toBeLessThan(html.indexOf('New turn'));
    expect(html).toContain('Historical failure &lt;text&gt;');
    const composer = html.split('class="composer-region"')[1];
    expect(composer).not.toContain('Historical failure');
    expect(composer).not.toContain('Retry connection');
    expect(html).not.toContain('The run stopped with an error');
  });
  it('retains a current connection blocker, active approval and uncertain action without hiding report problems', () => {
    detail.chat.status = 'awaiting_approval';
    detail.messages.push({ id: 'tool', chatId: 'c', role: 'tool', content: 'Inspect workspace before retrying', createdAt: '', metadata: { ok: false, commandStatus: 'uncertain' } });
    detail.approvals.push({ id: 'approval', chatId: 'c', agentId: 'coder', action: { name: 'write_file', args: { path: 'a', content: 'new', baseHash: null } }, inspection: { effect: 'write', risk: 'routine', description: 'Pending file change', diff: '+new' }, status: 'pending', createdAt: '' });
    let html = render(false, 'Cannot refresh current chat');
    expect(html).toContain('Command outcome uncertain');
    expect(html).toContain('Inspect workspace before retrying');
    expect(html).toContain('Approve'); expect(html).toContain('Deny');
    expect(html.split('class="composer-region"')[1]).toContain('Cannot refresh current chat');
    expect(html.split('class="composer-region"')[1]).toContain('Retry connection');
    html = render();
    expect(html).not.toContain('Cannot refresh current chat');
    expect(html).toContain('Approve'); expect(html).toContain('Command outcome uncertain');
    detail.messages[2].metadata = { ok: false, commandStatus: 'completed', exitCode: 0 };
    detail.messages[2].content = 'Fresh report unavailable';
    html = render();
    expect(html).toContain('Command exited 0; tool or report problem');
    expect(html).toContain('Fresh report unavailable');
    expect(html).not.toContain('Tool action failed');
  });
  it('shows a current stopped-run notice only while status is error, without deleting its historical evidence', () => {
    detail.chat.status = 'error';
    expect(render()).toContain('The run stopped with an error');
    detail.chat.status = 'running';
    const html = render();
    expect(html).not.toContain('The run stopped with an error');
    expect(html).toContain('Historical failure');
    expect(html).toContain('Work is in progress');
  });
});
