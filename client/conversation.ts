import type { Message, RunEvent } from '../shared/types';

export const isToolProblem = (message: Message) => message.role === 'tool' && (message.metadata?.ok === false ||
  ['uncertain', 'interrupted', 'failed'].includes(String(message.metadata?.commandStatus)));

export const visibleMessages = (messages: Message[], debug: boolean) => debug ? messages
  : messages.filter(message => ['user', 'architect', 'system'].includes(message.role) || isToolProblem(message));

/** Deduplicate only exact durable identities. Legacy unlinked evidence stays visible. */
export function conversationErrors(events: RunEvent[], messages: Message[] = []): { id: number; message: string }[] {
  const seen = new Set<number>();
  return events.flatMap(event => {
    if (seen.has(event.id)) return [];
    seen.add(event.id);
    const data = event.data as { messageId?: unknown; message?: unknown; result?: { ok?: boolean; output?: unknown } } | null;
    if (typeof data?.messageId === 'string' && messages.some(message => message.chatId === event.chatId && message.id === data.messageId)) return [];
    if (event.type === 'error') {
      const text = typeof data?.message === 'string' ? data.message : 'The run failed.';
      return [{ id: event.id, message: text }];
    }
    if (event.type === 'tool' && data?.result?.ok === false) {
      const text = typeof data.result.output === 'string' ? data.result.output : 'A tool action failed.';
      return [{ id: event.id, message: text }];
    }
    return [];
  });
}

export type ConversationEntry = { kind: 'message'; message: Message } | { kind: 'failure'; id: number; message: string; createdAt: string };

/** Place event-only legacy failures at their recorded point in the transcript. */
export function conversationEntries(messages: Message[], events: RunEvent[], debug: boolean): ConversationEntry[] {
  const visible = new Set(visibleMessages(messages, debug).map(message => message.id));
  const messageEvents = new Map<string, number>();
  for (const event of events) {
    const data = event.data as { id?: unknown } | null;
    if (event.type === 'message' && typeof data?.id === 'string') messageEvents.set(data.id, event.id);
  }
  const buckets = new Map<number, Extract<ConversationEntry, { kind: 'failure' }>[]>();
  for (const failure of conversationErrors(events, messages.filter(message => visible.has(message.id)))) {
    const event = events.find(item => item.id === failure.id)!;
    // Event order handles identical timestamps; timestamps place older messages
    // whose message events have fallen outside the bounded event window.
    const next = messages.findIndex(message => {
      const eventId = messageEvents.get(message.id);
      return eventId !== undefined ? eventId > event.id : message.createdAt > event.createdAt;
    });
    const index = next < 0 ? messages.length : next;
    const bucket = buckets.get(index) ?? [];
    bucket.push({ kind: 'failure', ...failure, createdAt: event.createdAt });
    buckets.set(index, bucket);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.id - b.id);
  return messages.flatMap((message, index): ConversationEntry[] => [
    ...(buckets.get(index) ?? []),
    ...(visible.has(message.id) ? [{ kind: 'message' as const, message }] : []),
  ]).concat(buckets.get(messages.length) ?? []);
}

export function toolMessageLabel(message: Message): string {
  const metadata = message.metadata;
  if (metadata?.commandStatus === 'uncertain') return 'Command outcome uncertain';
  if (metadata?.commandStatus === 'interrupted') return 'Command interrupted';
  if (metadata?.commandStatus === 'completed' && metadata.exitCode === 0) {
    return metadata.ok === false ? 'Command exited 0; tool or report problem' : 'Command completed (exit 0)';
  }
  if (metadata?.commandStatus === 'failed' && typeof metadata.exitCode === 'number') return `Command failed (exit ${metadata.exitCode})`;
  if (metadata?.rejected) return 'Action rejected before execution';
  return metadata?.ok === false ? 'Tool reported a problem' : 'Tool result';
}
