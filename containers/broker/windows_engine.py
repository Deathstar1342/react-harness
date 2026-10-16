"""Fixed locally installed Docker Desktop CLI; no PATH search or host shell."""
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid
from protocol import require,digest,UUID
from docker_runtime import Docker,PROTECTED
from windows_handles import PinnedPath,k,a,ACL,ok,sid_string,security_fingerprint

def program_files():
    shell=C.WinDLL('shell32');ole=C.WinDLL('ole32')
    shell.SHGetKnownFolderPath.argtypes=[C.c_void_p,W.DWORD,W.HANDLE,C.POINTER(W.LPWSTR)];shell.SHGetKnownFolderPath.restype=C.c_long
    ole.CoTaskMemFree.argtypes=[C.c_void_p]
    guid=C.create_string_buffer(uuid.UUID('905e63b6-c1bf-494e-b29c-65b732d3d21a').bytes_le);result=W.LPWSTR()
    require(shell.SHGetKnownFolderPath(guid,0,None,C.byref(result))==0,'PROGRAM_FILES_UNAVAILABLE')
    try:return Path(result.value)
    finally:ole.CoTaskMemFree(result)

def trusted_installer_sid():
    a.LookupAccountNameW.argtypes=[W.LPCWSTR,W.LPCWSTR,C.c_void_p,C.POINTER(W.DWORD),W.LPWSTR,C.POINTER(W.DWORD),C.POINTER(W.DWORD)];a.LookupAccountNameW.restype=W.BOOL
    size=W.DWORD();domain_size=W.DWORD();kind=W.DWORD()
    a.LookupAccountNameW(None,r'NT SERVICE\TrustedInstaller',None,C.byref(size),None,C.byref(domain_size),C.byref(kind))
    require(0<size.value<=1024 and domain_size.value<=256,'TRUSTED_INSTALLER_UNAVAILABLE')
    sid=C.create_string_buffer(size.value);domain=C.create_unicode_buffer(domain_size.value)
    ok(a.LookupAccountNameW(None,r'NT SERVICE\TrustedInstaller',sid,C.byref(size),domain,C.byref(domain_size),C.byref(kind)),'TRUSTED_INSTALLER_UNAVAILABLE')
    return sid_string(sid)

def trusted_program_acl(handle,trusted):
    owner=C.c_void_p();dacl=C.c_void_p();descriptor=C.c_void_p()
    result=a.GetSecurityInfo(handle,1,1|4,C.byref(owner),None,C.byref(dacl),None,C.byref(descriptor))
    if result:raise OSError(result,'DOCKER_ACL_UNAVAILABLE')
    try:
        require(sid_string(owner) in trusted and dacl.value,'UNTRUSTED_DOCKER_OWNER')
        acl=C.cast(dacl,C.POINTER(ACL)).contents;require(acl.count<=128,'DOCKER_ACL_LIMIT')
        for index in range(acl.count):
            pointer=C.c_void_p();ok(a.GetAce(dacl,index,C.byref(pointer)),'DOCKER_ACL_UNAVAILABLE');raw=C.string_at(pointer,8);kind,flags=raw[0],raw[1]
            if kind==1 or flags&8:continue
            require(kind==0,'UNSUPPORTED_DOCKER_ACE')
            mask=int.from_bytes(raw[4:8],'little')
            require(not mask&0x500d0156 or sid_string(pointer.value+8) in trusted,'WRITABLE_DOCKER_INSTALL')
    finally:k.LocalFree(descriptor)

def fixed_cli():
    binary=program_files()/'Docker/Docker/resources/bin/docker.exe';pin=PinnedPath(binary,directory=False)
    try:
        trusted={'S-1-5-18','S-1-5-32-544',trusted_installer_sid()}
        for handle in pin.handles[len(program_files().parts)-1:]:trusted_program_acl(handle,trusted)
        fingerprints=[security_fingerprint(handle) for handle in pin.handles]
        env={name:os.environ[name] for name in ('SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP') if name in os.environ}
        env['PATH']=str(binary.parent)+os.pathsep+str(Path(env['SystemRoot'])/'System32')
        return pin,fingerprints,env
    except BaseException:pin.close();raise


