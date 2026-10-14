import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync, lstatSync, realpathSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { applicationHome, installationRoot, profilePaths } from '../locations.js';
import { hash, key, ToolError, isProtected } from './paths.js';
import { startRegistryProxy } from './registry-proxy.js';
import { helperProtectedPaths } from '../helper-paths.js';

const inside=(parent:string,child:string)=>key(parent)===key(child) || key(child).startsWith(key(parent).replace(/[\\/]$/,'')+path.sep);
const overlap=(a:string,b:string)=>inside(a,b)||inside(b,a);
function canonical(input:string):string {
  try{return realpathSync(input);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=path.dirname(input);if(parent===input)throw error;return path.join(canonical(parent),path.basename(input));}
}
export interface SandboxPolicy { home:string; protectedPaths:string[]; projects:()=>string[] }
export interface SandboxLaunch {file:string;args:string[];env:Record<string,string>;close:()=>Promise<void>}
export class LinuxSandbox {
  private policy:SandboxPolicy={home:applicationHome(),protectedPaths:[],projects:()=>[]};
  configure(policy:SandboxPolicy){this.policy=policy;}
  validateRoot(input:string):string {
    const root=canonical(path.resolve(input));
    if(root.split(path.sep).some(isProtected))throw new ToolError('Credential and Git metadata directories cannot be selected as project roots.','SANDBOX_UNSAFE_PROJECT');
    const protectedPaths=[this.policy.home,installationRoot,path.dirname(path.dirname(realpathSync(process.execPath))),...this.policy.protectedPaths,...(process.platform==='linux'?helperProtectedPaths:[])].map(p=>canonical(path.resolve(p)));
    if([path.parse(root).root,canonical(homedir())].some(p=>inside(root,p)) || protectedPaths.some(p=>overlap(root,p)))throw new ToolError('Project overlaps application, configuration, home or state paths. Select a separate project folder.','SANDBOX_UNSAFE_PROJECT');
    if(process.platform==='linux' && ['/usr','/bin','/sbin','/lib','/lib64','/etc','/proc','/sys','/dev','/run','/mnt','/media','/opt'].some(p=>overlap(root,p)))throw new ToolError('System, mounted Windows and toolchain roots cannot be projects. Select a Linux project folder.','SANDBOX_UNSAFE_PROJECT');
    if(this.policy.projects().map(p=>canonical(path.resolve(p))).some(p=>p!==root && overlap(root,p)))throw new ToolError('Project overlaps another registered project. Select separate project folders.','SANDBOX_UNSAFE_PROJECT');
    return root;
  }
  /** Scan before each command; mount masks enforce existing protected paths.
   * Concurrent trusted host writes introducing secrets/links require stopping
   * execution. This is not a defense against a hostile same-user host process. */
  layout(input:string,git=false):{root:string;masks:{path:string;directory:boolean;identity:string}[];stamp:string} {
    const root=this.validateRoot(input),masks:{path:string;directory:boolean;identity:string}[]=[];
    if(!lstatSync(root).isDirectory() || canonical(root)!==root)throw new ToolError('Project root is not a canonical directory.');
    if(process.platform==='linux') {
      const mounts=readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').map(line=>line.split(' ')[4].replace(/\\([0-7]{3})/g,(_,v:string)=>String.fromCharCode(parseInt(v,8))));
      if(mounts.some(p=>inside(root,p)))throw new ToolError('Mounted project roots or nested mounts are unsupported. Use a plain Linux directory.','SANDBOX_UNSAFE_PROJECT');
    }
    let count=0;
    const visit=(file:string,depth:number)=>{
      if(++count>200_000 || depth>128)throw new ToolError('Sandbox project scan limit exceeded.','SANDBOX_UNSAFE_PROJECT');
      const stat=lstatSync(file),name=path.basename(file);
      if(stat.isSymbolicLink()) {
        if(isProtected(name))throw new ToolError('Protected symlinks are unsupported; replace them with a regular protected file or directory before execution.','SANDBOX_UNSAFE_PROJECT');
        const target=canonical(file);
        if(!inside(root,target) && !(process.platform==='linux' && ['/usr/bin','/usr/lib','/bin','/lib'].some(p=>inside(p,target))))throw new ToolError('External project symlink is unsupported; remove it before execution.','SANDBOX_UNSAFE_PROJECT');
        return;
      }
      if(!stat.isDirectory() && (!stat.isFile() || stat.nlink>1))throw new ToolError('Hardlinks, sockets and special project files are unsupported.','SANDBOX_UNSAFE_PROJECT');
      const protectedName=isProtected(name) && !(git && name==='.git');
      if(file!==root && protectedName){masks.push({path:file,directory:stat.isDirectory(),identity:`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`});return;}
      if(stat.isDirectory())for(const child of readdirSync(file))visit(path.join(file,child),depth+1);
    };
    visit(root,0);
    const identity=lstatSync(root);
    return {root,masks,stamp:hash(JSON.stringify([identity.dev,identity.ino,masks]))};
  }
  storage(root:string):string {
    const base=path.join(profilePaths(this.policy.home).cacheDir,hash(root));
    // Only this exact private project subtree is writable, never its parent.
    for(const dir of [this.policy.home,path.dirname(path.dirname(base)),path.dirname(base),base,path.join(base,'home'),path.join(base,'cache'),path.join(base,'tmp')]) {
      mkdirSync(dir,{recursive:true,mode:0o700});
      if(lstatSync(dir).isSymbolicLink() || canonical(dir)!==path.resolve(dir))throw new ToolError('Sandbox storage contains a link. Repair the private cache directory.','SANDBOX_UNSAFE_STORAGE');
      const info=lstatSync(dir);
      if(process.platform==='linux' && (info.uid!==process.getuid!() || (info.mode&0o077)!==0))throw new ToolError('Sandbox storage must be private and owned by the backend user. Repair its permissions through trusted setup.','SANDBOX_UNSAFE_STORAGE');
    }
    return base;
  }
  reset(root:string):void {
    const canonicalRoot=this.validateRoot(root),base=path.join(profilePaths(this.policy.home).cacheDir,hash(canonicalRoot));
    if(existsSync(base)) {
      if(canonical(base)!==path.resolve(base) || overlap(base,canonicalRoot))throw new ToolError('Unsafe sandbox reset path.');
      rmSync(base,{recursive:true,force:true});
    }
  }
  async launch(root:string,command:string[],network=false,git=false):Promise<SandboxLaunch> {
    if(process.platform!=='linux' || process.getuid?.()===0)throw new ToolError('Sandbox execution requires a non-root Linux/WSL backend with Bubblewrap, user namespaces, socat, bash and Python venv. Host execution is disabled.','SANDBOX_UNAVAILABLE');
    const layout=this.layout(root,git);
    const distro=['/usr/bin','/usr/lib','/usr/lib64','/usr/share/nodejs','/usr/share/git-core','/usr/share/zoneinfo','/usr/share/python-wheels','/usr/share/python3','/etc/ssl/certs'].filter(existsSync);
    const node=realpathSync(process.execPath),npm=path.resolve(path.dirname(node),'../lib/node_modules/npm');
    const sensitive=[this.policy.home,...this.policy.protectedPaths,...this.policy.projects()].map(p=>canonical(path.resolve(p)));
    if([...distro,node,...(existsSync(npm)?[npm]:[])].some(source=>sensitive.some(target=>overlap(canonical(source),target))) || distro.some(source=>overlap(canonical(source),canonical(installationRoot))))throw new ToolError('A read-only toolchain mount overlaps application, configuration or project data. Move that data outside the distro toolchain before execution.','SANDBOX_UNSAFE_PROJECT');
    for(const file of ['/usr/bin/bwrap','/usr/bin/bash','/usr/bin/socat'])if(!existsSync(file))throw new ToolError('Sandbox prerequisites missing: install Bubblewrap, socat, bash and Python venv through trusted setup. Host execution is disabled.','SANDBOX_UNAVAILABLE');
    const base=this.storage(layout.root);
    const policyFiles=path.join(base,'policy');mkdirSync(policyFiles,{mode:0o700,recursive:true});
    if(canonical(policyFiles)!==policyFiles || lstatSync(policyFiles).isSymbolicLink())throw new ToolError('Unsafe private sandbox policy files.');
    const uid=process.getuid!(),gid=process.getgid!();
    for(const [name,content] of [['empty',''],['passwd',`sandbox:x:${uid}:${gid}:Sandbox:/sandbox/home:/bin/bash\n`],['group',`sandbox:x:${gid}:\n`]]) {
      const file=path.join(policyFiles,name);
      if(!existsSync(file))writeFileSync(file,content,{flag:'wx',mode:0o600});
      const info=lstatSync(file);
      if(!info.isFile() || info.nlink!==1 || info.uid!==uid || info.size!==Buffer.byteLength(content) || readFileSync(file,'utf8')!==content)throw new ToolError('Private sandbox policy file identity changed. Reset sandbox storage.');
    }
    const args=['--unshare-all','--unshare-user','--die-with-parent','--new-session','--disable-userns','--cap-drop','ALL','--clearenv'];
    // Distro-managed tools only. No /usr/local, personal prefixes, host /etc,
    // /proc, /sys, /run, network, interop or parent-home bind.
    for(const dir of distro.filter(dir=>dir!=='/etc/ssl/certs'))args.push('--ro-bind',dir,dir);
    // Helper code lives beneath the distro runtime mount but conveys no agent
    // capability. Hide it as well; config/audit/socket are never mounted.
    if(existsSync('/usr/lib/abyssus-helper'))args.push('--tmpfs','/usr/lib/abyssus-helper','--remount-ro','/usr/lib/abyssus-helper');
    for(const [dest,source] of [['/bin','usr/bin'],['/lib','usr/lib'],['/lib64','usr/lib64']])if(existsSync(dest))args.push('--symlink',source,dest);
    // The backend's exact Node binary and adjacent npm distribution; no whole
    // toolcache/personal directory is exposed. Setup owns these trusted files.
    args.push('--ro-bind',node,'/opt/node/bin/node');
    if(existsSync(npm))args.push('--ro-bind',npm,'/opt/node/lib/node_modules/npm','--symlink','../lib/node_modules/npm/bin/npm-cli.js','/opt/node/bin/npm','--symlink','../lib/node_modules/npm/bin/npx-cli.js','/opt/node/bin/npx');
    args.push('--proc','/proc','--dev','/dev','--dir','/etc','--dir','/run','--bind',path.join(base,'home'),'/sandbox/home','--bind',path.join(base,'cache'),'/sandbox/cache','--bind',path.join(base,'tmp'),'/tmp','--bind',layout.root,layout.root);
    args.push('--ro-bind',path.join(policyFiles,'passwd'),'/etc/passwd','--ro-bind',path.join(policyFiles,'group'),'/etc/group');
    for(const mask of layout.masks)args.push(...(mask.directory?['--tmpfs',mask.path,'--remount-ro',mask.path]:['--ro-bind',path.join(policyFiles,'empty'),mask.path]));
    // System trust store is public, immutable policy; never mount all of /etc.
    if(existsSync('/etc/ssl/certs'))args.push('--ro-bind','/etc/ssl/certs','/etc/ssl/certs');
    const env:Record<string,string>={PATH:'/opt/node/bin:/usr/bin:/bin',HOME:'/sandbox/home',XDG_CACHE_HOME:'/sandbox/cache',TMPDIR:'/tmp',LANG:'C.UTF-8',TERM:'dumb',PS1:'',PS2:'',PROMPT_COMMAND:'',NO_COLOR:'1',npm_config_cache:'/sandbox/cache/npm',PIP_CACHE_DIR:'/sandbox/cache/pip',PIP_DISABLE_PIP_VERSION_CHECK:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
    const proxy=network?await startRegistryProxy():undefined;
    if(proxy){args.push('--ro-bind',proxy.directory,'/run/registry');Object.assign(env,{HTTPS_PROXY:'http://127.0.0.1:18080',HTTP_PROXY:'http://127.0.0.1:18080',https_proxy:'http://127.0.0.1:18080',http_proxy:'http://127.0.0.1:18080',NO_PROXY:'',no_proxy:''});}
    for(const [name,value] of Object.entries(env))args.push('--setenv',name,value);
    args.push('--chdir',layout.root,'--');
    if(proxy)args.push('/usr/bin/bash','--noprofile','--norc','-c','/usr/bin/socat TCP4-LISTEN:18080,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/registry/proxy.sock & bridge=$!; for attempt in {1..100}; do if (: > /dev/tcp/127.0.0.1/18080) 2>/dev/null; then exec "$@"; fi; kill -0 "$bridge" 2>/dev/null || exit 125; /usr/bin/sleep .01; done; exit 125','sandbox',...command);
    else args.push(...command);
    return {file:'/usr/bin/bwrap',args,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},close:async()=>{await proxy?.close();}};
  }
}
