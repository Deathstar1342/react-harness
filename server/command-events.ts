import type { Action, AgentRole, CommandEvent, ToolResult } from '../shared/types.js';

export const isCommand = (action: Action) => ['run_shell', 'execute_python', 'run_tests'].includes(action.name);
export const commandOutputLimit = 64_000;
export function commandEvent(frame: {id:string; shellId?:string; role:AgentRole}, pending: {id:string; action:Action}, result?: ToolResult): CommandEvent {
  const base = {commandId:pending.id,agentId:frame.id,sessionId:frame.shellId ?? frame.id,role:frame.role,action:pending.action};
  if (!result) return {...base,status:'running'};
  const data = (result.data && typeof result.data === 'object' ? result.data : {}) as Record<string, unknown>;
  const cancelled = data.cancelled === true, timedOut = data.timedOut === true, shellReset = data.shellReset === true;
  // Shell-process exit before the command boundary is not a command exit code.
  const uncertain = data.uncertain === true || (shellReset && typeof data.error === 'string' && !cancelled && !timedOut);
  const exitCode = !uncertain && Number.isInteger(data.exitCode) ? data.exitCode as number : undefined;
  const output = typeof data.output === 'string' ? data.output : '';
  return {...base, status: uncertain ? 'uncertain' : cancelled || timedOut ? 'interrupted' : exitCode === undefined ? 'uncertain' : exitCode === 0 ? 'completed' : 'failed',
    exitCode, cancelled, timedOut, shellReset, output:typeof data.output !== 'string' ? undefined : output.slice(-commandOutputLimit),
    truncated:data.truncated === true || output.length > commandOutputLimit,
    message:typeof data.error === 'string' ? data.error.slice(-16000) : !result.ok ? `Tool reported a problem: ${result.output.slice(-16000)}` : exitCode === undefined ? 'No command exit evidence was recorded.' : undefined};
}
