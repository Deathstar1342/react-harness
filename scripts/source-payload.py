"""Trusted container build: complete relocatable source desktop payload, no host installation."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import urllib.request
import zipfile


def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def sha(file):return hashlib.sha256(file.read_bytes()).hexdigest()


def build(platform,source,controller,worker):
    if platform not in ('linux','win32'):raise ValueError('Unsupported target')
    root=Path('/payload');app=root/'app';checkout=Path('/src')
    load('stage-container-runtime').stage(app,source,controller,worker)
    # Build-only npm command links are not part of the runnable desktop closure.
    # Never alter project dependency links or a user's package-manager behavior.
    for directory in app.rglob('.bin'):
        if directory.is_dir() and 'node_modules' in directory.parts:shutil.rmtree(directory)
    support=load('stage-support-runtime')
    Path('/downloads').mkdir(exist_ok=True)
    package=json.loads((checkout/'node_modules/electron/package.json').read_text())
    version=package['version'];name=f'electron-v{version}-{platform}-x64.zip'
    digest=json.loads((checkout/'node_modules/electron/checksums.json').read_text())[name]
    archive=Path('/downloads')/name
    url=f'https://github.com/electron/electron/releases/download/v{version}/{name}'
    with urllib.request.urlopen(url,timeout=90) as response,archive.open('xb') as output:
        total=0
        while chunk:=response.read(1024*1024):
            total+=len(chunk)
            if total>256*1024**2:raise ValueError('Electron archive limit')
            output.write(chunk)
    if sha(archive)!=digest:raise ValueError('Electron checksum mismatch; payload retained')
    destination=root/'electron';destination.mkdir();seen=set();total=0
    with zipfile.ZipFile(archive) as bundle:
        for item in bundle.infolist():
            relative=support.member(item.filename,seen)
            if stat.S_ISLNK(item.external_attr>>16):raise ValueError('Electron archive link refused')
            total+=item.file_size
            if total>1024*1024**2 or item.file_size>512*1024**2:raise ValueError('Electron expanded size limit')
            target=destination.joinpath(*relative.parts)
            if item.is_dir():target.mkdir(parents=True,exist_ok=True);continue
            target.parent.mkdir(parents=True,exist_ok=True)
            with bundle.open(item) as src,target.open('xb') as dst:shutil.copyfileobj(src,dst,1024*1024)
            target.chmod(0o755 if item.external_attr>>16&0o111 else 0o644)
    provenance={'version':1,'source':source,'platform':platform,'arch':'x64','controllerImage':controller,'workerImage':worker,
      'buildBase':'node:24.16.0-bookworm@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7',
      'lockSHA256':sha(checkout/'package-lock.json'),'electron':{'version':version,'url':url,'sha256':digest,'checksumSource':'locked electron npm package checksums.json'},
      'supportRuntime':'support-runtime/provenance.json','supportBase':'ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401','targetExecutionVerified':False}
    (root/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
    (root/'SOURCE-NOTICE.txt').write_text('The project source snapshot has no root project license. No new project license is granted by this source build. Upstream runtime and dependency licenses remain in their respective payload directories. Redistribution review remains an explicit packaging gate.\n')
    files=[]
    for file in sorted(root.rglob('*')):
        if file.is_symlink():raise ValueError('Source payload links are refused')
        if file.is_dir():continue
        if not file.is_file() or file.stat().st_nlink!=1:raise ValueError('Source payload special/hardlinked file')
        relative=file.relative_to(root).as_posix()
        if any(ord(c)<32 for c in relative) or '\\' in relative:raise ValueError('Unrepresentable payload path')
        files.append(sha(file)+'  '+relative+'\n')
    if len(files)>100000:raise ValueError('Source payload member limit')
    (root/'SHA256SUMS').write_text(''.join(files),encoding='utf8',newline='\n')
    print('Complete source payload exported. Target execution, OS libraries and engine acceptance are separate checks.')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--platform',required=True);parser.add_argument('--source',required=True)
    parser.add_argument('--controller',required=True);parser.add_argument('--worker',required=True)
    args=parser.parse_args();build(args.platform,args.source,args.controller,args.worker)
