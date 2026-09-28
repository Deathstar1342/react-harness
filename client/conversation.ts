import type { Message, RunEvent } from '../shared/types';

export const visibleMessages = (messages: Message[], debug: boolean) => debug ? messages
  : messages.filter(message => ['user', 'architect', 'system'].includes(message.role) || message.role === 'tool' && message.metadata?.ok === false);

/** Failures remain visible even when their surrounding tool trace is hidden. */
export function conversationErrors(events: RunEvent[], messages: Message[] = []): { id: number; message: string }[] {
  return events.flatMap(event => {
    const data = event.data as { message?: unknown; agentId?: unknown; action?: { name?: unknown }; result?: { ok?: boolean; output?: unknown } } | null;
    if (event.type === 'error') {
      const text = typeof data?.message === 'string' ? data.message : 'The run failed.';
      if (messages.some(message => message.role === 'system' && message.content === text)) return [];
      return [{ id: event.id, message: text }];
    }
    if (event.type === 'tool' && data?.result?.ok === false) {
      const text = typeof data.result.output === 'string' ? data.result.output : 'A tool action failed.';
      // Runtime tool messages can be truncated. Their open failure card already
      // supplies the same evidence; caught inspection failures have no message.
      if (messages.some(message => message.role === 'tool' && message.metadata?.ok === false &&
        message.metadata.agentId === data.agentId && message.metadata.name === data.action?.name &&
        message.content.length > 0 && text.startsWith(message.content))) return [];
      return [{ id: event.id, message: text }];
    }
    return [];
  });
}
