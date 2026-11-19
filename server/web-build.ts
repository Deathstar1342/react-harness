import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { durableWrite, regularFile } from './local-state.js';

const receiptName = '.build-receipt.json';
const buildInputs = ['index.html', 'client', 'shared', 'public', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json', 'node_modules/.package-lock.json'];

function fingerprint(root: string, entries: string[]) {
  const hash = createHash('sha256');
  function add(relative: string) {
    const filename = path.join(root, relative);
    const stat = lstatSync(filename);
    if (stat.isDirectory()) {
      for (const name of readdirSync(filename).sort()) {
        add(path.join(relative, name));
      }
    } else {
      if (!stat.isFile()) throw new Error('Web build paths must contain only regular files and directories');
      hash.update(JSON.stringify([relative, createHash('sha256').update(readFileSync(filename)).digest('hex')]));
    }
  }
  for (const entry of entries) if (existsSync(path.join(root, entry))) add(entry);
  return hash.digest('hex');
}

function inputFingerprint(repository: string) {
  const buildEnvironment = Object.entries(process.env)
    .filter(([key]) => key.startsWith('VITE_'))
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify([
    process.version, process.env.NODE_ENV ?? 'production', buildEnvironment, fingerprint(repository, buildInputs)
  ])).digest('hex');
}

export async function ensureWebBuild(repository: string, output: string, home: string) {
  const receiptFile = path.join(home, receiptName);
  const input = inputFingerprint(repository);
  for (const directory of [path.dirname(output), output]) {
    const stat = lstatSync(directory, {throwIfNoEntry:false});
    if (stat && !stat.isDirectory()) throw new Error('Web build output must be a real directory');
  }
  try {
    if (regularFile(receiptFile).size <= 1024 && regularFile(path.join(output, 'index.html')).size > 0) {
      const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
      if (receipt.input === input && receipt.output === fingerprint(output, [''])) return;
    }
  } catch { /* Missing or invalid output requires a rebuild. */ }

  console.log('Building the web app…');
  const { build } = await import('vite');
  await build({root:repository, build:{outDir:output, emptyOutDir:true}});
  if (inputFingerprint(repository) !== input) throw new Error('Web build inputs changed during the build. Run npm start again.');
  regularFile(path.join(output, 'index.html'));
  durableWrite(receiptFile, JSON.stringify({input, output:fingerprint(output, [''])}));
}
