import { randomUUID } from 'node:crypto';
import type { Action, CompletionResult } from '../shared/types.js';

export function nativeReply(name:string,args:Record<string,unknown>={},text=''): CompletionResult {
  return {text,finishReason:'tool_calls',toolCalls:[{id:`call_${randomUUID()}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]};
}
export function actionOf(reply:CompletionResult): Action {
  const call=reply.toolCalls![0];
  return {name:call.function.name,args:JSON.parse(call.function.arguments)};
}

/** Construct a durable native dispatch fixture with its original assistant call. */
export function nativeState<T>(state:T): T {
  for(const frame of (state as {frames?:any[]}).frames ?? []) {
    if(!frame.pending?.action || frame.pending.callId)continue;
    const call=nativeReply(frame.pending.action.name,frame.pending.action.args).toolCalls![0];
    frame.pending.callId=call.id;
    frame.messages.push({role:'assistant',content:'',tool_calls:[call]});
    frame.queuedCalls=[call];
  }
  return state;
}

export function diagnosticReply(input:{tools?:unknown[]}): CompletionResult {
  return {...(input.tools?.length ? nativeReply('connection_echo',{value:'Connection OK'}) : {text:'Connection OK',finishReason:'stop'}),usage:{inputTokens:15,outputTokens:10}};
}
