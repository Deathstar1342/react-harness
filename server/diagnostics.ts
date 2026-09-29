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
import { parseAgentResponse } from './protocol.js';
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

function diagnosticMessages(): ModelMessage[] {
  return [
    {
      role: 'system',
      content:
        'This is a connection diagnostic, not a task. Return exactly one JSON object: ' +
        '{"version":1,"type":"final","message":"Connection OK"}. ' +
        'Do not request actions or include any other text.',
    },
    {
      role: 'user',
      content: 'Return the specified connection diagnostic reply.',
    },
  ];
}

function validDiagnosticReply(text: string): boolean {
  try {
    const reply = parseAgentResponse(text);

    return (
      reply.type === 'final' &&
      reply.message === 'Connection OK' &&
      !reply.action
    );
  } catch {
    return false;
  }
}

function unusableDiagnosticReply(result: CompletionResult): boolean {
  return (
    result.text.length > 2048 ||
    (result.finishReason !== undefined && result.finishReason !== 'stop')
  );
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
          'Configure the provider URL and API key on the backend, then restart it.',
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
      if (!models || signal.aborted) {
        checks.push({
          target: role,
          status: 'skipped',
          message:
            'Reply test was not sent because the catalog failed or the check stopped.',
        });
        continue;
      }

      if (
        !this.config.models[role] ||
        !models.includes(this.config.models[role])
      ) {
        checks.push({
          target: role,
          status: 'failed',
          message: 'The exact configured model ID is missing from the catalog.',
        });
        continue;
      }

      try {
        const request = (messages: ModelMessage[]) =>
          bounded(signal, () =>
            this.complete(role, {
              model: this.config.models[role],
              signal,
              maxTokens: Math.min(1024, this.config.maxOutputTokens),
              messages,
            }),
          );

        const initialMessages = diagnosticMessages();

        let result = await request(initialMessages);

        if (unusableDiagnosticReply(result)) {
          checks.push({
            target: role,
            status: 'failed',
            message: 'Test reply was incomplete or exceeded its size limit.',
          });
          continue;
        }

        let valid = validDiagnosticReply(result.text);

        // Match Runtime's one-time strict JSON formatting recovery.
        if (!valid) {
          result = await request([
            ...initialMessages,
            {
              role: 'assistant',
              content: result.text.slice(0, 64_000),
            },
            {
              role: 'user',
              content:
                'FORMAT REPAIR: Your immediately preceding response did not match the required JSON protocol. ' +
                'Return exactly this JSON object and nothing else: ' +
                '{"version":1,"type":"final","message":"Connection OK"}',
            },
          ]);

          if (unusableDiagnosticReply(result)) {
            checks.push({
              target: role,
              status: 'failed',
              message: 'Test reply was incomplete or exceeded its size limit.',
            });
            continue;
          }

          valid = validDiagnosticReply(result.text);
        }

        checks.push({
          target: role,
          status: valid ? 'passed' : 'failed',
          message: valid
            ? 'Configured model returned a valid test reply.'
            : 'Model did not return the required test reply. No action was executed.',
        });
      } catch (error) {
        failed(role, error);
      }
    }

    return {
      ok: checks.every(check => check.status === 'passed'),
      checks,
      completedAt: new Date().toISOString(),
    };
  }
}