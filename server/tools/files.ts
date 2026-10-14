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
  assertRemovable(root: string) {
    const prefix = key(path.resolve(root)) + path.sep;
    for (const [id,lease] of leases) {
      if (lease.expires <= Date.now()) leases.delete(id);
      else if (id.startsWith(prefix)) throw new ToolError('An editor has unsaved changes; save or discard them before removal.','CONFLICT');
    }
    if ([...locks.keys()].some(id=>id.startsWith(prefix))) throw new ToolError('A file operation is still pending.','CONFLICT');
  }
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
  /** Sorted multi-path locks share the save/undo lock table. */
  private async locked<T>(ids: string[], operation: () => Promise<T>): Promise<T> {
    const releases: (() => void)[] = [];
    try {
      for (const id of [...new Set(ids)].sort()) {
        const previous = locks.get(id) ?? Promise.resolve();
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const tail = previous.then(() => pending);
        locks.set(id, tail);
        releases.push(() => { release(); if (locks.get(id) === tail) locks.delete(id); });
        await previous;
      }
      return await operation();
    } finally { for (const release of releases.reverse()) release(); }
  }
  async move(root: string, input: string, destination: string, baseHash: string, afterCreate?: () => void, claim?: () => void): Promise<{source: FileSnapshot; destination: FileSnapshot}> {
    const source = await scoped(root, input), target = await scoped(root, destination);
    const ids = [key(source.absolute), key(target.absolute)];
    if (ids[0] === ids[1]) throw new ToolError('Rename requires different source and destination paths.');
    return this.locked(ids, async () => {
      for (const id of ids) this.checkLease(id);
      const before = await this.read(root, input);
      if (before.hash === null || before.hash !== baseHash) throw new ToolError('Rename source changed; read it again.', 'CONFLICT');
      if ((await this.read(root, destination)).hash !== null) throw new ToolError('Rename destination already exists.', 'CONFLICT');
      await scoped(root, destination); await scoped(root, input);
      const identity = await lstat(source.absolute, {bigint: true});
      if ((await this.read(root, input)).hash !== baseHash) throw new ToolError('Rename source changed before dispatch.', 'CONFLICT');
      for (const id of ids) this.checkLease(id);
      // Exclusive creation prevents clobbering a destination introduced after
      // inspection. This is a guarded copy/remove, not an atomic OS rename.
      claim?.();
      const parentMissing=await lstat(path.dirname(target.absolute)).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;});
      // mkdir can partially create a chain before rejecting. Mark possible
      // directory effects first; never erase them during uncertain recovery.
      if(parentMissing)afterCreate?.();
      await mkdir(path.dirname(target.absolute), {recursive: true});
      await scoped(root,destination);
      for(const id of ids)this.checkLease(id);
      const handle = await open(target.absolute, 'wx', Number(identity.mode & 0o777n));
      let destinationIdentity;
      try { afterCreate?.(); await handle.writeFile(before.content, 'utf8'); await handle.sync(); destinationIdentity = await handle.stat({bigint:true}); } finally { await handle.close(); }
      for (const id of ids) this.checkLease(id);
      await scoped(root, input); await scoped(root, destination);
      const current = await lstat(source.absolute, {bigint: true});
      const currentDestination = await lstat(target.absolute, {bigint:true});
      if (identity.ino !== current.ino || identity.dev !== current.dev || identity.ctimeNs !== current.ctimeNs ||
          destinationIdentity.ino !== currentDestination.ino || destinationIdentity.dev !== currentDestination.dev || destinationIdentity.ctimeNs !== currentDestination.ctimeNs ||
          (await this.read(root, input)).hash !== baseHash || (await this.read(root, destination)).hash !== baseHash) {
        throw new ToolError('Rename changed after destination creation; outcome is uncertain. Inspect both paths; do not replay.', 'CONFLICT');
      }
      for (const id of ids) this.checkLease(id);
      await unlink(source.absolute);
      return {source: {path: source.relative, content: '', hash: null}, destination: {...before, path: target.relative}};
    });
  }
  async range(root: string, input: string, startLine: number, count: number) {
    if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(count) || count < 1 || count > 500) throw new ToolError('Invalid line range.');
    const file = await this.read(root, input), lines = file.content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (startLine > lines.length + 1) throw new ToolError('Line range starts beyond the file.');
    const content = lines.slice(startLine - 1, startLine - 1 + count).join('');
    if (Buffer.byteLength(content) > 64_000) throw new ToolError('Line range exceeds 64,000 bytes; request fewer lines.');
    return {path: file.path, hash: file.hash, startLine, totalLines: lines.length, content, nextLine: startLine - 1 + count < lines.length ? startLine + count : null};
  }
  async save(root: string, input: string, content: string, baseHash: string | null, owner?: string, beforeMutation?: () => void, remove = false): Promise<FileSnapshot> {
    let claimed=false;
    const claim=()=>{if(!claimed){beforeMutation?.();claimed=true;}};
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
        const identity = await lstat(target.absolute,{bigint:true});
        if (baseHash === null || (await this.read(root, input)).hash !== baseHash) throw new ToolError('File changed before removal.', 'CONFLICT');
        await scoped(root, input);
        this.checkLease(id);
        const current = await lstat(target.absolute,{bigint:true});
        if (identity.ino !== current.ino || identity.dev !== current.dev || identity.ctimeNs !== current.ctimeNs) throw new ToolError('File identity changed before removal.', 'CONFLICT');
        claim();
        await unlink(target.absolute);
        return { path: target.relative, content: '', hash: null };
      }
      const parentMissing=await lstat(path.dirname(target.absolute)).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;});
      if(parentMissing)claim();
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
      claim();
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
  async searchPage(root: string, query: string, input = '', offset = 0, limit = 100, revision?: string) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (offset > 0 && !revision)) throw new ToolError('Invalid search page or missing revision.');
    const matches: {path: string; line: number; text: string}[] = [];
    const versions: unknown[] = [];
    const stack = [{path: input, depth: 0}];
    let visited = 0, discovered = 1, bytes = 0, incomplete = false, total = 0;
    const entryLimit = Math.min(this.options.maxSearchFiles, 2048);
    const started = Date.now();
    while (stack.length) {
      if (++visited > entryLimit || Date.now() - started > 2000) { incomplete = true; break; }
      const current = stack.pop()!;
      const target = await scoped(root, current.path, true), stat = await lstat(target.absolute);
      if (stat.isDirectory()) {
        const listed = await this.list(root, current.path);
        const entries = listed.slice(0, Math.max(0, entryLimit - discovered));
        if(entries.length < listed.length) incomplete = true;
        discovered += entries.length;
        versions.push([current.path, entries.map(entry => [entry.path, entry.type])]);
        if (current.depth >= 8 && entries.some(entry => entry.type === 'directory')) { incomplete = true; continue; }
        for (const entry of entries.reverse()) {
          if (entry.type === 'directory' && ['node_modules', 'dist', 'build', '.cache', '.venv'].includes(entry.name)) { incomplete = true; continue; }
          stack.push({path: entry.path, depth: current.depth + 1});
        }
      } else {
        try {
          const file = await this.read(root, current.path);
          bytes += Buffer.byteLength(file.content);
          if (bytes > 8_000_000) { incomplete = true; break; }
          versions.push([file.path, file.hash]);
          for (const [index, line] of file.content.split(/\r?\n/).entries()) {
            if (!line.includes(query)) continue;
            if (total >= offset && matches.length < limit) matches.push({path: file.path, line: index + 1, text: line.slice(0, 500)});
            if (++total > 10_000) { incomplete = true; break; }
          }
          if (total > 10_000) break;
        } catch (error) { if (!(error instanceof ToolError)) throw error; incomplete = true; versions.push([current.path, 'unreadable']); }
      }
    }
    const currentRevision = hash(JSON.stringify([query, input, versions, incomplete, total]));
    if (revision && revision !== currentRevision) throw new ToolError(incomplete ? 'Search observation is incomplete or changed; narrow the scope and restart at offset zero.' : 'Search scope changed; restart at offset zero.', 'CONFLICT');
    return {matches, revision: currentRevision, nextOffset: offset + matches.length < total ? offset + matches.length : null, incomplete, observedMatches: total};
  }
}
