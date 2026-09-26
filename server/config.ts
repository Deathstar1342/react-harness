import path from 'node:path';
import { homedir } from 'node:os';
import type { AgentRole, ApprovalMode, PublicSettings } from '../shared/types.js';

export interface Config {
  baseUrl: string; apiKey: string; streaming: boolean; host: string; port: number; dataDir: string; workspaceRoot: string;
  models: Record<AgentRole, string>; approvalMode: ApprovalMode; maxParallelCoders: number;
  promptFiles: Partial<Record<AgentRole,string>>;
  limits: PublicSettings['limits']; contextLimits: Record<AgentRole, number>; maxOutputTokens: number;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const positive = (key: string, fallback: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
    return value;
  };
  const baseUrl = (env.STARK_BASE_URL ?? '').replace(/\/+$/, '');
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('STARK_BASE_URL must be an HTTP(S) API URL without credentials, query, or fragment');
  }
  const mode = env.APPROVAL_MODE ?? 'balanced';
  if (!['autonomous', 'balanced', 'review'].includes(mode)) throw new Error('APPROVAL_MODE must be autonomous, balanced, or review');
  const host = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('This local application must bind to a loopback address');
  const promptFiles: Partial<Record<AgentRole,string>> = {};
  for(const role of ['architect','coder','critic'] as const) {
    const file = env[`${role.toUpperCase()}_PROMPT_FILE`]?.trim();
    if (!file) continue;
    if (file.length>4096 || file.includes('\0')) throw new Error(`${role.toUpperCase()}_PROMPT_FILE is invalid`);
    promptFiles[role] = path.resolve(file);
  }
  return {
    baseUrl, apiKey: env.STARK_API_KEY ?? '', streaming: env.MODEL_STREAMING !== 'false', host,
    port: positive('PORT', 3000), dataDir: path.resolve(env.HARNESS_DATA_DIR ?? '.harness'),
    workspaceRoot: path.resolve(env.HARNESS_WORKSPACE_ROOT || path.join(homedir(),'React Harness Projects')),
    models: { architect: env.ARCHITECT_MODEL ?? 'gemini-3.1-pro-preview', coder: env.CODER_MODEL ?? 'gemini-3.8-flash', critic: env.CRITIC_MODEL ?? 'gemini-3.6-flash' },
    promptFiles,
    approvalMode: mode as ApprovalMode, maxParallelCoders: 1,
    limits: { requestsPerMinute: positive('REQUESTS_PER_MINUTE', 120), tokensPerMinute: positive('TOKENS_PER_MINUTE', 1500000), tokensPerDay: positive('TOKENS_PER_DAY', 150000000) },
    contextLimits: { architect: positive('ARCHITECT_INPUT_TOKEN_LIMIT', 1048576), coder: positive('CODER_INPUT_TOKEN_LIMIT', 1048576), critic: positive('CRITIC_INPUT_TOKEN_LIMIT', 1048576) },
    maxOutputTokens: positive('MODEL_MAX_OUTPUT_TOKENS', 16384),
  };
}
export function publicSettings(config: Config): PublicSettings {
  return { configured: Boolean(config.baseUrl && config.apiKey), models: config.models, approvalMode: config.approvalMode, maxParallelCoders: config.maxParallelCoders, platform: process.platform, protocol: 'json', limits: config.limits, contextLimits: config.contextLimits };
}
