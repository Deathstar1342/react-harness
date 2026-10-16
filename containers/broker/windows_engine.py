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
from protocol import require
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

class WindowsEngine:
    def __init__(self,storage,storage_id,source,context,engine_id,worker_image):
        require(os.name=='nt','WINDOWS_ENGINE_REQUIRED')
        require(re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',context),'INVALID_ENGINE_CONTEXT')
        require(type(worker_image) is str and re.fullmatch('sha256:[a-f0-9]{64}',worker_image),'INVALID_WORKER_IMAGE')
        self.storage=Path(storage);self.storage_id=storage_id;self.source=Path(source);self.context=context;self.engine_id=engine_id;self.image=worker_image
        self.guard=None;self.project_mapper=None;self.uid=1000;self.gid=1000 # Linux execution identity, never a native NTFS ownership claim.
        binary=program_files()/'Docker/Docker/resources/bin/docker.exe';self.cli=PinnedPath(binary,directory=False)
        try:
            trusted={'S-1-5-18','S-1-5-32-544',trusted_installer_sid()}
            # The held known-folder subtree cannot be renamed/replaced during use.
            first=len(program_files().parts)-1
            for handle in self.cli.handles[first:]:trusted_program_acl(handle,trusted)
            self.fingerprints=[security_fingerprint(handle) for handle in self.cli.handles]
            self.env={name:os.environ[name] for name in ('SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP') if name in os.environ}
            self.env['PATH']=str(binary.parent)+os.pathsep+str(Path(self.env['SystemRoot'])/'System32')
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
    def bind_project_mapping(self,binding,session,workspace):
        require(self.project_mapper is None,'PROJECT_MAPPING_ALREADY_BOUND')
        from project_identity import ProjectIdentity
        self.project_mapper=ProjectIdentity(self,binding,session,workspace)
    def project_identity(self,project):
        require(self.project_mapper is not None,'PROJECT_MAPPING_REQUIRED')
        return self.project_mapper.observe(project)
    def storage_barrier(self):
        require(self.guard is not None,'NATIVE_STORAGE_NOT_BOUND');self.guard.verify()
    def close(self):self.cli.close()
