import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink, rename } from 'node:fs/promises';
import { readdirSync, readlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { publicAddress, registryAuthority, resolveRegistry, startRegistryProxy } from '../server/tools/registry-proxy.js';
import { LinuxSandbox } from '../server/tools/sandbox.js';
import { WorkspaceTools } from '../server/tools/index.js';

const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
  const parent=await mkdtemp(path.join(tmpdir(),'sandbox-policy-'));
  cleanup.push(()=>rm(parent,{recursive:true,force:true}));
  const root=path.join(parent,'project'),home=path.join(parent,'app');await mkdir(root);await mkdir(home,{mode:0o700});
  const sandbox=new LinuxSandbox();sandbox.configure({home,protectedPaths:[],projects:()=>[]});
  return {parent,root,home,sandbox};
}
describe('registry destination authority',()=>{
  it('rejects ambiguous authorities, raw IPs and unauthorized targets',()=>{
    expect(registryAuthority('registry.npmjs.org:443')).toBe('registry.npmjs.org');
    for(const value of ['localhost:443','127.0.0.1:443','registry.npmjs.org:0443','registry.npmjs.org.:443','REGISTRY.NPMJS.ORG:443','user@registry.npmjs.org:443','registry.npmjs.org:443/path','registry.npmjs.org:443#x','registry.npmjs.org:443\r\n','pypi.org:80','example.org:443','[::ffff:127.0.0.1]:443'])expect(()=>registryAuthority(value)).toThrow();
  });
  it('denies non-global and translation/tunneling address forms',()=>{
    for(const value of ['0.0.0.0','10.0.0.1','100.64.0.1','127.1.2.3','169.254.169.254','172.16.1.1','192.168.1.1','192.0.0.1','192.0.2.1','198.18.0.1','198.51.100.2','203.0.113.1','224.0.0.1','255.255.255.255','127.1','0x7f000001','::','::1','::ffff:8.8.8.8','::ffff:808:808','64:ff9b::808:808','2002:808:808::','2001::1','2001:db8::1','fc00::1','fe80::1','ff02::1','3fff::1'])expect(publicAddress(value),value).toBe(false);
    expect(publicAddress('104.16.24.34')).toBe(true);expect(publicAddress('2606:4700::6810:1822')).toBe(true);
  });
  it('rejects mixed DNS and re-resolves every new connection',async()=>{
    let count=0;
    const resolver=(async()=>++count===1?[{address:'104.16.24.34',family:4}]:[{address:'104.16.24.34',family:4},{address:'127.0.0.1',family:4}]) as any;
    expect(await resolveRegistry('registry.npmjs.org',resolver)).toBe('104.16.24.34');
    await expect(resolveRegistry('registry.npmjs.org',resolver)).rejects.toThrow('non-public');
    expect(count).toBe(2);
  });
  it.skipIf(process.platform!=='linux')('private broker denies HTTP, upgrades, localhost, LAN, metadata and foreign CONNECT and revokes clients',async()=>{
    const proxy=await startRegistryProxy();cleanup.push(()=>proxy.close());
    const request=(payload:string)=>new Promise<string>((resolve,reject)=>{const client=net.connect(proxy.socket,()=>client.end(payload));let data='';client.on('data',chunk=>data+=chunk);client.on('error',reject);client.on('close',()=>resolve(data));});
    for(const target of ['127.0.0.1:443','192.168.0.1:443','169.254.169.254:443','example.com:443'])expect(await request(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)).toContain('403');
    expect(await request('GET http://127.0.0.1/ HTTP/1.1\r\nHost: localhost\r\n\r\n')).toContain('403');
    const pending=net.connect(proxy.socket);await new Promise<void>(resolve=>pending.once('connect',resolve));
    const ended=new Promise<void>(resolve=>pending.once('close',()=>resolve()));await proxy.close();await ended;
  });
});
describe('project mount policy',()=>{
  it('rejects ancestor/nested app paths and other registered projects',async()=>{
    const {parent,root,home,sandbox}=await fixture();
    expect(()=>sandbox.validateRoot(parent)).toThrow('overlaps');expect(()=>sandbox.validateRoot(home)).toThrow('overlaps');
    sandbox.configure({home,protectedPaths:[path.join(root,'nested','state')],projects:()=>[]});expect(()=>sandbox.validateRoot(root)).toThrow('overlaps');
    sandbox.configure({home,protectedPaths:[],projects:()=>[path.join(root,'other')]});expect(()=>sandbox.validateRoot(root)).toThrow('another registered');
  });
  it('hides protected paths including nested credentials and .git history',async()=>{
    const {root,sandbox}=await fixture();await mkdir(path.join(root,'nested'));await mkdir(path.join(root,'.git'));
    await writeFile(path.join(root,'nested','.env'),'SECRET');await writeFile(path.join(root,'.git','config'),'SECRET');
    expect(sandbox.layout(root).masks.map(m=>path.relative(root,m.path))).toEqual(expect.arrayContaining(['.git',path.join('nested','.env')]));
    const before=sandbox.layout(root).stamp;await writeFile(path.join(root,'.npmrc'),'SECRET');expect(sandbox.layout(root).stamp).not.toBe(before);
  });
  it.skipIf(process.platform!=='linux')('rejects external hardlinks, symlinks and host sockets',async()=>{
    const {root,parent,sandbox}=await fixture();const external=path.join(parent,'outside');await writeFile(external,'secret');
    await link(external,path.join(root,'linked'));expect(()=>sandbox.layout(root)).toThrow('Hardlinks');await rm(path.join(root,'linked'));
    await symlink(external,path.join(root,'linked'));expect(()=>sandbox.layout(root)).toThrow('symlink');await rm(path.join(root,'linked'));
    const server=net.createServer();await new Promise<void>(r=>server.listen(path.join(root,'host.sock'),r));cleanup.push(()=>new Promise<void>(r=>server.close(()=>r())));expect(()=>sandbox.layout(root)).toThrow('sockets');
  });
  it.skipIf(process.platform==='linux')('fails closed on unsupported hosts',async()=>{
    const {root,sandbox}=await fixture();await expect(sandbox.launch(root,['/bin/true'])).rejects.toMatchObject({code:'SANDBOX_UNAVAILABLE'});
  });
});

