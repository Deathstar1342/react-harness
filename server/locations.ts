import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const installationRoot = fileURLToPath(new URL('../', import.meta.url));
export function applicationHome(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string {
  if (env.HARNESS_HOME !== undefined) {
    if (!env.HARNESS_HOME || !path.isAbsolute(env.HARNESS_HOME)) throw new Error('HARNESS_HOME must be an absolute path');
    return path.resolve(env.HARNESS_HOME);
  }
  const base = platform === 'win32' ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  if (!path.isAbsolute(base)) throw new Error('Application data base must be absolute');
  return path.join(base, platform === 'win32' ? 'abysSUS' : 'abyssus');
}
export function profilePaths(home: string) {
  const profile = path.join(home, 'profile');
  return {home, profile, configFile:path.join(profile,'config','.env'), dataDir:path.join(profile,'state'),
    cacheDir:path.join(home,'cache','sandboxes'), staticRoot:path.join(installationRoot,'dist','client')};
}
