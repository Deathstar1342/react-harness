/** Actual relocated private runtime, hostile cwd/environment and complete manifest. */
import assert from 'node:assert/strict';
import { cpSync,mkdirSync,mkdtempSync,writeFileSync,readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { supportRuntime } from '../desktop/support-runtime.js';
const source=process.env.M31_SUPPORT_RUNTIME,out=process.env.M31_RECEIPTS;
if(!source||!out)throw new Error('Explicit external runtime/receipt paths required');
const base=mkdtempSync(path.join(path.dirname(source),'runtime-relocation-')),root=path.join(base,'relocated'),cwd=path.join(base,'hostile');
cpSync(source,root,{recursive:true});mkdirSync(cwd);mkdirSync(out,{recursive:true});
for(const name of ['sqlite3.py','ssl.py','ctypes.py','zlib.py','sitecustomize.py'])writeFileSync(path.join(cwd,name),'raise RuntimeError("HOSTILE_MODULE_LOADED")\n');
writeFileSync(path.join(cwd,'m31-dll-search-probe.dll'),'deliberately invalid DLL');
const executable=supportRuntime(root),entry=path.resolve(import.meta.dirname,'../containers/broker/support_entry.py');
const code=`import runpy,sys,os,json
entry=runpy.run_path(sys.argv[1],run_name='m31_probe')
entry['confine_dll_search']()
import sqlite3,ssl,ctypes,zlib
if os.name=='nt':
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.LoadLibraryExW.argtypes=[ctypes.c_wchar_p,ctypes.c_void_p,ctypes.c_ulong]
    kernel.LoadLibraryExW.restype=ctypes.c_void_p
    assert not kernel.LoadLibraryExW('m31-dll-search-probe.dll',None,0)
    assert ctypes.get_last_error()==126, 'cwd DLL was searched'
assert sys.flags.isolated
if os.name=='nt':assert sys.flags.no_site
assert not any(os.path.abspath(p)==os.getcwd() for p in sys.path if p)
print(json.dumps({'isolated':True,'noSite':bool(sys.flags.no_site),'imports':True,'cwdDllExcluded':os.name=='nt'}))`;
const result=spawnSync(executable,['-I','-B','-c',code,entry],{cwd,env:{...process.env,PYTHONPATH:cwd,PYTHONHOME:cwd,PYTHONSTARTUP:path.join(cwd,'sitecustomize.py'),NODE_OPTIONS:'--invalid-hostile-option',PATH:cwd},encoding:'utf8',timeout:30000});
assert.equal(result.status,0,result.stderr);const evidence=JSON.parse(result.stdout);
const manifest=JSON.parse(readFileSync(path.join(root,'manifest.json'),'utf8'));
writeFileSync(path.join(out,'support-runtime-relocation.json'),JSON.stringify({platform:process.platform,pythonVersion:manifest.pythonVersion,files:Object.keys(manifest.files).length,...evidence,scope:'actual relocated private runtime; not a clean-machine or Docker Desktop test'},null,2));
console.log('PASS relocated private runtime imports and hostile cwd/environment exclusion');
