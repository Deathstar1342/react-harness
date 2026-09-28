import { constants } from 'node:fs';
import { open, lstat, mkdir, rename, unlink, opendir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileEntry, FileSnapshot } from '../../shared/types.js';
import { allowed, hash, key, leasePath, scoped, ToolError } from './paths.js';

const locks = new Map<string, Promise<void>>();
const leases = new Map<string, { owner: string; expires: number }>();
export interface FileOptions { maxFileBytes: number; maxEntries: number; maxSearchFiles: number; leaseMs: number }
export class WorkspaceFiles {
  constructor(readonly options: FileOptions) {}
  async read(root: string, input: string): Promise<FileSnapshot> {
    const target = await scoped(root, input);
    let handle;
    try {
      handle = await open(target.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1) throw new ToolError('Only regular, non-linked files are supported.');
      if (info.size > this.options.maxFileBytes) throw new ToolError('File exceeds size limit.');
      // A bounded read also handles growth after stat; never readFile an unbounded descriptor.
      const buffer = Buffer.alloc(this.options.maxFileBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, null);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > this.options.maxFileBytes) throw new ToolError('File exceeds size limit.');
      const bytes = buffer.subarray(0, size);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new ToolError('Only UTF-8 text files are supported.'); }
      if (content.includes('\0')) throw new ToolError('Binary files are unsupported.');
      await scoped(root, input);
      return { path: target.relative, content, hash: hash(bytes) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: target.relative, content: '', hash: null };
      throw error;
    } finally { await handle?.close(); }
  }
  async list(root: string, input = ''): Promise<FileEntry[]> {
    const target = await scoped(root, input, true);
    const directory = await opendir(target.absolute);
    let count = 0;
    const entries: FileEntry[] = [];
    for await (const entry of directory) {
      if (++count > this.options.maxEntries) throw new ToolError('Directory exceeds entry limit.');
      const relative = [target.relative, entry.name].filter(Boolean).join('/');
      if (!allowed(relative) || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      const stat = await lstat(path.join(target.absolute, entry.name));
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) continue;
      entries.push({ path: relative, name: entry.name, type: stat.isDirectory() ? 'directory' : 'file', ...(stat.isFile() ? { size: stat.size } : {}) });
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  setDirty(root: string, input: string, owner: string, dirty: boolean): void {
    if (!owner || owner.length > 256 || typeof dirty !== 'boolean') throw new ToolError('Invalid editor lease.');
    for (const [id, lease] of leases) if (lease.expires <= Date.now()) leases.delete(id);
    const id = leasePath(root, input), existing = leases.get(id);
    if (existing && existing.expires > Date.now() && existing.owner !== owner) throw new ToolError('Another editor owns the dirty buffer.', 'CONFLICT');
    if (dirty) leases.set(id, { owner, expires: Date.now() + this.options.leaseMs });
    else if (!existing || existing.owner === owner || existing.expires <= Date.now()) leases.delete(id);
  }
  private checkLease(id: string, owner?: string): void {
    const lease = leases.get(id);
    if (lease && lease.expires <= Date.now()) leases.delete(id);
    else if (lease && lease.owner !== owner) throw new ToolError('An editor has unsaved changes; refresh after it saves or releases its lease.', 'CONFLICT');
  }
  async save(root: string, input: string, content: string, baseHash: string | null, owner?: string, beforeMutation?: () => void, remove = false): Promise<FileSnapshot> {
    if (typeof content !== 'string' || Buffer.from(content).toString('utf8') !== content || content.includes('\0') || Buffer.byteLength(content) > this.options.maxFileBytes) throw new ToolError('Invalid content or file exceeds size limit.');
    if (baseHash !== null && !/^[a-f0-9]{64}$/.test(baseHash)) throw new ToolError('Expected SHA-256 baseHash or null for a new file.');
    const target = await scoped(root, input), id = key(target.absolute);
    const previous = locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => pending);
    locks.set(id, tail);
    await previous;
    let temporary: string | undefined;
    try {
      this.checkLease(id, owner);
      const before = await this.read(root, input);
      if (before.hash !== baseHash) throw new ToolError('File changed since it was read. Refresh and propose a new edit.', 'CONFLICT');
      await scoped(root, input);
      if (remove) {
        // Deletion never creates parents or follows links; use the same lock as saves.
        this.checkLease(id);
        if (baseHash === null || (await this.read(root, input)).hash !== baseHash) throw new ToolError('File changed before removal.', 'CONFLICT');
        await scoped(root, input);
        this.checkLease(id);
        beforeMutation?.();
        await unlink(target.absolute);
        return { path: target.relative, content: '', hash: null };
      }
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await scoped(root, input);
      temporary = path.join(path.dirname(target.absolute), `.rh-write-${randomUUID()}`);
      const info = await lstat(target.absolute).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      const handle = await open(temporary, 'wx', info ? info.mode & 0o777 : 0o600);
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      // Approval-time snapshots are insufficient: compare again at the write boundary.
      this.checkLease(id, owner);
      if ((await this.read(root, input)).hash !== baseHash) throw new ToolError('File changed before applying the edit.', 'CONFLICT');
      await scoped(root, input);
      this.checkLease(id, owner);
      beforeMutation?.();
      await rename(temporary, target.absolute);
      temporary = undefined;
      // Only the editor knows whether more keystrokes arrived during this save.
      // Keep its lease until it explicitly releases the now-clean buffer.
      return { path: target.relative, content, hash: hash(Buffer.from(content)) };
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      release();
      if (locks.get(id) === tail) locks.delete(id);
    }
  }
  async search(root: string, query: string, input = ''): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }> {
    const matches: { path: string; line: number; text: string }[] = [];
    const stack = [input]; let visited = 0, truncated = false;
    while (stack.length) {
      const current = stack.pop()!;
      const target = await scoped(root, current, true);
      const stat = await lstat(target.absolute);
      if (stat.isDirectory()) {
        for (const entry of await this.list(root, current)) {
          if (++visited > this.options.maxSearchFiles) { truncated = true; break; }
          // Avoid dependency/build trees; callers can explicitly search a file in them.
          if (entry.type === 'directory' && ['node_modules', 'dist', 'build', '.cache'].includes(entry.name)) continue;
          stack.push(entry.path);
        }
      } else {
        try {
          const file = await this.read(root, current);
          file.content.split(/\r?\n/).forEach((text, index) => { if (text.includes(query) && matches.length < 500) matches.push({ path: file.path, line: index + 1, text: text.slice(0, 2000) }); });
          if (matches.length >= 500) truncated = true;
        } catch (error) { if (!(error instanceof ToolError)) throw error; }
      }
      if (truncated) break;
    }
    return { matches, truncated };
  }
}