def fixed_engine_query(args):
    require(type(args) is list and all(type(v) is str for v in args),'INVALID_ENGINE_QUERY')
    valid=args==['context','show']
    if len(args)==5 and args[:2]==['context','inspect'] and args[3:]==['--format','{{.Endpoints.docker.Host}}']:valid=bool(re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',args[2]))
    if len(args)==5 and args[0]=='--context' and args[2:]==['info','--format','{{json .}}']:valid=bool(re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',args[1]))
    require(valid,'FIXED_ENGINE_QUERY_ONLY');pin,fingerprints,env=fixed_cli()
    try:
        pin.verify();require([security_fingerprint(h) for h in pin.handles]==fingerprints,'DOCKER_INSTALL_CHANGED')
        result=subprocess.run([pin.path,*args],cwd=str(Path(pin.path).parent),env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=12,creationflags=subprocess.CREATE_NO_WINDOW)
        require(result.returncode==0 and len(result.stdout.encode())<=256*1024,'ENGINE_QUERY_FAILED');return result.stdout
    finally:pin.close()


class WindowsEngine(Docker):
    def __init__(self,storage,storage_id,source,context,engine_id,worker_image):
        require(os.name=='nt','WINDOWS_ENGINE_REQUIRED')
        require(re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',context),'INVALID_ENGINE_CONTEXT')
        require(type(worker_image) is str and re.fullmatch('sha256:[a-f0-9]{64}',worker_image),'INVALID_WORKER_IMAGE')
        self.storage=Path(storage);self.storage_id=storage_id;self.source=Path(source);self.context=context;self.engine_id=engine_id;self.image=worker_image
        self.guard=None;self.project_mapper=None;self.authority=None;self.uid=1000;self.gid=1000 # Linux execution identity, never a native NTFS ownership claim.
        self.cli,self.fingerprints,self.env=fixed_cli()
        try:
            self.source_digest=hashlib.sha256(b''.join(file.name.encode()+b'\0'+file.read_bytes() for file in sorted((self.source/'containers/broker').glob('*.py')))).hexdigest()
            self.verify_engine()
            require(self.call(['image','inspect',worker_image,'--format','{{.Id}}']).strip()==worker_image,'WORKER_IMAGE_CHANGED')
        except BaseException:self.cli.close();raise
    def argv(self,args):
        self.cli.verify()
        require([security_fingerprint(handle) for handle in self.cli.handles]==self.fingerprints,'DOCKER_INSTALL_CHANGED')
        return [self.cli.path,'--context',self.context,*args]
    def call(self,args,timeout=30,input=None):
        readonly=args[:2] in (['context','inspect'],['image','inspect']) or args[:1]==['info']
        if not readonly:self.storage_barrier()
        result=subprocess.run(self.argv(args),cwd=str(Path(self.cli.path).parent),env=self.env,input=input,stdin=subprocess.DEVNULL if input is None else None,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout,creationflags=subprocess.CREATE_NO_WINDOW)
        require(result.returncode==0,'ENGINE_OPERATION_FAILED');require(len(result.stdout.encode())<=2*1024*1024,'ENGINE_REPLY_LIMIT');return result.stdout
    def verify_engine(self):
        endpoint=self.call(['context','inspect',self.context,'--format','{{.Endpoints.docker.Host}}']).strip()
        require(endpoint in ('npipe:////./pipe/docker_engine','npipe:////./pipe/dockerDesktopLinuxEngine','npipe://./pipe/docker_engine','npipe://./pipe/dockerDesktopLinuxEngine'),'LOCAL_DESKTOP_ENGINE_REQUIRED')
        info=json.loads(self.call(['info','--format','{{json .}}']))
        require(info['ID']==self.engine_id and info['OSType']=='linux' and info['Architecture'] in ('amd64','x86_64'),'ENGINE_CHANGED')
        require(not any('rootless' in value or 'userns' in value for value in info.get('SecurityOptions',[])),'UNSUPPORTED_UID_MAPPING')
    def attach(self,guard):
        require(self.guard is None,'NATIVE_ENGINE_ALREADY_BOUND');guard.verify();self.guard=guard
        from resources import Resources
        self.resources=Resources(self)
    def activate_workers(self):
        from attestation import Attestor
        from socket_egress import SocketEgress
        self.storage_barrier();self.resources.recover()
        self.egress=SocketEgress(self);self.egress.recover();self.egress.start()
        self.attestor=Attestor(self);self.contexts={};self.images={}
        self.blank=self.storage/'runtime/worker-mask'
        if not self.blank.exists():
            with PinnedPath(self.blank,write=True,create=True,directory=False) as pin:pin.private()
        with PinnedPath(self.blank,directory=False) as pin:
            pin.private();require(pin.identity['size']==0,'UNSAFE_MASK')
    def egress_mount(self):return self.egress.worker_mount()
    def process_options(self):return {'creationflags':subprocess.CREATE_NO_WINDOW,'cwd':str(Path(self.cli.path).parent)}
    def prepare_cache(self,project_id):
        require(type(project_id) is str and re.fullmatch('[a-f0-9]{64}',project_id),'INVALID_CACHE_ID')
        self.storage_barrier();cache=self.storage/'runtime/dependencies'/project_id
        for directory in (cache.parent,cache,cache/'home',cache/'cache'):
            directory.mkdir(exist_ok=True)
            with PinnedPath(directory,directory=True) as pin:pin.private()
        return cache
    def topology(self,project,git=False):
        require(type(project) is str and UUID.fullmatch(project),'INVALID_MANAGED_PROJECT')
        self.storage_barrier();root=self.storage/'workspace'/project;masks=[];count=0
        with PinnedPath(root,directory=True) as project_pin:
            identity=dict(project_pin.identity)
            def visit(file,depth):
                nonlocal count
                count+=1;require(count<=200000 and depth<=128,'TOPOLOGY_LIMIT')
                with PinnedPath(file) as pin:
                    directory=pin.identity['directory']
                    if file!=root and PROTECTED.search(file.name) and not (git and file.name=='.git'):
                        masks.append({'path':file.relative_to(root).as_posix(),'directory':directory,'inode':pin.identity['volume']+':'+pin.identity['fileId']});return
                    if directory:
                        for child in file.iterdir():visit(child,depth+1)
            visit(root,0)
            if git:
                with PinnedPath(root/'.git',directory=True):pass
                require(not (root/'.git/commondir').exists(),'EXTERNAL_GIT')
            project_pin.verify();self.storage_barrier()
        project_id=digest([self.storage_id,project,identity['volume'],identity['fileId']])
        return root,masks,{'storageId':self.storage_id,'projectId':project_id,'imageId':self.images.get(project_id,self.image),'layout':digest(masks)}
    def bind_project_mapping(self,binding,session,workspace):
        require(self.project_mapper is None,'PROJECT_MAPPING_ALREADY_BOUND')
        from project_identity import ProjectIdentity
        self.project_mapper=ProjectIdentity(self,binding,session,workspace)
    def project_identity(self,project):
        require(self.project_mapper is not None,'PROJECT_MAPPING_REQUIRED')
        return self.project_mapper.observe(project)
    def storage_barrier(self):
        require(self.guard is not None,'NATIVE_STORAGE_NOT_BOUND')
        if self.authority:self.authority()
        else:self.guard.verify()
    def close_engine(self):self.cli.close()
