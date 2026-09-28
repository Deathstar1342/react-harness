import type { Config } from './config.js';
import type { RuntimeHooks } from './runtime.js';
import type { AgentRole, ConnectionReport, ModelProvider } from '../shared/types.js';

export async function checkConnection(config: Config, provider: ModelProvider, hooks: RuntimeHooks, signal: AbortSignal): Promise<ConnectionReport> {
  const checks: ConnectionReport['checks'] = [];
  if (!config.baseUrl || !config.apiKey) return {ok:false,checks:[{name:'Configuration',ok:false,detail:'Set STARK_BASE_URL and STARK_API_KEY in .env, then restart.'}]};
  const safeError = (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Connection check failed';
    // Provider errors are already sanitized; never return raw model replies or URLs here.
    return message.replaceAll(config.apiKey,'[redacted]').replaceAll(config.baseUrl,'[provider]').slice(0,500);
  };
  let catalog: string[];
  try { catalog = await provider.models(signal); checks.push({name:'Connection',ok:true,detail:'Model catalog is reachable.'}); }
  catch (error) { return {ok:false,checks:[{name:'Connection',ok:false,detail:safeError(error)}]}; }
  for (const role of ['architect','coder','critic'] as AgentRole[]) {
    if (!catalog.includes(config.models[role])) { checks.push({name:role,ok:false,detail:'The configured model is missing from the provider catalog.'}); continue; }
    try {
      const input = {model:config.models[role],signal,maxTokens:Math.min(config.maxOutputTokens,1024),messages:[
        {role:'system' as const,content:hooks.instructions(role)},
        {role:'user' as const,content:'Connection check only. Return exactly this JSON object: {"version":1,"type":"final","message":"Connection check passed"}. No actions are needed.'},
      ]};
      const result = hooks.complete ? await hooks.complete(role,input) : await provider.complete(input);
      const parsed = hooks.parse(result.text);
      if (parsed.type!=='final' || parsed.action) throw new Error('The model did not return the expected connection-check reply.');
      checks.push({name:role,ok:true,detail:'Model replied successfully in the required format.'});
    } catch (error) {
      checks.push({name:role,ok:false,detail: error instanceof Error && /JSON|schema|response|parse|Unexpected token/i.test(error.message) ? 'The model reply could not be understood. Check model compatibility or enable debug mode for normal task investigation.' : safeError(error)});
    }
    if (signal.aborted) break;
  }
  return {ok:checks.length===4 && checks.every(check=>check.ok),checks};
}
