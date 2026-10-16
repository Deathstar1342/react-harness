import path from 'node:path';
import { homedir } from 'node:os';
import { applicationHome, profilePaths } from './locations.js';
import type { AgentRole, ApprovalMode, PublicSettings } from '../shared/types.js';

export interface Config {
  executionMode?: 'direct'|'container';
  baseUrl: string; apiKey: string; streaming: boolean; host: string; port: number; dataDir: string; workspaceRoot: string;
  models: Record<AgentRole, string>; approvalMode: ApprovalMode; maxParallelCoders: number;
  promptFiles: Partial<Record<AgentRole,string>>;
  appHome?: string;
  limits: PublicSettings['limits']; contextLimits: Record<AgentRole, number>; maxOutputTokens: number;
}
export function normalizeProviderEndpoint(input:string):string {
  if(input.length>2048||input!==input.trim()||/[\x00-\x20\x7f\u2028\u2029\\?#]/.test(input))throw new Error('STARK_BASE_URL must be a bounded single-line URL without whitespace, query or fragment');
  if(!input)return '';
  const url=new URL(input);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('STARK_BASE_URL must be HTTP(S) without credentials, query or fragment');
  return input.replace(/\/+$/,'');
}
export function readConfig(env: NodeJS.ProcessEnv = process.env, baseDirectory = process.cwd()): Config {
  const positive = (key: string, fallback: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
    return value;
  };
  const baseUrl = normalizeProviderEndpoint(env.STARK_BASE_URL ?? '');
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('STARK_BASE_URL must be an HTTP(S) API URL without credentials, query, or fragment');
  }
  const mode = env.APPROVAL_MODE ?? 'balanced';
  if (!['autonomous', 'balanced', 'review'].includes(mode)) throw new Error('APPROVAL_MODE must be autonomous, balanced, or review');
  const host = env.HOST ?? '127.0.0.1';
  const executionMode=env.HARNESS_EXECUTION_MODE ?? 'direct';
  if(!['direct','container'].includes(executionMode))throw new Error('Unknown execution mode');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !(executionMode==='container' && host==='0.0.0.0')) throw new Error('This local application must bind to a loopback address');
  const promptFiles: Partial<Record<AgentRole,string>> = {};
  for(const role of ['architect','coder','critic'] as const) {
    const file = env[`${role.toUpperCase()}_PROMPT_FILE`]?.trim();
    if (!file) continue;
    if (file.length>4096 || file.includes('\0')) throw new Error(`${role.toUpperCase()}_PROMPT_FILE is invalid`);
    promptFiles[role] = path.resolve(baseDirectory,file);
  }
  return {
    executionMode:executionMode as 'direct'|'container',
    baseUrl, apiKey: env.STARK_API_KEY ?? '', streaming: env.MODEL_STREAMING !== 'false', host,
    port: positive('PORT', 3000), dataDir: path.resolve(baseDirectory,env.HARNESS_DATA_DIR ?? profilePaths(applicationHome(env)).dataDir),
    appHome: applicationHome(env),
    workspaceRoot: path.resolve(baseDirectory,env.HARNESS_WORKSPACE_ROOT || path.join(homedir(),'React Harness Projects')),
    models: { architect: env.ARCHITECT_MODEL ?? 'gemini-3.5-pro', coder: env.CODER_MODEL ?? 'gemini-3.5-flash-withtools', critic: env.CRITIC_MODEL ?? 'gemini-3.5-pro' },
    promptFiles,
    approvalMode: mode as ApprovalMode, maxParallelCoders: 1,
    limits: { requestsPerMinute: positive('REQUESTS_PER_MINUTE', 60), tokensPerMinute: positive('TOKENS_PER_MINUTE', 500000), tokensPerDay: positive('TOKENS_PER_DAY', 10000000) },
    contextLimits: { architect: positive('ARCHITECT_INPUT_TOKEN_LIMIT', 128000), coder: positive('CODER_INPUT_TOKEN_LIMIT', 128000), critic: positive('CRITIC_INPUT_TOKEN_LIMIT', 128000) },
    maxOutputTokens: positive('MODEL_MAX_OUTPUT_TOKENS', 16384),
  };
}
export function publicSettings(config: Config): PublicSettings {
  return { executionMode:config.executionMode ?? 'direct',executionAvailable:config.executionMode!=='container',limitSource:'application-budget',providerLimits:'unknown',configured: Boolean(config.baseUrl && config.apiKey), models: config.models, approvalMode: config.approvalMode, maxParallelCoders: config.maxParallelCoders, platform: process.platform, protocol: 'native-tools-v1', limits: config.limits, contextLimits: config.contextLimits };
}
