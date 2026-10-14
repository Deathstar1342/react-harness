import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),stage=path.join(root,'build/desktop-app');
// Fixed generated directory only. Never package a checkout or a runtime profile.
await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
for(const name of ['desktop','server','shared','dist'])await cp(path.join(root,'build/app',name),path.join(stage,name),{recursive:true});
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
await writeFile(path.join(stage,'release.json'),JSON.stringify({source:sha,target:'ubuntu-24.04-x64'}));
await writeFile(path.join(stage,'package.json'),JSON.stringify({name:'abyssus-desktop',version:pkg.version,description:'abysSUS desktop workspace',author:'abysSUS contributors',type:'module',main:'desktop/entry.cjs',dependencies:pkg.dependencies}));
// Resolve the exact lock closure without invoking native rebuilds or install hooks.
await cp(path.join(root,'package-lock.json'),path.join(stage,'package-lock.json'));
const original=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));delete original.devDependencies;delete original.optionalDependencies;
await writeFile(path.join(stage,'package.json'),JSON.stringify({...original,name:pkg.name,main:'desktop/entry.cjs',description:'abysSUS desktop workspace',author:'abysSUS contributors'}));
execFileSync(process.platform==='win32'?'npm.cmd':'npm',['ci','--omit=dev','--omit=optional','--ignore-scripts','--no-audit','--no-fund'],{cwd:stage,stdio:'inherit',shell:process.platform==='win32'});
await mkdir(path.join(root,'build/bundled'),{recursive:true});
await cp(path.join(root,'docs/installer-setup.md'),path.join(root,'build/bundled/SETUP.md'));
console.log('Desktop package allowlist staged; no runtime profile or developer tools.');
