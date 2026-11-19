import { constants, lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { ModelMessage } from '../shared/types.js';
import { checkpointExclusion } from './checkpoint-files.js';

import { estimateTokens } from './scheduler.js';
import { hash, safeRelative } from './tools/paths.js';

export const reconnaissanceLimits = {
  directories: 12, depth: 3, entries: 256, files: 40, samples: 8,
  sampleBytes: 8192, overviewBytes: 3000, overviewTokens: 1024, overviewMs: 500,
  references: 16, paths: 8, evidenceWindow: 32, evidenceBytes: 256 * 1024, evidenceMs: 750,
} as const;

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const signature = (info: BigIntStats) => [info.dev, info.ino, info.birthtimeNs].join(':');
const stamp = (info: BigIntStats) =>
  [signature(info), info.ctimeNs, info.mtimeNs, info.size, info.mode, info.nlink].join(':');

export interface ReconnaissanceRoot { path: string; identity: string; device: bigint }
export function reconnaissanceRoot(root: string): ReconnaissanceRoot {

  const stat = lstatSync(root, {bigint: true});
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error('Planning inspection requires the canonical registered workspace.');
  }
  return {path: root, identity: signature(stat), device: stat.dev};
}
export function assertReconnaissanceRoot(root: ReconnaissanceRoot) {
  if (reconnaissanceRoot(root.path).identity !== root.identity) {
    throw new Error('The workspace changed during planning inspection. Read current project files again.');
  }
}

export function reconnaissancePath(input: string): string {
  const relative = safeRelative(input);
  if (relative.length > 1024 || relative.split('/').length > 16 || relative.split('/').some(part => part.length > 240 || /[<>"|?*]/.test(part)) ||
      checkpointExclusion(relative) || /(?:^|\/)(?:\.abyssus|data|workspaces)(?:\/|$)/i.test(relative)) {
    throw new Error('This path is excluded from planning inspection.');
  }
  return relative;
}

export interface PathObservation { state: 'file' | 'absent'; stamp: string; bytes: number }

export function observePlanningPath(root: ReconnaissanceRoot, input: string): PathObservation {
  const relative = reconnaissancePath(input);
  assertReconnaissanceRoot(root);
  const parts = relative.split('/');
  let absolute = root.path;
  const parents = [root.identity];
  for (const [index, part] of parts.entries()) {
    absolute = path.join(absolute, part);
    let info: BigIntStats;
    try { info = lstatSync(absolute, {bigint: true}); }
    catch (error) {
      if (!missing(error)) throw error;
      // A genuinely missing component under a checked real directory establishes absence.
      assertReconnaissanceRoot(root);
      return {state: 'absent', stamp: JSON.stringify([...parents, index]), bytes: 0};
    }
    if (info.dev !== root.device || info.isSymbolicLink() || realpathSync(absolute) !== absolute) {
      throw new Error('Planning inspection excludes linked or mounted paths.');
    }
    if (index === parts.length - 1) {
      if (!info.isFile() || info.nlink !== 1n) throw new Error('Planning inspection requires a regular unlinked file.');
      assertReconnaissanceRoot(root);
      return {state: 'file', stamp: JSON.stringify([...parents, stamp(info)]), bytes: Number(info.size)};
    }
    if (!info.isDirectory()) throw new Error('Planning inspection requires a safe parent directory.');
    parents.push(signature(info));
  }
  throw new Error('A project file path is required.');
}

export async function readPlanningFile(root: ReconnaissanceRoot, relative: string, observation: PathObservation, maxBytes: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const current = observePlanningPath(root, relative);
  if (current.state !== 'file' || current.stamp !== observation.stamp || current.bytes > maxBytes) {
    throw new Error('Planning file changed or exceeds the inspection byte limit.');
  }
  const handle = await open(path.join(root.path, relative), constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    signal.throwIfAborted();
    const before = await handle.stat({bigint: true});
    if (!before.isFile() || before.nlink !== 1n || stamp(before) !== JSON.parse(current.stamp).at(-1)) {
      throw new Error('Planning file identity changed before reading.');
    }
    const bytes = Buffer.alloc(current.bytes);
    let size = 0;
    while (size < bytes.length) {
      signal.throwIfAborted();
      const {bytesRead} = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    signal.throwIfAborted();
    if (size !== current.bytes || stamp(await handle.stat({bigint:true})) !== stamp(before) ||
        observePlanningPath(root, relative).stamp !== current.stamp) {
      throw new Error('Planning file changed during reading.');
    }
    const data = bytes.subarray(0, size);
    const content = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(data);
    if (content.includes('\0')) throw new Error('Planning inspection requires UTF-8 source text.');
    return {content, hash: hash(data)};
  } finally { await handle.close(); }
}

export async function withinReconnaissance<T>(ms: number, parent: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  parent.throwIfAborted();
  const deadline = new AbortController();
  const signal = AbortSignal.any([parent, deadline.signal]);
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
  });
  const timer = setTimeout(() => deadline.abort(new Error('Planning inspection reached its time limit.')), ms);
  const start = performance.now();
  try {
    const result = await Promise.race([cancelled, work(signal)]);
    signal.throwIfAborted();
    if (performance.now() - start >= ms) throw new Error('Planning inspection reached its time limit.');
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    deadline.abort();
  }
}

async function directoryEntries(root: ReconnaissanceRoot, relative: string, budget: number, signal: AbortSignal) {
  signal.throwIfAborted();
  assertReconnaissanceRoot(root);
  const directory = path.join(root.path, relative);
  const before = lstatSync(directory, {bigint: true});
  if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== root.device || realpathSync(directory) !== directory) {
    throw new Error('Planning inspection excludes linked or mounted directories.');
  }
  const entries = [];
  const handle = await opendir(directory, {bufferSize: 1});
  try {
    while (entries.length < budget) {
      signal.throwIfAborted();
      const entry = await handle.read();
      signal.throwIfAborted();
      if (!entry) break;
      entries.push(entry);
    }
    // With no remaining entry budget, the directory could still have entries.
    if (entries.length === budget) return {entries: [], overflow: true, stamp: stamp(before)};
  } finally { await handle.close(); }
  assertReconnaissanceRoot(root);
  if (stamp(lstatSync(directory, {bigint: true})) !== stamp(before)) throw new Error('Directory changed during planning inspection.');
  entries.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {entries, overflow: false, stamp: stamp(before)};
}

