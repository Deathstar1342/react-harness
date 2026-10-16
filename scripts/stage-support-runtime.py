"""Build-time private CPython staging. No workstation installation or customer pip.

Output and downloads must be outside the repository. Failed staging is preserved.
Linux compilation belongs in disposable Ubuntu 24.04 CI, not workstation setup.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
VERSION='3.13.16'
WIN_SHA='97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297'
SOURCE_SHA='f4b1bfb3c79b5bb11b8d228a12504163b4c0dab4d679828d8f5f26b6cb6ab35d'
RELEASE='https://www.python.org/downloads/release/python-31316/'

def require(value,message):
    if not value:raise RuntimeError(message)

def outside(value):
    target=Path(value).absolute();source=Path(__file__).resolve().parents[1]
    require(target.resolve()==target and target!=source and source not in target.parents and target not in source.parents,'Staging must be canonical and outside source')
    return target

def download(url,file,digest,limit):
    if not file.exists():
        with urllib.request.urlopen(url,timeout=60) as response,file.open('xb') as out:
            require(response.url.startswith('https://www.python.org/ftp/python/'),'Unexpected download origin')
            count=0
            while True:
                data=response.read(1024*1024)
                if not data:break
                count+=len(data);require(count<=limit,'Download limit exceeded');out.write(data)
    require(file.stat().st_size<=limit and hashlib.sha256(file.read_bytes()).hexdigest()==digest,'Payload SHA256 mismatch; failed file retained')

def member(name,seen):
    require(name and '\\' not in name and not name.startswith('/') and not any(ord(c)<32 for c in name),'Unsafe archive path')
    value=PurePosixPath(name)
    require(all(part not in ('','..','.') and ':' not in part for part in name.rstrip('/').split('/')),'Unsafe archive component')
    folded=name.rstrip('/').casefold();require(folded not in seen,'Archive collision');seen.add(folded)
    require(len(seen)<=30000 and len(name)<=1024,'Archive limit exceeded')
    return value

def stage(output,downloads):
    require(not output.exists(),'Output already exists; inspect it instead of overwriting')
    downloads.mkdir(parents=True,exist_ok=True)
    output.mkdir(parents=True)
    provenance={'version':VERSION,'release':RELEASE,'license':'PSF-2.0 and bundled dependency notices','sourceURL':f'https://www.python.org/ftp/python/{VERSION}/Python-{VERSION}.tar.xz','sourceSHA256':SOURCE_SHA,'platform':sys.platform}
    if sys.platform=='win32':
        name=f'python-{VERSION}-embed-amd64.zip';url=f'https://www.python.org/ftp/python/{VERSION}/{name}'
        archive=downloads/name;download(url,archive,WIN_SHA,32*1024**2)
        seen=set();total=0
        with zipfile.ZipFile(archive) as bundle:
            for item in bundle.infolist():
                relative=member(item.filename,seen)
                require(not stat.S_ISLNK(item.external_attr>>16) and not item.is_dir() and len(relative.parts)==1,'Unexpected embedded member')
                total+=item.file_size;require(item.file_size<=64*1024**2 and total<=256*1024**2,'Expanded payload limit')
                with bundle.open(item) as src,(output/item.filename).open('xb') as dst:
                    shutil.copyfileobj(src,dst,1024*1024)
        (output/'python313._pth').write_text('python313.zip\n.\n',encoding='utf8')
        executable='python.exe';provenance.update(payloadURL=url,payloadSHA256=WIN_SHA,sbomURL=url+'.spdx.json',externalLibraries=['Windows system DLLs only; packaged DLL inventory retained'])
    else:
        require(sys.platform=='linux' and os.environ.get('CI')=='true','Linux compilation requires disposable CI')
        archive=downloads/f'Python-{VERSION}.tar.xz';download(provenance['sourceURL'],archive,SOURCE_SHA,40*1024**2)
        source=downloads/('cpython-build-'+VERSION);require(not source.exists(),'Prior source build exists; preserve it and choose fresh download area')
        source.mkdir();seen=set();total=0
        with tarfile.open(archive,'r:xz') as bundle:
            for item in bundle:
                relative=member(item.name,seen);require(relative.parts[0]=='Python-'+VERSION,'Unexpected source root')
                require(item.isdir() or item.isfile(),'Source links/special entries are not extracted')
                total+=item.size;require(item.size<=64*1024**2 and total<=512*1024**2,'Expanded source limit')
                target=source.joinpath(*relative.parts[1:])
                if item.isdir():target.mkdir(parents=True,exist_ok=True)
                else:
                    target.parent.mkdir(parents=True,exist_ok=True)
                    with bundle.extractfile(item) as src,target.open('xb') as dst:shutil.copyfileobj(src,dst,1024*1024)
                    target.chmod(item.mode&0o755)
        configure=['./configure','--prefix='+str(output),'--with-ensurepip=no','--disable-test-modules']
        env={k:v for k,v in os.environ.items() if not k.startswith(('PYTHON','LD_'))}
        with (downloads/'python-build.log').open('x') as log:
            for command in (configure,['make','-j2'],['make','install']):subprocess.run(command,cwd=source,env=env,check=True,stdout=log,stderr=subprocess.STDOUT)
        for file in output.rglob('*'):
            if file.is_symlink():
                target=file.resolve();require(output in target.parents and target.is_file(),'External runtime symlink');data=target.read_bytes();mode=target.stat().st_mode;file.unlink();file.write_bytes(data);file.chmod(mode)
        shutil.copyfile(source/'LICENSE',output/'LICENSE')
        executable='bin/python3.13'
        provenance.update(configure=configure,compiler=subprocess.check_output(['cc','--version'],text=True),externalLibraries=subprocess.check_output(['ldd',str(output/executable)],text=True))
    (output/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
    files={};total=0
    for file in sorted(output.rglob('*')):
        require(not file.is_symlink(),'Runtime symlinks are unsupported')
        if file.is_file():
            total+=file.stat().st_size;require(total<=512*1024**2 and len(files)<20000,'Runtime inventory limit')
            files[file.relative_to(output).as_posix()]=hashlib.sha256(file.read_bytes()).hexdigest()
    manifest={'version':1,'pythonVersion':VERSION,'platform':sys.platform,'arch':'x64','executable':executable,'files':files}
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    env={k:v for k,v in os.environ.items() if not k.startswith(('PYTHON','LD_'))}
    subprocess.run([str(output/executable),'-I','-B','-c','import sqlite3,ssl,ctypes,zlib; print("Bundled runtime imports verified")'],cwd=output,env=env,check=True)
    print('Staged private support runtime; no global interpreter was installed.')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--downloads',required=True);args=parser.parse_args()
    stage(outside(args.output),outside(args.downloads))
