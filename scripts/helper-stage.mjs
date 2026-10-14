/** Reproducible data-only .deb scaffold; no maintainer scripts or host mutation. */
import { mkdir, cp, writeFile, symlink, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),stage=root+'build/helper-stage';
if(process.platform!=='linux'||process.arch!=='x64')throw new Error('Build helper scaffold on target Linux x64 distro');
const code=stage+'/usr/lib/abyssus-helper';
await mkdir(code+'/python',{recursive:true});await mkdir(code+'/empty-apt-config',{recursive:true});await mkdir(stage+'/DEBIAN',{recursive:true});
execFileSync('/usr/bin/cc',['-O2','-Wall','-Wextra','-Werror','-static',root+'helper/launcher.c','-o',code+'/launcher'],{stdio:'inherit'});
for(const file of ['core.py','service.py','admin.py','apt_adapter.py','apt.conf','abyssus-helper.service'])await cp(root+'helper/'+file,code+'/'+file);
const modules=(await readdir('/usr/lib/python3/dist-packages')).filter(name=>/^apt_(pkg|inst)\..*\.so$/.test(name));
if(modules.length!==2)throw new Error('Exactly one distro apt ABI is required');
for(const name of ['apt',...modules])await symlink('/usr/lib/python3/dist-packages/'+name,code+'/python/'+name);
await writeFile(stage+'/DEBIAN/control','Package: abyssus-helper-staging\nVersion: 0.1.0\nArchitecture: amd64\nMaintainer: abysSUS contributors\nDepends: python3, python3-apt, acl, systemd, pkexec\nDescription: M20 trusted helper staging scaffold (no automatic service setup)\n');
execFileSync('/usr/bin/dpkg-deb',['--root-owner-group','--build',stage,root+'build/abyssus-helper-staging.deb'],{stdio:'inherit',env:{...process.env,SOURCE_DATE_EPOCH:'1791849600'}});
console.log('Data-only helper staging scaffold built. Installation requires explicit OS administrator authorization.');