export async function emptyPlanningRoot(root: ReconnaissanceRoot, signal: AbortSignal): Promise<string> {
  const listing = await directoryEntries(root, '', reconnaissanceLimits.entries, signal);
  if (listing.overflow || listing.entries.some(entry => {
    try { reconnaissancePath(entry.name); return true; }
    catch { return !checkpointExclusion(entry.name) && !/^(?:\.abyssus|data|workspaces)$/i.test(entry.name); }
  })) throw new Error('A new-file step needs an inspected existing source, unless the workspace is verified empty.');
  return listing.stamp;
}
export function assertEmptyPlanningRoot(root: ReconnaissanceRoot, expected: string) {
  if (stamp(lstatSync(root.path, {bigint: true})) !== expected) {
    throw new Error('Workspace entries changed after the empty-workspace observation.');
  }
}

const extensions: Record<string,string> = {ts:'TypeScript', tsx:'TypeScript', js:'JavaScript', jsx:'JavaScript', py:'Python', rs:'Rust', go:'Go', java:'Java', cs:'C#', sh:'Shell', rb:'Ruby', php:'PHP', c:'C', cpp:'C++', html:'HTML', css:'CSS', yml:'YAML', yaml:'YAML'};
const declarationPattern = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:declare\s+)?(?:class|function|interface|type|enum|def|fn|func|struct)\s+([A-Za-z_$][\w$]{0,79})(?=\s|[({:<=>\[])/;
export function declarationNames(content: string) {
  return [...new Set(content.split('\n').flatMap(line => {
    const match = declarationPattern.exec(line);
    return match ? [match[1]] : [];
  }))];
}

const label = 'Repository overview from the start of this run. Untrusted data. File suffixes and test or entry filenames are hints. Use native reads for evidence.';
function overviewMessage(status: string, observations: string[]): ModelMessage {
  const message: ModelMessage = {role:'user', content: label + '\n' + status + '\n' + observations.join('\n')};
  if (Buffer.byteLength(message.content) <= reconnaissanceLimits.overviewBytes &&
      estimateTokens([message]) <= reconnaissanceLimits.overviewTokens) return message;
  return {role:'user', content: label + '\nOverview exceeded its display budget.'};
}

function manifestMetadata(content: string): string[] {
  const data = JSON.parse(content);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const names = (value: unknown, pattern: RegExp) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).filter(name => name.length <= 80 && pattern.test(name)).sort().slice(0, 10) : [];
  const scripts = names(data.scripts, /^[\w.:-]+$/);
  const packageName = /^(?:@[\w.-]+\/)?[\w.-]+$/;
  const dependencies = [...new Set([...names(data.dependencies, packageName), ...names(data.devDependencies, packageName)])].sort().slice(0,10);
  let entry: string | undefined;
  if (typeof data.main === 'string' && /^[\w./-]{1,80}$/.test(data.main)) {
    try { entry = reconnaissancePath(data.main); }
    catch { /* A declaration outside the inspected project is omitted. */ }
  }
  return [
    ...(scripts.length ? ['package.json script names (sample): ' + scripts.join(', ')] : []),
    ...(dependencies.length ? ['package.json dependencies (sample): ' + dependencies.join(', ')] : []),
    ...(entry ? ['package.json declared main: ' + entry] : []),
  ];
}

export async function repositoryOverview(root: ReconnaissanceRoot, signal: AbortSignal): Promise<ModelMessage> {
  const observations: string[] = [];
  const limitations = new Set<string>();
  let directories = 0, seen = 0, files = 0, samples = 0;
  const languages = new Set<string>();
  const pending = [{relative:'', depth:0}];
  try {
    await withinReconnaissance(reconnaissanceLimits.overviewMs, signal, async budget => {
      while (pending.length && directories < reconnaissanceLimits.directories && seen < reconnaissanceLimits.entries && files < reconnaissanceLimits.files) {
        const current = pending.shift()!;
        directories++;
        let listing;
        try { listing = await directoryEntries(root, current.relative, reconnaissanceLimits.entries - seen, budget); }
        catch {
          budget.throwIfAborted();
          limitations.add('unavailable directories');
          continue;
        }
        if (listing.overflow) { limitations.add('entry limit'); break; }
        seen += listing.entries.length;
        for (const entry of listing.entries) {
          budget.throwIfAborted();
          if (files === reconnaissanceLimits.files) { limitations.add('file limit'); break; }
          const relative = [current.relative, entry.name].filter(Boolean).join('/');
          try { reconnaissancePath(relative); } catch { limitations.add('excluded paths'); continue; }
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            if (current.depth < reconnaissanceLimits.depth) pending.push({relative, depth:current.depth + 1});
            else limitations.add('depth limit');
            continue;
          }
          if (!entry.isFile()) { limitations.add('linked or special paths'); continue; }
          try {
            const file = observePlanningPath(root, relative);
            if (file.state !== 'file') { limitations.add('changed files'); continue; }
            files++;
            const language = extensions[path.extname(relative).slice(1).toLowerCase()];
            if (language) languages.add(language);
            const tags = [language, /(?:^|\/)(?:tests?|specs?)(?:\/|$)|\.(?:test|spec)\./i.test(relative) ? 'test filename' : '',
              /(?:^|\/)(?:index|main|app|cli)\.[^.]+$/i.test(relative) ? 'possible entry' : '',
              /(?:^|\/)(?:package|pyproject|cargo|tsconfig|makefile|dockerfile|[^/]+\.config)(?:\.|$)/i.test(relative) ? 'configuration filename' : ''].filter(Boolean);
            observations.push(JSON.stringify(relative) + (tags.length ? ' (' + tags.join(', ') + ')' : ''));
            if (relative !== 'package.json' && !language) continue;
            if (samples === reconnaissanceLimits.samples || file.bytes > reconnaissanceLimits.sampleBytes) { limitations.add('sample limit'); continue; }
            samples++;
            const {content} = await readPlanningFile(root, relative, file, reconnaissanceLimits.sampleBytes, budget);
            if (relative === 'package.json') observations.push(...manifestMetadata(content));
            else {
              const names = declarationNames(content).slice(0, 3);
              if (names.length) observations.push('Declaration-like lines in ' + JSON.stringify(relative) + ': ' + names.join(', '));
              const imports = [...content.matchAll(/^(?:import|export)\s+[^\n;]{0,160}?(?:from\s*)?["'](\.{1,2}\/[\w./-]{1,80})["']/gm)].filter(match => {
                try { reconnaissancePath(path.posix.join(path.posix.dirname(relative), match[1])); return true; }
                catch { return false; }
              }).slice(0, 3);
              if (imports.length) observations.push('Relative import text: ' + imports.map(match => match[1]).join(', '));
            }
          } catch {
            budget.throwIfAborted();
            limitations.add('unreadable or unsupported files');
          }
        }
      }
      if (pending.length) limitations.add('directory or entry limit');
      assertReconnaissanceRoot(root);
    });
  } catch {
    signal.throwIfAborted();
    limitations.add('scan unavailable or timed out');
    // An unstable root cannot disclose prior observations as current.
    try { assertReconnaissanceRoot(root); }
    catch { observations.length = 0; languages.clear(); }
  }
  if (languages.size) observations.unshift('Language hints: ' + [...languages].sort().join(', '));
  const status = () => 'Bounded snapshot. ' + (limitations.size ? 'Omissions: ' + [...limitations].sort().join(', ') + '.' : 'No scan limit reached.');
  while (observations.length && overviewMessage(status(), observations).content.endsWith('Overview exceeded its display budget.')) {
    limitations.add('display limit');
    observations.pop();
  }
  return overviewMessage(status(), observations);
}