describe.skipIf(process.platform!=='linux')('real Linux sandbox security',()=>{
  it('constructs a functioning namespace with the production mount policy',async()=>{
    const {root,sandbox}=await fixture();const launch=await sandbox.launch(root,['/usr/bin/true']);
    try{const result=spawnSync(launch.file,launch.args,{env:launch.env,encoding:'utf8',timeout:5000});expect(result.status,result.stderr).toBe(0);}finally{await launch.close();}
  });
  async function execution(){
    const f=await fixture(),tools=new WorkspaceTools();tools.configureSandbox({home:f.home,protectedPaths:[],projects:()=>[]});cleanup.push(()=>tools.dispose());
    const context={projectRoot:f.root,chatId:'test',agentId:'coder'};
    const run=(command:string,timeoutMs=30_000)=>tools.execute(context,{name:'run_shell',args:{command,timeoutMs}});
    return {...f,tools,context,run};
  }
  it('denies outside files, secrets, sockets, process and interop access, while writing the project',async()=>{
    const {root,parent,home,run}=await execution();await writeFile(path.join(parent,'outside'),'OUTSIDE');await writeFile(path.join(home,'backend.json'),'DESCRIPTOR');
    await writeFile(path.join(root,'.env'),'SECRET');await mkdir(path.join(root,'nested'));await writeFile(path.join(root,'nested','.npmrc'),'TOKEN');
    const result=await run(`python3 - <<'PY'
import os, pathlib, socket
root=pathlib.Path(${JSON.stringify(root)})
for p in [${JSON.stringify(path.join(parent,'outside'))},${JSON.stringify(path.join(home,'backend.json'))},'/etc/shadow','/proc/${process.pid}/environ','/mnt/c/Windows/System32/cmd.exe','/init','/run/docker.sock']:
 assert not pathlib.Path(p).exists(), p
assert (root/'.env').read_bytes()==b''
assert (root/'nested/.npmrc').read_bytes()==b''
for p in [root/'.env',root/'nested/.npmrc']:
 try: p.write_text('escape')
 except OSError: pass
 else: raise AssertionError(str(p))
try: os.link('/etc/shadow',root/'hardlink')
except OSError: pass
else: raise AssertionError('hardlink')
(root/'allowed').write_text('yes')
print('CONFINED')
PY`);
    expect(result.ok,result.output).toBe(true);expect(result.output).toContain('CONFINED');expect(await readFile(path.join(root,'allowed'),'utf8')).toBe('yes');
    expect(await readFile(path.join(root,'.env'),'utf8')).toBe('SECRET');expect(await readFile(path.join(parent,'outside'),'utf8')).toBe('OUTSIDE');
  });
  it('denies raw network and limits the explicit proxy capability',async()=>{
    const {run}=await execution();
    const server=net.createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>server.close(()=>r())));
    const port=(server.address() as net.AddressInfo).port;
    const result=await run(`python3 - <<'PY'
import socket
for host,port in [('127.0.0.1',${port}),('169.254.169.254',80),('192.168.1.1',80),('1.1.1.1',443)]:
 s=socket.socket();s.settimeout(.2)
 try: s.connect((host,port))
 except OSError: pass
 else: raise AssertionError((host,port))
 finally: s.close()
for target in ['127.0.0.1:${port}','169.254.169.254:443','192.168.1.1:443','example.com:443']:
 s=socket.create_connection(('127.0.0.1',18080),2);s.sendall(('CONNECT '+target+' HTTP/1.1\\r\\nHost: '+target+'\\r\\n\\r\\n').encode());assert b'403' in s.recv(4096);s.close()
print('NETWORK DENIED')
PY`);
    expect(result.ok,result.output).toBe(true);
  });
  it('installs real pinned npm and PyPI packages and preserves local dependencies across shell restart',async()=>{
    const {run,tools,root}=await execution();
    await writeFile(path.join(root,'package.json'),JSON.stringify({name:'sandbox-build-fixture',version:'1.0.0',scripts:{build:'node build.cjs',test:'node --test built.test.cjs'}}));
    await writeFile(path.join(root,'build.cjs'),`require('fs').writeFileSync('built.cjs',"module.exports = require('is-number');");`);
    await writeFile(path.join(root,'built.test.cjs'),`const test=require('node:test'),assert=require('node:assert/strict'),number=require('./built.cjs');test('real dependency behavior',()=>{assert.equal(number(42),true);assert.equal(number('no'),false);});`);
    const install=await run('npm install --no-audit --no-fund --save-exact is-number@7.0.0 && python3 -m venv .venv && .venv/bin/pip install --disable-pip-version-check --index-url https://pypi.org/simple six==1.17.0',120_000);
    expect(install.ok,install.output).toBe(true);
    const useCommand=`npm run build && npm test && .venv/bin/python -c "import six; assert six.__version__ == '1.17.0'; print(six.__version__)"`;
    let use=await run(useCommand);if(!use.ok && use.output.includes('layout changed'))use=await run(useCommand);expect(use.ok,use.output).toBe(true);
    await run('exit 0');await run('true'); // acknowledge uncertain shell exit
    const again=await run('.venv/bin/python -c "import six; print(six.__version__)" && test -d node_modules/is-number');expect(again.ok,again.output).toBe(true);
    await tools.resetSandbox(root);expect(await readFile(path.join(root,'package.json'),'utf8')).toContain('is-number');
    const afterReset=await run('.venv/bin/python -c "import six"');expect(afterReset.ok,afterReset.output).toBe(true);
  },180_000);
  it('runs hostile offline npm install hooks inside the same boundary',async()=>{
    const {run,root,parent}=await execution();await mkdir(path.join(root,'evil'));
    await writeFile(path.join(parent,'outside'),'preserve');
    await writeFile(path.join(root,'evil','package.json'),JSON.stringify({name:'sandbox-hook-fixture',version:'1.0.0',scripts:{install:'node hook.cjs'}}));
    await writeFile(path.join(root,'evil','hook.cjs'),`const fs=require('fs');if(fs.existsSync(${JSON.stringify(path.join(parent,'outside'))}))process.exit(9);try{fs.writeFileSync(${JSON.stringify(path.join(parent,'outside'))},'namespace-local-shadow')}catch{};if(fs.existsSync('/init'))process.exit(8);fs.writeFileSync('hook-ran','confined');`);
    const result=await run('npm install --offline --no-audit --no-fund ./evil');expect(result.ok,result.output).toBe(true);expect(await readFile(path.join(parent,'outside'),'utf8')).toBe('preserve');expect(await readFile(path.join(root,'evil','hook-ran'),'utf8')).toBe('confined');
  });
  it('kills setsid/double-fork descendants on cancellation and revokes bridge tunnels',async()=>{
    const {tools,context,root}=await execution();const controller=new AbortController();
    let ready=false;const descendants:number[]=[],sockets:string[]=[];
    const code=`import os,time,pathlib\nif os.fork()==0:\n os.setsid()\n if os.fork()==0:\n  pathlib.Path('child-ready').write_text('yes')\n  time.sleep(2)\n  pathlib.Path('escaped-after-cancel').write_text('bad')\n  os._exit(0)\n os._exit(0)\nwhile not pathlib.Path('child-ready').exists(): time.sleep(.01)\nprint('READY',flush=True)\ntime.sleep(30)`;
    const result=await tools.execute({...context,signal:controller.signal,onOutput:text=>{if(text.includes('READY')){
      ready=true;
      for(const pid of readdirSync('/proc').filter(p=>/^\d+$/.test(p))){
        try{if(readlinkSync(`/proc/${pid}/cwd`)===root)descendants.push(Number(pid));}catch{}
        try{const argv=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');if(argv.includes(root) && argv.includes('/usr/bin/bwrap'))sockets.push(...argv.filter(a=>a.startsWith('/tmp/abyssus-registry-')).map(a=>path.join(a,'proxy.sock')));}catch{}
      }
      controller.abort();
    }}},{name:'execute_python',args:{code,timeoutMs:8000}});
    expect(ready,result.output).toBe(true);expect(await readFile(path.join(root,'child-ready'),'utf8')).toBe('yes');expect(descendants.length).toBeGreaterThanOrEqual(3);expect(sockets.length).toBeGreaterThan(0);
    expect(result.ok).toBe(false);for(const socket of sockets)expect(existsSync(socket)).toBe(false);
    await new Promise(r=>setTimeout(r,2500));for(const pid of descendants)expect(existsSync(`/proc/${pid}`),`host descendant ${pid}`).toBe(false);await expect(readFile(path.join(root,'escaped-after-cancel'))).rejects.toThrow();
  });
  it('cannot create nested user namespaces or recover host execution',async()=>{
    const {run}=await execution();const result=await run('printf NAMESPACE_READY; unshare -Ur /usr/bin/true');expect(result.output).toContain('NAMESPACE_READY');expect(result.ok).toBe(false);
  });
  it('rejects internal protected symlinks before any project code executes',async()=>{
    const {root,run}=await execution();await writeFile(path.join(root,'internal'),'secret');await symlink('internal',path.join(root,'.env'));
    const result=await run('cat .env; touch executed');expect(result.ok).toBe(false);expect(result.output).toContain('Protected symlinks');expect(result.output).not.toContain('secret');expect(existsSync(path.join(root,'executed'))).toBe(false);
  });
  it('discards idle sessions after atomic protected file and directory replacement',async()=>{
    const {root,run}=await execution();await writeFile(path.join(root,'.env'),'first-secret');await mkdir(path.join(root,'.ssh'));await writeFile(path.join(root,'.ssh','key'),'first-key');
    expect((await run('test ! -s .env && test -z "$(ls -A .ssh)"')).ok).toBe(true);
    await writeFile(path.join(root,'replacement'),'new-secret');await rename(path.join(root,'replacement'),path.join(root,'.env'));
    const changed=await run('cat .env');expect(changed.ok).toBe(false);expect(changed.output).toContain('layout changed');expect(changed.output).not.toContain('new-secret');
    expect((await run('test ! -s .env')).ok).toBe(true);
    await rename(path.join(root,'.ssh'),path.join(root,'.ssh-old'));await mkdir(path.join(root,'.ssh'));await writeFile(path.join(root,'.ssh','key'),'new-key');
    expect((await run('cat .ssh/key')).output).toContain('layout changed');expect((await run('test -z "$(ls -A .ssh)"')).ok).toBe(true);
  });
});
