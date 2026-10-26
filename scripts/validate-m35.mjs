// Workstation-only M35 validation: refuse aliases/non-D paths before running checks.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [task,stage]=process.argv.slice(2),tasks=['typecheck','focused','full','build','native','browser','python','budget'];
if(process.platform!=='win32'||!tasks.includes(task)||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(stage??''))throw new Error('Explicit Windows M35 task and fresh receipt stage required');
const source=fs.realpathSync.native(process.cwd()),base='D:/CodexData/.codex/worktrees/milestone-35-donly/m35-validation',output=path.join(base,stage);
const d=value=>{const real=fs.realpathSync.native(value);if(path.win32.parse(real).root.toLowerCase()!=='d:\\')throw new Error('Nonphysical-D validation path: '+real);return real;};d(source);
if(fs.existsSync(path.join(output,'environment.json')))throw new Error('Preserve existing receipt and use a fresh stage');
const cache=path.join(base,'cache');
Object.assign(process.env,{TEMP:path.join(base,'temp'),TMP:path.join(base,'temp'),TMPDIR:path.join(base,'temp'),PYTHONUTF8:'1',PYTHONPYCACHEPREFIX:path.join(cache,'python'),npm_config_cache:path.join(cache,'npm'),ELECTRON_CACHE:path.join(cache,'electron'),electron_config_cache:path.join(cache,'electron'),PLAYWRIGHT_BROWSERS_PATH:path.join(cache,'playwright'),ABYSSUS_VITE_CACHE:path.join(cache,'vite'),NODE_COMPILE_CACHE:path.join(cache,'node'),ABYSSUS_WEB_OUTPUT:path.join(output,'web'),ABYSSUS_BUILD_ROOT:path.join(output,'build'),M35_RECEIPTS:path.join(output,'receipts'),M35_UI_OUTPUT:path.join(output,'project-ui'),M35_APP_ROOT:path.join(output,'build/app'),M35_BUDGET_RECEIPT:path.join(output,'budget.json'),M35_BROWSER_BIND:task==='browser'?'1':'0',M35_BROWSER_ONLY:task==='browser'?'1':'0',M35_ELECTRON_EXE:path.join(source,'node_modules/electron/dist/electron.exe')});
const keys=['TEMP','TMP','TMPDIR','PYTHONPYCACHEPREFIX','npm_config_cache','ELECTRON_CACHE','PLAYWRIGHT_BROWSERS_PATH','ABYSSUS_VITE_CACHE','NODE_COMPILE_CACHE','ABYSSUS_WEB_OUTPUT','ABYSSUS_BUILD_ROOT','M35_RECEIPTS','M35_UI_OUTPUT'];
function beforeCreate(target){let current=path.resolve(target);if(path.win32.parse(current).root.toLowerCase()!=='d:\\')throw new Error('Non-D requested output');for(;;){let info;try{info=fs.lstatSync(current);}catch(error){if(error.code!=='ENOENT')throw error;}if(info){if(info.isSymbolicLink()||!info.isDirectory())throw new Error('Output ancestor is a link/reparse/non-directory: '+current);d(current);}const parent=path.dirname(current);if(parent===current)break;current=parent;}}
for(const key of keys)beforeCreate(process.env[key]);beforeCreate(output);
for(const key of keys)fs.mkdirSync(process.env[key],{recursive:true});fs.mkdirSync(output,{recursive:true});
const git=args=>execFileSync('git',args,{cwd:source,env:process.env,encoding:'utf8',windowsHide:true}).trim();
const sha=git(['rev-parse','HEAD']);process.env.M35_SOURCE=sha;
const physical={source:d(source),git:d(path.resolve(source,git(['rev-parse','--git-common-dir']))),dependencies:d(path.join(source,'node_modules'))};for(const key of keys)physical[key]=d(process.env[key]);
const lock=filename=>createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const sourceLock=lock(path.join(source,'package-lock.json')),dependencyLock=lock(path.join(path.dirname(physical.dependencies),'package-lock.json'));if(sourceLock!==dependencyLock)throw new Error('Development dependency lockfile mismatch');
fs.writeFileSync(path.join(output,'environment.json'),JSON.stringify({source:sha,dirty:git(['status','--porcelain']),task,stage,started:new Date().toISOString(),physical,sourceLock,dependencyLock},null,2));
console.log('Verified physical D source/Git/temp/cache/build/receipt roots:',stage);
function run(exe,args){const result=spawnSync(exe,args,{cwd:source,env:process.env,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});const log=(result.stdout??'')+(result.stderr??'');fs.appendFileSync(path.join(output,'commands.log'),log);process.stdout.write(log);if(result.error||result.status!==0)throw new Error('Validation failed: '+path.basename(exe)+' '+args[0]+' ('+result.status+')');}
const node=args=>run(process.execPath,args);
function build(){node(['node_modules/vite/bin/vite.js','build','--configLoader','native']);node(['scripts/desktop-build.mjs']);node(['node_modules/vite/bin/vite.js','build','--configLoader','native','--config','tests/preview-vite.config.ts']);fs.symlinkSync(physical.dependencies,path.join(process.env.M35_APP_ROOT,'node_modules'),'junction');}
try{
 if(task==='typecheck'){node(['node_modules/typescript/bin/tsc','--noEmit']);node(['node_modules/typescript/bin/tsc','-p','desktop/tsconfig.json','--noEmit']);}
 if(task==='focused')node(['node_modules/vitest/vitest.mjs','run','tests/process-jobs.test.ts','tests/container-worker.test.ts','tests/desktop-native-dispatch.test.ts','tests/ui-panels.test.ts','tests/ui-terminal.test.ts','tests/app.test.ts','tests/preview-host.test.ts','tests/desktop-native-state.test.ts']);
 if(task==='full')node(['node_modules/vitest/vitest.mjs','run']);
 if(task==='budget')node(['node_modules/vitest/vitest.mjs','run','tests/preview-budget.test.ts']);
 if(['build','native','browser'].includes(task))build();
 if(['native','browser'].includes(task))node(['--import','tsx','tests/milestone-35-native.ts']);
 if(task==='python')run('python',['-m','unittest','discover','-s','tests','-p','test_worker_*.py','-v']);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({source:sha,task,success:true,finished:new Date().toISOString()},null,2));
}catch(error){fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({source:sha,task,success:false,error:String(error),finished:new Date().toISOString()},null,2));throw error;}
