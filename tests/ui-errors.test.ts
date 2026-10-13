import { describe, expect, it } from 'vitest';
import { conversationEntries, conversationErrors, toolMessageLabel } from '../client/conversation.js';
import type { Message, RunEvent } from '../shared/types.js';

const message = (id: string, role: Message['role'], createdAt = '2026-10-13T00:00:00Z'): Message => ({ id, chatId: 'c', role, content: 'Identical failure', createdAt });
const event = (id: number, data: unknown, type = 'error', createdAt = '2026-10-13T00:00:00Z'): RunEvent => ({ id, chatId: 'c', type, data, createdAt });
const entryIds = (messages: Message[], events: RunEvent[], debug = false) => conversationEntries(messages, events, debug).map(entry => entry.kind === 'message' ? entry.message.id : entry.id);

describe('historical error placement and exact identity', () => {
  it('keeps identical failures on their own turns and deduplicates replayed events', () => {
    const messages = [message('turn-1', 'user'), message('turn-2', 'user'), message('reply-2', 'architect')];
    const events = [event(1, messages[0], 'message'), event(2, { message: 'Identical failure' }), event(3, messages[1], 'message'), event(4, { message: 'Identical failure' }), event(5, messages[2], 'message')];
    for (const debug of [false, true]) {
      expect(entryIds(messages, events, debug)).toEqual(['turn-1', 2, 'turn-2', 4, 'reply-2']);
      expect(entryIds(messages, [...events, events[1], events[3]], debug)).toEqual(['turn-1', 2, 'turn-2', 4, 'reply-2']);
    }
  });
  it('uses linked message identity without suppressing a distinct identical failure or legacy duplicate', () => {
    const messages = [message('failure-1', 'system')];
    const events = [event(1, { message: 'Identical failure', messageId: 'failure-1' }), event(2, { message: 'Identical failure', messageId: 'failure-2' }), event(3, { message: 'Identical failure' })];
    expect(conversationErrors(events, messages).map(failure => failure.id)).toEqual([2, 3]);
    expect(conversationErrors(events, []).map(failure => failure.id)).toEqual([1, 2, 3]);
    expect(conversationErrors(events, [{ ...messages[0], chatId: 'other' }]).map(failure => failure.id)).toEqual([1, 2, 3]);
  });
  it('retains missing-message and hidden-message errors when history is incomplete', () => {
    const messages = [message('older', 'user', '2026-10-12T00:00:00Z'), message('internal', 'coder'), message('new-turn', 'user', '2026-10-13T00:01:00Z')];
    const events = [event(70, { message: 'Identical failure', messageId: 'missing' }), event(71, messages[1], 'message'), event(72, { message: 'Identical failure', messageId: 'internal' })];
    expect(entryIds(messages, events)).toEqual(['older', 70, 72, 'new-turn']);
    expect(entryIds(messages, events, true)).toEqual(['older', 70, 'internal', 'new-turn']);
    expect(entryIds([], events)).toEqual([70, 72]);
  });
  it('keeps durable failed tool messages after the linked event leaves recent history', () => {
    const failure = { ...message('failed-tool', 'tool'), metadata: { ok: false, commandStatus: 'uncertain' } };
    expect(entryIds([failure, message('later-turn', 'user')], [])).toEqual(['failed-tool', 'later-turn']);
    expect(toolMessageLabel(failure)).toBe('Command outcome uncertain');
    expect(entryIds([{ ...failure, metadata: { ok: true, commandStatus: 'uncertain' } }], [])).toEqual(['failed-tool']);
  });
  it('does not infer command success from legacy text or tool ok', () => {
    expect(toolMessageLabel({ ...message('legacy', 'tool'), content: 'Command succeeded!', metadata: { ok: false } })).toBe('Tool reported a problem');
    expect(toolMessageLabel({ ...message('legacy', 'tool'), metadata: { ok: true } })).toBe('Tool result');
    expect(toolMessageLabel({ ...message('bad-status', 'tool'), metadata: { ok: false, commandStatus: 'completed' } })).toBe('Tool reported a problem');
  });
});
