import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { signBackendRequest } from '../server/lifecycle.js';

const root = path.resolve(import.meta.dirname, '..');
const home = process.env.CLI_SMOKE_HOME;
assert(home && path.isAbsolute(home), 'Set an explicit temporary state directory');
const parent = await mkdtemp(path.join(tmpdir(), 'abyssus-cli-'));
const listener = createServer();
await new Promise<void>((resolve, reject) => {
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', resolve);
});
const bound = listener.address();
assert(bound && typeof bound !== 'string');
await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const env = {
  ...process.env,
  HARNESS_HOME: home,
  HARNESS_EXECUTION_MODE: undefined,
  HARNESS_LEGACY_ROOT: undefined,
  HARNESS_DATA_DIR: undefined,
  HARNESS_INIT: undefined,
  STARK_BASE_URL: '',
  STARK_API_KEY: '',
  HOST: '127.0.0.1',
  PORT: String(bound.port),
};
const windows = process.platform === 'win32';
const mode = process.argv[2];
const command = mode === 'npm' ? (windows ? 'cmd.exe' : 'npm')
  : mode === 'bash' ? (process.env.CLI_SMOKE_BASH ?? 'bash') : windows ? 'pwsh' : 'bash';
const args = mode === 'npm' ? (windows ? ['/d', '/c', 'npm', 'start'] : ['start'])
  : mode === 'bash' || !windows ? [path.join(root, 'start.sh').replaceAll('\\', '/')]
  : ['-NoProfile', '-File', path.join(root, 'start.ps1')];
const child = spawn(command, args, {
  cwd: mode === 'npm' ? root : parent, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
const exit = once(child, 'exit');
void exit.catch(() => {});
let stdout = '';
child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
  if (stdout.length < 16384) stdout += chunk;

});
child.stderr.resume();
const address = 'http://127.0.0.1:' + bound.port;
let descriptor: { key: string; identity: { instanceId: string } } | undefined;
const filename = path.join(home, 'backend.json');
try {
  for (let attempts = 0; !descriptor && attempts < 120; attempts++) {
    assert.equal(child.exitCode, null, 'Launcher exited before the backend was ready');
    const current = await readFile(filename, 'utf8').then(text=>JSON.parse(text),()=>null);
    if(current?.address===address&&current.identity?.state==='ready')descriptor=current;
    else await Promise.race([delay(250), exit.then(() => { throw new Error('Launcher exited before readiness'); })]);
  }
  assert(descriptor, 'Launcher did not publish local readiness');
  assert.doesNotMatch(stdout,/pairing code/i);
  const get = (route: string, headers?: HeadersInit) => fetch(address + route, { headers, signal: AbortSignal.timeout(5000) });
  const ui = await get('/');
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /type="module"/);
  assert.deepEqual(await (await get('/api/health')).json(), {ok:true});
  assert.equal((await get('/api/health',{origin:'https://outside.invalid'})).status,403);
  assert.equal((await get('/api/health',{'sec-fetch-site':'cross-site'})).status,403);
  const foreignHost=await new Promise<number|undefined>((resolve,reject)=>{
    const request=httpGet(address+'/api/health',{headers:{host:'outside.invalid'},timeout:5000},response=>{response.resume();resolve(response.statusCode);});
    request.once('error',reject);request.once('timeout',()=>request.destroy(new Error('Host check timed out')));
  });
  assert.equal(foreignHost,403);
  assert.equal((await (await get('/api/settings')).json()).executionMode,'direct');
} finally {
  if (descriptor) {
    const signed = signBackendRequest(descriptor.key, 'shutdown', descriptor.identity.instanceId);
    const response = await fetch(address + '/api/backend/shutdown', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
  } else if (child.exitCode === null) {
    child.kill();
  }
  const timeout = AbortSignal.timeout(15000);
  const result = await Promise.race([exit, delay(16000, undefined, { signal: timeout, ref:false })]);
  assert.deepEqual(result, [0, null], 'Launcher did not stop cleanly');
}
console.log('CLI served the built UI directly, rejected cross-origin access and shut down its temporary state');
