import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const installationRoot = fileURLToPath(new URL('../', import.meta.url));

export function applicationHome(repository = installationRoot): string {
  return path.join(repository, '.harness');
}
