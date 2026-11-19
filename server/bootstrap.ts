import path from 'node:path';
import { realpathSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { readConfig } from './config.js';
import { ProviderSettingsFile, validateDotenvOverrides } from './provider-settings.js';
import { createApp } from './app.js';
import { ReloadingProvider } from './provider.js';
import { createManagedHooks } from './context.js';
import { Store } from './store.js';
import { WorkspaceTools } from './tools/index.js';
import { loadPromptExtensions } from './prompts.js';
import { checkoutDatabase, durableWrite, importLegacyState, markCheckoutState, privateDirectory, StateOwnership } from './local-state.js';
import { BackendLifecycle } from './lifecycle.js';
import { TransportAuth } from './transport-auth.js';
import { applicationHome, installationRoot } from './locations.js';
import { ensureWebBuild } from './web-build.js';

interface BackendOptions {
  env?: NodeJS.ProcessEnv;
  installRoot?: string;
  web?: boolean;
  buildWeb?: boolean;
}

export async function startBackend(options: BackendOptions = {}) {
  const env = options.env ?? process.env;
  const repository = realpathSync(options.installRoot ?? installationRoot);
  const home = applicationHome(repository);
  const staticRoot = path.join(repository, 'dist', 'client');
  const web = options.web ?? true;
  validateDotenvOverrides(env);
  const file = new ProviderSettingsFile(path.join(repository, '.env'), env);
  const settings = file.values();
  const { HARNESS_HOME, HARNESS_DATA_DIR, ...runtimeEnv } = settings;
  if (runtimeEnv.HARNESS_EXECUTION_MODE !== undefined && runtimeEnv.HARNESS_EXECUTION_MODE !== 'direct') {
    throw new Error('Remove the unsupported HARNESS_EXECUTION_MODE override and run npm start');
  }
  for (const name of ['HARNESS_WORKSPACE_ROOT','ARCHITECT_PROMPT_FILE','CODER_PROMPT_FILE','CRITIC_PROMPT_FILE']) {
    if (env[name]) runtimeEnv[name] = path.resolve(env[name]!);
  }
  const config = readConfig(runtimeEnv, repository);
  if (config.port > 65535) throw new Error('PORT must be at most 65535');
  await importLegacyState(repository, home, env, {HARNESS_HOME, HARNESS_DATA_DIR});
  privateDirectory(home);
  const ownership = new StateOwnership(home);

  let store: Store | undefined;
  let app: Awaited<ReturnType<typeof createApp>>['app'] | undefined;
  const tools = new WorkspaceTools();
  const descriptor = path.join(home, 'backend.json');
  let lifecycle: BackendLifecycle | undefined;
  let published = false;
  const close = async () => {
    // Failed drains retain ownership until process exit.
    if (app) await app.close();
    else await tools.dispose();
    store?.close();
    if (published && lifecycle) {
      const stopped = {version:1, instanceId:lifecycle.instanceId, state:'stopped'};
      durableWrite(descriptor, JSON.stringify({...stopped, mac:createHmac('sha256', lifecycle.key).update(JSON.stringify(stopped)).digest('hex')}));
    }
    ownership.close();
  };
  try {
    const database = checkoutDatabase(home);
    lifecycle = new BackendLifecycle(env.HARNESS_LAUNCH_KEY);
    const auth = new TransportAuth(lifecycle.instanceId, undefined, !web);
    if (options.buildWeb) await ensureWebBuild(repository, staticRoot, home);
    const promptExtensions = await loadPromptExtensions(config);
    const provider = new ReloadingProvider(() => ({baseUrl:config.baseUrl, apiKey:config.apiKey, streaming:config.streaming, maxRetries:0}));
    store = new Store(database);
    markCheckoutState(home);
    ({app} = await createApp({config, provider, store, providerSettingsFile:file, tools,
      hooks:createManagedHooks(provider, store, config, {promptExtensions, textJSON:true}),
      staticRoot, lifecycle:{identity:lifecycle, close}, localWeb:web, transportAuth:web ? undefined : auth}));
    const address = await app.listen({host:config.host, port:config.port});
    config.port = Number(new URL(address).port);
    lifecycle.ready();
    durableWrite(descriptor, JSON.stringify({version:1, address, key:lifecycle.key, identity:lifecycle.identity()}));
    published = true;
    const running = lifecycle;
    return {app, config, lifecycle:running, auth, address, close:() => running.stop(close)};
  } catch (error) {
    await (lifecycle ? lifecycle.stop(close) : close());
    throw error;
  }
}
