import type {
  AgentRole,
  CompletionResult,
  ConnectionCheck,
  ConnectionReport,
  ModelMessage,
  ModelProvider,
} from '../shared/types.js';
import type { Config } from './config.js';
import type { RuntimeHooks } from './runtime.js';
import { validateNativeCalls } from './provider.js';
import { parseNativeJSON } from './native-json.js';
import { ProviderError } from './provider.js';
import { BudgetError } from './scheduler.js';

const roles: AgentRole[] = ['architect', 'coder', 'critic'];

export const CONNECTION_TIMEOUT_MS = 180_000;

// Never return provider/parser text: even error messages can contain response excerpts.
function failure(error: unknown): string {
  if (error instanceof BudgetError) {
    return 'Account request budget or capacity is unavailable. Try again later.';
  }

  if (error instanceof ProviderError) {
    if (error.code === 'http' && (error.status === 401 || error.status === 403)) {
      return 'Provider authentication failed. Check backend credentials.';
    }

    if (error.code === 'http' && error.status === 429) {
      return 'Provider rate limit reached. Try again later.';
    }

    if (error.code === 'refusal') {
      return 'Provider refused the test reply.';
    }

    if (error.code === 'timeout') {
      return 'Provider request timed out.';
    }

    if (error.code === 'truncated') {
      return 'Test reply was incomplete or reached the output limit.';
    }

    if (error.code === 'limit') {
      return 'Test reply exceeded the response size limit.';
    }

    if (error.code === 'malformed') {
      return 'Provider returned an invalid reply payload.';
    }
  }

  return 'Connection check failed. Check backend configuration and provider availability.';
}

async function bounded<T>(
  signal: AbortSignal,
  invoke: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();

  let abort!: () => void;

  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('Check cancelled'));
    signal.addEventListener('abort', abort, { once: true });
  });

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return invoke();
      }),
      cancelled,
    ]);

    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Probes have no chat, tools, project context, or executable action path. */
export class ConnectionDiagnostics {
  private active?: {
    controller: AbortController;
    done: Promise<ConnectionReport>;
  };

  private closing = false;

  constructor(
    private config: Config,
    private provider: ModelProvider,
    private complete: NonNullable<RuntimeHooks['complete']>,
    private timeoutMs = CONNECTION_TIMEOUT_MS,
  ) {}

  run(signal?: AbortSignal): Promise<ConnectionReport> {
    if (this.closing) {
      throw Object.assign(new Error('Backend is shutting down'), {
        statusCode: 503,
      });
    }

    if (this.active) {
      throw Object.assign(new Error('A connection check is already running'), {
        statusCode: 409,
      });
    }

    const controller = new AbortController();

    const abort = () => controller.abort();

    signal?.addEventListener('abort', abort, { once: true });

    if (signal?.aborted) {
      abort();
    }

    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, this.timeoutMs);

    const done = this.check(controller.signal, () => timedOut).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.active = undefined;
    });

    this.active = { controller, done };

    return done;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.active?.controller.abort();
    await this.active?.done;
  }

  private async check(
    signal: AbortSignal,
    timedOut: () => boolean,
  ): Promise<ConnectionReport> {
    // Keep role selection stable throughout a check. Credentials are captured by
    // each provider request, so rotation applies to the next individual request.
    const modelsByRole = {...this.config.models};
    const checks: ConnectionCheck[] = [];

    const failed = (target: ConnectionCheck['target'], error: unknown) =>
      checks.push({
        target,
        status: 'failed',
        message: signal.aborted
          ? timedOut()
            ? `Connection check timed out after ${Math.ceil(this.timeoutMs / 1000)} seconds.`
            : 'Connection check cancelled.'
          : failure(error),
      });

    let models: string[] | undefined;

    if (!this.config.baseUrl || !this.config.apiKey) {
      checks.push({
        target: 'catalog',
        status: 'failed',
        message:
          'Set the provider URL on the backend and restart for URL changes. Add the API key in Settings.',
      });
    } else {
      try {
        models = await bounded(signal, () => this.provider.models(signal));

        checks.push({
          target: 'catalog',
          status: 'passed',
          message: 'Model catalog is reachable.',
        });
      } catch (error) {
        failed('catalog', error);
      }
    }

    for (const role of roles) {
      for (const evidence of ['ordinary','native','streaming'] as const) {
        if (signal.aborted || !this.config.baseUrl || !this.config.apiKey) {
          checks.push({target:role,evidence,model:modelsByRole[role],status:'skipped',message:'Probe not sent because configuration is missing or the check stopped.'});
          continue;
        }
        try {
          const streaming = evidence === 'streaming';
          const messages:ModelMessage[]=[{role:'system',content:'Harmless connection diagnostic. No workspace, files, shell or packages are available.'},{role:'user',content:evidence==='ordinary'?'Reply exactly Connection OK.':'Call connection_echo exactly once with value Connection OK. After receiving its result, reply exactly Connection OK.'}];
          const tools = evidence==='ordinary'?undefined:[{type:'function' as const,function:{name:'connection_echo',description:'Echo a harmless in-memory diagnostic value. No external effects.',parameters:{type:'object',properties:{value:{type:'string',const:'Connection OK'}},required:['value'],additionalProperties:false}}}];
          const request=(history:ModelMessage[],useTools=true)=>bounded(signal,()=>this.complete(role,{model:modelsByRole[role],messages:history,tools:useTools?tools:undefined,toolChoice:tools&&useTools?'required':undefined,streaming,signal,maxTokens:Math.min(1024,this.config.maxOutputTokens),noRetry:true}));
          let result=await request(messages);
          if(evidence!=='ordinary') {
            const calls=validateNativeCalls(result.toolCalls);
            if(result.finishReason!=='tool_calls'||result.text.length>2048||calls.length!==1||calls[0].function.name!=='connection_echo')throw new Error();
            const args=parseNativeJSON(calls[0].function.arguments,2048) as Record<string,unknown>;
            if(!args||Object.keys(args).length!==1||args.value!=='Connection OK')throw new Error();
            result=await request([...messages,{role:'assistant',content:result.text,tool_calls:calls},{role:'tool',tool_call_id:calls[0].id,content:JSON.stringify({value:args.value})}],false);
          }
          if(result.finishReason!=='stop'||result.toolCalls?.length||result.text.length>2048||result.text.trim()!=='Connection OK')throw new Error();
          checks.push({target:role,evidence,model:modelsByRole[role],status:'passed',message:`${evidence} probe passed${models?.includes(modelsByRole[role])?'':'; configured ID was not confirmed in the catalog'}.`,...(result.requestId?{requestId:result.requestId}:{})});
        } catch(error) {
          failed(role,error);
          Object.assign(checks.at(-1)!,{evidence,model:modelsByRole[role]});
        }
      }
    }
    return {ok:checks.every(check=>check.status==='passed'),checks,completedAt:new Date().toISOString()};
  }
}
