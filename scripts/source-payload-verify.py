"""Read-only source payload validation after the bootstrap verified its complete hashes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


def bounded_json(file,limit=16384):
    info=file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>limit:raise ValueError('Invalid metadata file')
    return json.loads(file.read_text(encoding='utf-8-sig'))


def verify(root,source,controller,worker,platform):
    root=Path(root);manifest=root/'SHA256SUMS';info=manifest.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>16*1024**2:raise ValueError('Invalid manifest')
    expected={};folded=set()
    for line in manifest.read_text().splitlines():
        match=re.fullmatch(r'([a-f0-9]{64})  ([^\x00-\x1f\\:]+)',line)
        if not match:raise ValueError('Invalid manifest member')
        digest,name=match.groups();parts=name.split('/')
        if name.startswith('/') or any(p in ('','.','..') or p.endswith((' ','.')) or re.match(r'^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)',p,re.I) for p in parts):raise ValueError('Path alias refused')
        if name.casefold() in folded or len(expected)>=50000:raise ValueError('Collision/member limit')
        folded.add(name.casefold());expected[name]=digest
    seen=set();total=0
    for parent,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            file=Path(parent)/name;info=file.lstat();relative=file.relative_to(root).as_posix()
            if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400:raise ValueError('Runtime reparse/link refused')
            if stat.S_ISDIR(info.st_mode):continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise ValueError('Runtime special/hardlink refused')
            if relative=='SHA256SUMS':continue
            total+=info.st_size
            if total>2*1024**3 or info.st_size>512*1024**2 or relative not in expected:raise ValueError('Runtime inventory/size mismatch')
            digest=hashlib.sha256()
            with file.open('rb') as stream:
                while chunk:=stream.read(1024*1024):digest.update(chunk)
            if digest.hexdigest()!=expected[relative]:raise ValueError('Runtime integrity mismatch')
            if relative.startswith('app/') and (relative.endswith('.node') or '/node-pty/' in relative):raise ValueError('Host native backend dependency in desktop closure')
            seen.add(relative)
    if seen!=set(expected):raise ValueError('Missing runtime member')
    expected_payload={'version':1,'source':source,'controllerImage':controller,'workerImage':worker}
    if bounded_json(root/'app/container-runtime.json')!=expected_payload:raise ValueError('Payload image/source mismatch')
    provenance=bounded_json(root/'provenance.json')
    if any(provenance.get(k)!=v for k,v in {**expected_payload,'platform':platform,'arch':'x64'}.items()):raise ValueError('Provenance binding mismatch')
    support=bounded_json(root/'support-runtime/manifest.json',2*1024**2)
    if support.get('platform')!=platform or support.get('pythonVersion')!='3.13.16':raise ValueError('Private runtime platform mismatch')
    print('Complete source payload and exact source/platform/image bindings verified.')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('root');parser.add_argument('source');parser.add_argument('controller');parser.add_argument('worker');parser.add_argument('platform')
    args=parser.parse_args();verify(args.root,args.source,args.controller,args.worker,args.platform)
