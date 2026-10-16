"""Pin the exact already staged native runtime/source for retained supervision."""
import contextlib
import hashlib
import json
from pathlib import Path
import re
import sys
from protocol import exact,require,HEX
from windows_handles import PinnedPath

class NativePayload:
    def __init__(self,source,expected):
        require(type(expected) is str and HEX.fullmatch(expected),'INVALID_RUNTIME_DIGEST');self.stack=contextlib.ExitStack()
        try:
            root=Path(sys.executable).parent;file=root/'manifest.json'
            self.stack.enter_context(PinnedPath(root,directory=True))
            self.stack.enter_context(PinnedPath(file,directory=False));raw=file.read_bytes();require(len(raw)<=2*1024**2 and hashlib.sha256(raw).hexdigest()==expected,'NATIVE_RUNTIME_CHANGED')
            manifest=json.loads(raw);exact(manifest,['version','pythonVersion','platform','arch','executable','files'])
            require(type(manifest['version']) is int and manifest['version']==1 and manifest['pythonVersion']=='3.13.16' and manifest['platform']=='win32' and manifest['arch']=='x64' and manifest['executable']=='python.exe','NATIVE_RUNTIME_CHANGED')
            require(type(manifest['files']) is dict and 0<len(manifest['files'])<=20000,'NATIVE_RUNTIME_CHANGED');found=set();total=0;count=0
            def visit(directory):
                nonlocal count,total
                for item in directory.iterdir():
                    count+=1;require(count<=20000,'NATIVE_RUNTIME_LIMIT');pin=self.stack.enter_context(PinnedPath(item))
                    if pin.identity['directory']:visit(item);continue
                    relative=item.relative_to(root).as_posix();total+=pin.identity['size'];require(pin.identity['size']<=64*1024**2 and total<=512*1024**2,'NATIVE_RUNTIME_LIMIT')
                    if relative=='manifest.json':continue
                    require(relative in manifest['files'] and type(manifest['files'][relative]) is str and HEX.fullmatch(manifest['files'][relative]) and hashlib.sha256(item.read_bytes()).hexdigest()==manifest['files'][relative],'NATIVE_RUNTIME_CHANGED');found.add(relative)
            visit(root);require(found==set(manifest['files']) and 'python.exe' in found,'NATIVE_RUNTIME_CHANGED')
            source=Path(source);self.stack.enter_context(PinnedPath(source,directory=True));files=sorted((source/'containers/broker').glob('*.py'));require(1<=len(files)<=128,'NATIVE_SOURCE_LIMIT')
            for file in files:self.stack.enter_context(PinnedPath(file,directory=False))
            # Keep every independently source-attested worker/helper input pinned
            # for this retained lifetime too; they never execute on the host.
            for name in ('containers/worker-runner.py','containers/worker-bridge.py','containers/container-apt.py','helper/apt_adapter.py','helper/core.py'):
                self.stack.enter_context(PinnedPath(source/name,directory=False))
            self.source_digest=hashlib.sha256(b''.join(file.name.encode()+b'\0'+file.read_bytes() for file in files)).hexdigest();self.runtime_digest=expected
        except BaseException:self.stack.close();raise
    def close(self):self.stack.close()
