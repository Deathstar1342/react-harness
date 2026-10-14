/** Reproducible data-only .deb scaffold; no maintainer scripts or host mutation. */
import { mkdir, cp, writeFile, symlink, readdir, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { manifest } from './package-manifest.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),stage=root+'build/helper-stage';
if(process.platform!=='linux'||process.arch!=='x64')throw new Error('Build helper scaffold on target Linux x64 distro');
const code=stage+'/usr/lib/abyssus-helper';
await rm(stage,{recursive:true,force:true});
await mkdir(code+'/python',{recursive:true});await mkdir(code+'/empty-apt-config',{recursive:true});await mkdir(stage+'/DEBIAN',{recursive:true});
const notices=stage+'/usr/share/doc/abyssus-helper-staging';await mkdir(notices,{recursive:true});
await cp(root+'helper/launcher.c',notices+'/launcher.c');
execFileSync('/usr/bin/cc',['-O2','-Wall','-Wextra','-Werror','-c',root+'helper/launcher.c','-o',notices+'/launcher.o'],{stdio:'inherit'});
execFileSync('/usr/bin/cc',['-static',notices+'/launcher.o','-o',code+'/launcher'],{stdio:'inherit'});
await cp('/usr/share/doc/libc6/copyright',notices+'/glibc-copyright');
await writeFile(notices+'/BUILD.txt','Relink the supplied launcher source/object with your compatible libc: cc -static launcher.o -o launcher\n'+execFileSync('/usr/bin/cc',['--version'],{encoding:'utf8'})+'\n'+execFileSync('/usr/bin/dpkg-query',['-W','-f=${Package} ${Version}\\n','libc6','libc6-dev'],{encoding:'utf8'})+'\nUbuntu provides the matching glibc source through its source repositories (apt source glibc). Final redistribution review must retain the library notice and corresponding-source availability.\n');
for(const file of ['core.py','service.py','admin.py','apt_adapter.py','apt.conf','abyssus-helper.service'])await cp(root+'helper/'+file,code+'/'+file);
const modules=(await readdir('/usr/lib/python3/dist-packages')).filter(name=>/^apt_(pkg|inst)\..*\.so$/.test(name));
if(modules.length!==2)throw new Error('Exactly one distro apt ABI is required');
for(const name of ['apt',...modules])await symlink('/usr/lib/python3/dist-packages/'+name,code+'/python/'+name);
await writeFile(stage+'/DEBIAN/control','Package: abyssus-helper-staging\nVersion: 0.1.0\nArchitecture: amd64\nMaintainer: abysSUS contributors\nDepends: python3, python3-apt, acl, systemd, pkexec\nDescription: Trusted optional helper staging (no automatic service setup)\n');
if(process.argv.includes('--release')) {
  await writeFile(stage+'/DEBIAN/control',(await readFile(stage+'/DEBIAN/control','utf8')).replace('Depends: ','Depends: abyssus-backend (= 0.1.0), '));
  const guard=await readFile(root+'packaging/maintenance.py','utf8');
  await mkdir(stage+'/usr/share/abyssus',{recursive:true});
  await writeFile(stage+'/usr/share/abyssus/helper-manifest.json',JSON.stringify(await manifest(code)));
  for(const [name,operation] of [['preinst','begin'],['prerm','begin'],['postinst','finish']])await writeFile(stage+'/DEBIAN/'+name,guard.replace('sys.argv[1]',JSON.stringify(operation)).replace('sys.argv[2]',"'helper'"),{mode:0o755});
  await writeFile(stage+'/DEBIAN/postrm','#!/bin/sh\nset -eu\ncase "$1" in remove|purge) exec /usr/bin/python3 -I /usr/lib/abyssus/maintenance.py finish helper;; esac\n',{mode:0o755});
}
execFileSync('/usr/bin/dpkg-deb',['--root-owner-group','--build',stage,root+'build/abyssus-helper-staging.deb'],{stdio:'inherit',env:{...process.env,SOURCE_DATE_EPOCH:'1791849600'}});
console.log('Data-only helper staging scaffold built. Installation requires explicit OS administrator authorization.');
