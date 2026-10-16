"""Narrow descriptor operations used by transfers, with native Windows pins.

No global os monkey-patching and no synthesized uid/mode security claims. Private
ownership is checked explicitly by private_fd/private_path (DACL on Windows).
Windows directory fsync is unavailable; file flush and atomic rename are used,
matching the application's existing Windows durable-write contract. This is not
an assertion of POSIX directory-fsync or mixed-OS SQLite lock equivalence.
"""
import contextlib
import os
from pathlib import Path
import stat

if os.name=='nt':
    import ctypes as C
    from ctypes import wintypes as W
    import msvcrt
    from windows_handles import PinnedPath,information,k,publish_new
    k.DuplicateHandle.argtypes=[W.HANDLE,W.HANDLE,W.HANDLE,C.POINTER(W.HANDLE),W.DWORD,W.BOOL,W.DWORD];k.DuplicateHandle.restype=W.BOOL
    class FileStream:
        def __init__(self,owner,fd,*args,**kwargs):self.owner=owner;self.fd=fd;self.stream=os.fdopen(fd,*args,closefd=False,**kwargs)
        def __getattr__(self,name):return getattr(self.stream,name)
        def __enter__(self):return self
        def __exit__(self,*args):self.close()
        def close(self):
            try:self.stream.close()
            finally:
                if self.fd is not None:self.owner.close(self.fd);self.fd=None
    class NativeIO:
        O_DIRECTORY=0x10000000;O_NOFOLLOW=0x20000000;O_NONBLOCK=0
        def __init__(self):self.handles={};self.refs={}
        def __getattr__(self,name):return getattr(os,name)
        def path_for(self,value,dir_fd=None):
            if isinstance(value,int):return self.handles[value].path
            return str(Path(self.handles[dir_fd].path)/value) if dir_fd is not None else str(value)
        def open(self,value,flags,mode=0o600,*,dir_fd=None):
            name=self.path_for(value,dir_fd);directory=bool(flags&self.O_DIRECTORY)
            write=bool(flags&(os.O_WRONLY|os.O_RDWR));create=bool(flags&os.O_CREAT)
            if create and not flags&os.O_EXCL and Path(name).exists():create=False
            pin=PinnedPath(name,write=write,create=create,directory=directory)
            duplicate=W.HANDLE()
            try:
                if not k.DuplicateHandle(k.GetCurrentProcess(),pin.handle,k.GetCurrentProcess(),C.byref(duplicate),0,False,2):raise OSError(C.get_last_error(),'HANDLE_DUPLICATION_FAILED')
                fd=msvcrt.open_osfhandle(duplicate.value,os.O_BINARY|(os.O_RDWR if write else os.O_RDONLY));self.handles[fd]=pin;self.refs[id(pin)]=1
                return fd
            except BaseException:
                if duplicate.value:k.CloseHandle(duplicate)
                pin.close();raise
        def close(self,fd):
            try:os.close(fd)
            finally:
                pin=self.handles.pop(fd,None)
                if pin:
                    self.refs[id(pin)]-=1
                    if self.refs[id(pin)]==0:del self.refs[id(pin)];pin.close()
        def dup(self,fd):
            duplicate=os.dup(fd);pin=self.handles[fd];self.handles[duplicate]=pin;self.refs[id(pin)]+=1;return duplicate
        def fdopen(self,fd,*args,**kwargs):return FileStream(self,fd,*args,**kwargs)
        def stat(self,value,*,dir_fd=None,follow_symlinks=True):
            name=self.path_for(value,dir_fd)
            with PinnedPath(name) as pin:
                result=os.stat(name,follow_symlinks=False)
                if str(result.st_dev)!=pin.identity['volume'] or result.st_ino!=int.from_bytes(bytes.fromhex(pin.identity['fileId']),'little'):raise ValueError('NATIVE_STAT_IDENTITY_CHANGED')
                return result
        def fstat(self,fd):return os.fstat(fd)
        def scandir(self,fd):return os.scandir(self.path_for(fd))
        def listdir(self,fd):return os.listdir(self.path_for(fd))
        def mkdir(self,name,mode=0o700,*,dir_fd=None):os.mkdir(self.path_for(name,dir_fd),mode)
        def unlink(self,name,*,dir_fd=None):os.unlink(self.path_for(name,dir_fd))
        def replace(self,source,destination,*,src_dir_fd=None,dst_dir_fd=None):
            from windows_handles import rename_handle
            rename_handle(self.path_for(source,src_dir_fd),self.path_for(destination,dst_dir_fd),replace=True)
        def fsync(self,fd):
            pin=self.handles.get(fd)
            if pin and pin.identity['directory']:return # Explicit Windows contract above; never used as a Linux probe result.
            os.fsync(fd)
        def utime(self,fd,*,ns):
            # SetFileTime operates on the already opened output, without reopening a path.
            class FileTime(C.Structure):_fields_=[('low',W.DWORD),('high',W.DWORD)]
            def convert(value):
                ticks=value//100+116444736000000000;return FileTime(ticks&0xffffffff,ticks>>32)
            access,modified=convert(ns[0]),convert(ns[1])
            k.SetFileTime.argtypes=[W.HANDLE,C.c_void_p,C.c_void_p,C.c_void_p];k.SetFileTime.restype=W.BOOL
            if not k.SetFileTime(self.handles[fd].handle,None,C.byref(access),C.byref(modified)):raise OSError(C.get_last_error(),'FILE_TIME_FAILED')
        def fchmod(self,fd,mode):os.chmod(self.path_for(fd),mode&0o600)
    fs=NativeIO()
else:fs=os

@contextlib.contextmanager
def root_handle(root):
    if os.name=='nt':
        fd=fs.open(str(root),fs.O_RDONLY|fs.O_DIRECTORY|fs.O_NOFOLLOW)
        try:yield fd
        finally:fs.close(fd)
    else:
        root=str(root)
        if not root.startswith('/') or os.path.normpath(root)!=root or root=='/':raise ValueError('UNSAFE_ROOT')
        fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
        try:
            for name in root.split('/')[1:]:
                new=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=new
            yield fd
        finally:os.close(fd)

def private_fd(fd):
    if os.name=='nt':fs.handles[fd].private();return
    info=os.fstat(fd)
    if info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError('PRIVATE_OWNERSHIP_REQUIRED')

def private_path(value):
    if os.name=='nt':
        with PinnedPath(value) as pin:pin.private()
    else:
        info=Path(value).lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError('PRIVATE_OWNERSHIP_REQUIRED')
