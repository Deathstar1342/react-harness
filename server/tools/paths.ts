import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export class ToolError extends Error {
  constructor(message: string, readonly code = 'INVALID_TOOL_REQUEST') { super(message); this.name = 'ToolError'; }
}
export const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
export function safeRelative(input: string, allowRoot = false): string {
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f\x7f:]/.test(input) || /^[\\/]/.test(input)) throw new ToolError('Expected a workspace-relative path.');
  const parts = input.replaceAll('\\', '/').split('/');
  if (parts.some(p => p === '..')) throw new ToolError('Path traversal is prohibited.');
  const clean = parts.filter(p => p && p !== '.');
  if (!allowRoot && !clean.length) throw new ToolError('A file path is required.');
  if (clean.some(p => /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new ToolError('Unsupported path component.');
  if (clean.some(isProtected)) throw new ToolError('Protected Git or credential path.');
  return clean.join('/');
}
function isProtected(part: string): boolean {
  return /^(?:\.git(?:$|\.)|\.env|\.ssh$|\.aws$|\.azure$|\.docker$|\.kube$|application_default_credentials\.json$|\.config$|\.gnupg$|\.npmrc$|\.netrc$|\.pypirc$|\.gitconfig$|credentials(?:$|\.)|secrets?(?:$|\.)|id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.))/i.test(part) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part);
}
export function allowed(input: string): boolean { try { safeRelative(input); return true; } catch { return false; } }
export async function rootPath(root: string): Promise<string> {
  const resolved = await realpath(root);
  if (!(await lstat(resolved)).isDirectory()) throw new ToolError('Workspace root must be a directory.');
  return resolved;
}
export async function scoped(root: string, input: string, allowRoot = false): Promise<{ root: string; relative: string; absolute: string }> {
  const canonical = await rootPath(root), relative = safeRelative(input, allowRoot);
  let current = canonical;
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) throw new ToolError('Special filesystem entries are prohibited.');
      if (stat.isSymbolicLink()) throw new ToolError('Symbolic links are prohibited.');
      if (stat.isFile() && stat.nlink > 1) throw new ToolError('Hard-linked files are prohibited.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { root: canonical, relative, absolute: path.join(canonical, relative) };
}
// setDirty is synchronous in the shared interface; perform the same checks synchronously.
export function leasePath(root: string, input: string): string {
  let current = realpathSync(root);
  if (!lstatSync(current).isDirectory()) throw new ToolError('Workspace root must be a directory.');
  for (const part of safeRelative(input).split('/')) {
    current = path.join(current, part);
    try { const s = lstatSync(current); if (s.isSymbolicLink() || (s.isFile() && s.nlink > 1)) throw new ToolError('Linked paths are prohibited.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return key(current);
}
export const key = (absolute: string) => process.platform === 'win32' ? absolute.toLowerCase() : absolute;
