import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function privateDirectory(directory: string) {
  mkdirSync(directory, {recursive:true, mode:0o700});
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Application directory must be a real directory');
  if (process.platform !== 'win32' && (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)) {
    throw new Error('Application directory must be owned by this user with mode 0700');
  }
}

export function regularFile(filename: string) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Application files must be regular and unlinked');
  return stat;
}

function exists(filename: string) {
  try { lstatSync(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export function durableWrite(filename: string, value: string) {
  if (exists(filename)) regularFile(filename);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, {force:true});
  }
  syncDirectory(path.dirname(filename));
}

function syncDirectory(directory: string) {
  if (process.platform !== 'win32') {
    const fd = openSync(directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

/** Keep the lock file in place. SQLite releases its OS lock when the process exits. */
export class StateOwnership {
  private db?: DatabaseSync;
  constructor(directory: string) {
    const filename = path.join(directory, '.backend-owner.sqlite');
    if (!exists(filename)) {
      try { closeSync(openSync(filename, 'wx', 0o600)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    regularFile(filename);
    const db = new DatabaseSync(filename);
    try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); this.db = db; }
    catch { db.close(); throw new Error('Application data is owned by another backend. Stop it before starting or importing state.'); }
  }
  close() { this.db?.close(); this.db = undefined; }
}

const marker = '.state.json';
export function checkoutDatabase(directory: string) {
  const database = path.join(directory, 'state.sqlite');
  const sidecars = ['-wal', '-shm', '-journal'].map(suffix => database + suffix);
  const evidence = [marker, '.profile-state.json', ...sidecars.map(file => path.basename(file))];
  if (!exists(database) && evidence.some(name => exists(path.join(directory, name)))) {
    throw new Error('Established state.sqlite is missing from .harness. Restore it before starting.');
  }
  for (const file of [database, ...sidecars]) if (exists(file)) regularFile(file);
  return database;
}

export function markCheckoutState(directory: string) {
  durableWrite(path.join(directory, marker), JSON.stringify({version:1}));
}

function legacyHome(repository: string, env: NodeJS.ProcessEnv, settings: NodeJS.ProcessEnv) {
  const base = process.platform === 'win32'
    ? env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
    : env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return settings.HARNESS_HOME
    ? path.resolve(env.HARNESS_HOME ? process.cwd() : repository, settings.HARNESS_HOME)
    : path.join(base, process.platform === 'win32' ? 'abysSUS' : 'abyssus');
}

const databaseFiles = new Set(['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'state.sqlite-journal']);
const metadataFiles = new Set([
  '.backend-owner.sqlite', '.backend-owner.sqlite-journal', '.backend-owner.sqlite-wal', '.backend-owner.sqlite-shm',
  '.profile-state.json', marker, 'backend.json',
]);
function copyLegacyFiles(source: string, destination: string, skip: ReadonlySet<string> = new Set()) {
  let count = 0;
  function copy(from: string, to: string, depth: number) {
    if (depth > 64) throw new Error('Existing application data exceeds the import depth limit');
    for (const name of readdirSync(from)) {
      if (['.env', 'config.env'].includes(name.toLowerCase()) || (depth === 0 && skip.has(name))) continue;
      if (++count > 10000) throw new Error('Existing application data exceeds the import file limit');
      const original = path.join(from, name);
      const target = path.join(to, name);
      if (lstatSync(original).isDirectory()) {
        mkdirSync(target, {mode:0o700});
        copy(original, target, depth + 1);
      } else {
        regularFile(original);
        copyFileSync(original, target);
        chmodSync(target, 0o600);
        const fd = openSync(target, 'r+');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    }
  }
  copy(source, destination, 0);
}

/** One-time snapshot of the former layout. The old database and settings stay in place. */
export async function importLegacyState(repository: string, directory: string, env: NodeJS.ProcessEnv, settings: NodeJS.ProcessEnv) {
  if (exists(directory)) {
    privateDirectory(directory);
    if (exists(path.join(directory, 'state.sqlite'))) return;
    checkoutDatabase(directory);
    if (exists(path.join(directory, 'profile'))) {
      throw new Error('The old profile is inside .harness. Stop the old backend, rename that directory to a separate backup, then set HARNESS_HOME to the backup path for one npm start.');
    }
  }

  const home = legacyHome(repository, env, settings);
  const profile = path.join(home, 'profile');
  const configuredData = settings.HARNESS_DATA_DIR && path.resolve(env.HARNESS_DATA_DIR ? process.cwd() : repository, settings.HARNESS_DATA_DIR);
  if (!exists(profile) && !exists(path.join(home, 'migration.json')) && !configuredData && !settings.HARNESS_HOME) return;
  if (exists(directory) && readdirSync(directory).length) {
    throw new Error('Back up the existing .harness directory before importing the old application data.');
  }

  const locks: StateOwnership[] = [];
  let stage: string | undefined;
  try {
    if (exists(home) && path.relative(directory, home) !== '') {
      privateDirectory(home);
      locks.push(new StateOwnership(home));
    }
    if (exists(profile)) privateDirectory(profile);
    const binding = path.join(profile, 'data-location.json');
    let data = configuredData || path.join(profile, 'state');
    if (exists(binding)) {
      if (regularFile(binding).size > 32768) throw new Error('Old data location is too large');
      const {directory: bound} = JSON.parse(readFileSync(binding, 'utf8'));
      if (typeof bound !== 'string' || !path.isAbsolute(bound)) throw new Error('The old data location is invalid');
      if (configuredData && path.relative(configuredData, bound) !== '') {
        throw new Error('HARNESS_DATA_DIR disagrees with the last data location. Restore the prior setting before importing.');
      }
      data = bound;
    }
    const source = path.join(data, 'state.sqlite');
    if (!exists(source)) throw new Error('Old state.sqlite is missing. Restore it before starting or remove obsolete storage overrides for a fresh checkout.');
    privateDirectory(data);
    const canonicalData = realpathSync(data);
    const checkoutRelative = path.relative(canonicalData, repository);
    if (!checkoutRelative || (!checkoutRelative.startsWith('..' + path.sep) && checkoutRelative !== '..' && !path.isAbsolute(checkoutRelative))) {
      throw new Error('The old data directory contains this checkout. Back up its state.sqlite and data files into a separate directory before importing.');
    }
    const sameHome = exists(home) && path.relative(realpathSync(home), canonicalData) === '';
    if (!sameHome) locks.push(new StateOwnership(data));
    for (const name of databaseFiles) if (exists(path.join(data, name))) regularFile(path.join(data, name));

    stage = mkdtempSync(path.join(repository, '.harness-import-'));
    const database = new DatabaseSync(source, {readOnly:true});
    try {
      const format = database.prepare("SELECT data FROM state WHERE key='prototype:protocol'").get();
      if (format?.data !== JSON.stringify('native-tools-v1')) throw new Error('The old database has an unsupported format');
      await backup(database, path.join(stage, 'state.sqlite'));
    } finally { database.close(); }
    const skip = new Set([...databaseFiles, ...metadataFiles]);
    if (exists(profile) && path.relative(realpathSync(profile), canonicalData) === '') {
      for (const name of ['config', 'profile.json', 'data-location.json']) skip.add(name);
    }
    if (sameHome) for (const name of readdirSync(data)) {
      if (name === 'profile' || /^(migration|interrupted)[.-]/.test(name)) skip.add(name);
    }
    copyLegacyFiles(data, stage, skip);
    const skills = path.join(home, 'skills');
    if (!sameHome && exists(skills)) {
      privateDirectory(skills);
      const target = path.join(stage, 'skills');
      mkdirSync(target, {mode:0o700});
      copyLegacyFiles(skills, target);
    }
    chmodSync(path.join(stage, 'state.sqlite'), 0o600);
    const fd = openSync(path.join(stage, 'state.sqlite'), 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    markCheckoutState(stage);
    renameSync(stage, directory);
    stage = undefined;
    syncDirectory(repository);
  } finally {
    try {
      if (stage && path.dirname(stage) === repository && realpathSync(stage) === stage) {
        rmSync(stage, {recursive:true, force:true});
      }
    }
    finally { for (const lock of locks.reverse()) lock.close(); }
  }
}
