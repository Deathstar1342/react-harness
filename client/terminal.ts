import type { CommandEvent, RunEvent } from '../shared/types';

const LIMIT = 64_000;
export interface TerminalCommand {
  commandId: string; agentId: string; sessionId: string; firstEventId: number;
  lifecycle?: CommandEvent; output: string; outputTruncated: boolean;
  hasStart: boolean; hasSnapshot: boolean;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string,unknown> : {};
const commandNames = new Set(['run_shell', 'execute_python', 'run_tests']);
function lifecycle(value: Record<string,unknown>): value is unknown & CommandEvent & Record<string,unknown> {
  return typeof value.commandId === 'string' && typeof value.agentId === 'string' && typeof value.sessionId === 'string'
    && ['architect','coder','critic'].includes(String(value.role))
    && ['running','completed','failed','interrupted','uncertain'].includes(String(value.status))
    && commandNames.has(String(object(value.action).name)) && !!object(value.action).args;
}
export function terminalHistory(events: RunEvent[], chatId: string) {
  const commands = new Map<string,TerminalCommand>();
  const unassociated: RunEvent[] = [];
  const seen = new Set<number>();
  for (const event of [...events].sort((a,b)=>a.id-b.id)) {
    if (event.chatId !== chatId || seen.has(event.id)) continue;
    seen.add(event.id);
    const data = object(event.data);
    const isLifecycle = event.type === 'command' && lifecycle(data);
    const isOutput = event.type === 'tool_output' && typeof data.output === 'string';
    if (!isLifecycle && !isOutput) {
      if (event.type === 'tool' && commandNames.has(String(object(data.action).name)) && !data.commandId) unassociated.push(event);
      continue;
    }
    if (typeof data.commandId !== 'string' || typeof data.agentId !== 'string' || typeof data.sessionId !== 'string') { unassociated.push(event); continue; }
    let entry = commands.get(data.commandId);
    if (entry && (entry.agentId !== data.agentId || entry.sessionId !== data.sessionId)) { unassociated.push(event); continue; }
    if (!entry) {
      entry = {commandId:data.commandId,agentId:data.agentId,sessionId:data.sessionId,firstEventId:event.id,output:'',outputTruncated:false,hasStart:false,hasSnapshot:false};
      commands.set(entry.commandId,entry);
    }
    if (isLifecycle && lifecycle(data)) {
      // A replayed start cannot undo a recorded terminal outcome.
      if (entry.lifecycle && entry.lifecycle.status !== 'running' && data.status === 'running') continue;
      entry.lifecycle = data;
      entry.hasStart ||= data.status === 'running';
      if (typeof data.output === 'string') {
        entry.output = data.output.slice(-LIMIT); entry.hasSnapshot = true;
        entry.outputTruncated = data.truncated === true || data.output.length > LIMIT;
      }
    } else if (!entry.hasSnapshot) {
      const next = entry.output + data.output;
      entry.output = next.slice(-LIMIT);
      entry.outputTruncated ||= data.truncated === true || next.length > LIMIT;
    }
  }
  return {commands:[...commands.values()],unassociated};
}

export function commandLabel(entry: TerminalCommand): string {
  const item = entry.lifecycle;
  if (!item) return 'Unknown outcome';
  if (item.status === 'completed' && item.exitCode !== 0) return 'Unknown outcome';
  return {running:'Running (last recorded)',completed:'Completed',failed:'Failed',interrupted:'Interrupted',uncertain:'Uncertain'}[item.status];
}

// Console output is plain text, never executable HTML or a terminal emulator.
export function consoleText(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');
}
