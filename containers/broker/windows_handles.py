"""Native Windows filesystem primitives. No shell/PowerShell path operations.

Parent handles deny delete-sharing for their full lifetime. Every opened object
rejects reparse points; file IDs remain separate from Linux container identities.
"""
import contextlib
import ctypes as C
from ctypes import wintypes as W
from pathlib import Path
import os
import re

if os.name!='nt':raise ImportError('Windows native handles require Windows')
k=C.WinDLL('kernel32',use_last_error=True);a=C.WinDLL('advapi32',use_last_error=True)
HANDLE=W.HANDLE;INVALID=C.c_void_p(-1).value
k.CreateFileW.argtypes=[W.LPCWSTR,W.DWORD,W.DWORD,C.c_void_p,W.DWORD,W.DWORD,HANDLE];k.CreateFileW.restype=HANDLE
k.CloseHandle.argtypes=[HANDLE];k.CloseHandle.restype=W.BOOL
k.GetFileInformationByHandleEx.argtypes=[HANDLE,C.c_int,C.c_void_p,W.DWORD];k.GetFileInformationByHandleEx.restype=W.BOOL
k.GetFinalPathNameByHandleW.argtypes=[HANDLE,W.LPWSTR,W.DWORD,W.DWORD];k.GetFinalPathNameByHandleW.restype=W.DWORD
k.GetVolumeInformationByHandleW.argtypes=[HANDLE,W.LPWSTR,W.DWORD,C.POINTER(W.DWORD),C.POINTER(W.DWORD),C.POINTER(W.DWORD),W.LPWSTR,W.DWORD];k.GetVolumeInformationByHandleW.restype=W.BOOL
k.GetDriveTypeW.argtypes=[W.LPCWSTR];k.GetDriveTypeW.restype=W.UINT
k.GetCurrentProcess.restype=HANDLE
k.FlushFileBuffers.argtypes=[HANDLE];k.FlushFileBuffers.restype=W.BOOL
k.SetFileInformationByHandle.argtypes=[HANDLE,C.c_int,C.c_void_p,W.DWORD];k.SetFileInformationByHandle.restype=W.BOOL
k.LocalFree.argtypes=[C.c_void_p];k.LocalFree.restype=C.c_void_p
class FileId(C.Structure):_fields_=[('volume',C.c_ulonglong),('id',C.c_ubyte*16)]
class AttributeTag(C.Structure):_fields_=[('attributes',W.DWORD),('tag',W.DWORD)]
class Standard(C.Structure):_fields_=[('allocation',C.c_longlong),('size',C.c_longlong),('links',W.DWORD),('deletePending',W.BOOLEAN),('directory',W.BOOLEAN)]
class ACL(C.Structure):_fields_=[('revision',C.c_ubyte),('sbz1',C.c_ubyte),('size',C.c_ushort),('count',C.c_ushort),('sbz2',C.c_ushort)]
a.OpenProcessToken.argtypes=[HANDLE,W.DWORD,C.POINTER(HANDLE)];a.OpenProcessToken.restype=W.BOOL
a.GetTokenInformation.argtypes=[HANDLE,C.c_int,C.c_void_p,W.DWORD,C.POINTER(W.DWORD)];a.GetTokenInformation.restype=W.BOOL
a.ConvertSidToStringSidW.argtypes=[C.c_void_p,C.POINTER(W.LPWSTR)];a.ConvertSidToStringSidW.restype=W.BOOL
a.GetSecurityInfo.argtypes=[HANDLE,C.c_int,W.DWORD,C.POINTER(C.c_void_p),C.POINTER(C.c_void_p),C.POINTER(C.c_void_p),C.POINTER(C.c_void_p),C.POINTER(C.c_void_p)];a.GetSecurityInfo.restype=W.DWORD
a.GetSecurityDescriptorControl.argtypes=[C.c_void_p,C.POINTER(W.WORD),C.POINTER(W.DWORD)];a.GetSecurityDescriptorControl.restype=W.BOOL
a.GetAce.argtypes=[C.c_void_p,W.DWORD,C.POINTER(C.c_void_p)];a.GetAce.restype=W.BOOL
a.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes=[W.LPCWSTR,W.DWORD,C.POINTER(C.c_void_p),C.POINTER(W.DWORD)];a.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype=W.BOOL
a.SetFileSecurityW.argtypes=[W.LPCWSTR,W.DWORD,C.c_void_p];a.SetFileSecurityW.restype=W.BOOL

def ok(value,code):
    if not value:raise OSError(C.get_last_error(),code)

def sid_string(pointer):
    text=W.LPWSTR();ok(a.ConvertSidToStringSidW(pointer,C.byref(text)),'SID_UNAVAILABLE')
    try:return text.value
    finally:k.LocalFree(text)

def current_sid():
    token=HANDLE();ok(a.OpenProcessToken(k.GetCurrentProcess(),8,C.byref(token)),'TOKEN_UNAVAILABLE')
    try:
        needed=W.DWORD();a.GetTokenInformation(token,1,None,0,C.byref(needed));buffer=C.create_string_buffer(needed.value)
        ok(a.GetTokenInformation(token,1,buffer,needed,C.byref(needed)),'TOKEN_UNAVAILABLE')
        return sid_string(C.cast(buffer,C.POINTER(C.c_void_p))[0])
    finally:k.CloseHandle(token)

def native_path(value):
    value=str(value)
    if not re.fullmatch(r'[A-Za-z]:\\[^\x00-\x1f<>"|?*]+',value) or ':' in value[2:] or '/' in value or any(part in ('','.','..') or part.endswith((' ','.')) for part in value[3:].split('\\')):raise ValueError('LOCAL_CANONICAL_PATH_REQUIRED')
    if k.GetDriveTypeW(value[:3])!=3:raise ValueError('LOCAL_FIXED_VOLUME_REQUIRED')
    return value

def canonical(handle):
    buffer=C.create_unicode_buffer(32768);length=k.GetFinalPathNameByHandleW(handle,buffer,len(buffer),0)
    ok(0<length<len(buffer),'PATH_IDENTITY_UNAVAILABLE')
    value=buffer.value
    if not value.startswith('\\\\?\\') or value.startswith('\\\\?\\UNC\\'):raise ValueError('LOCAL_PATH_REQUIRED')
    return value[4:]

def information(handle):
    identity=FileId();attrs=AttributeTag();standard=Standard()
    for kind,value in [(18,identity),(9,attrs),(1,standard)]:ok(k.GetFileInformationByHandleEx(handle,kind,C.byref(value),C.sizeof(value)),'FILE_IDENTITY_UNAVAILABLE')
    if attrs.attributes&0x400 or attrs.tag:raise ValueError('REPARSE_POINT_REFUSED')
    if standard.deletePending or not standard.directory and standard.links!=1:raise ValueError('LINK_OR_DELETION_REFUSED')
    return {'volume':str(identity.volume),'fileId':bytes(identity.id).hex(),'directory':bool(standard.directory),'size':standard.size}

def private_acl(handle,protected_root=False):
    owner=C.c_void_p();dacl=C.c_void_p();descriptor=C.c_void_p()
    result=a.GetSecurityInfo(handle,1,1|4,C.byref(owner),None,C.byref(dacl),None,C.byref(descriptor))
    if result:raise OSError(result,'ACL_UNAVAILABLE')
    try:
        control=W.WORD();revision=W.DWORD()
        ok(a.GetSecurityDescriptorControl(descriptor,C.byref(control),C.byref(revision)),'ACL_CONTROL_UNAVAILABLE')
        if protected_root and not control.value&0x1000:raise ValueError('PROTECTED_ROOT_DACL_REQUIRED')
        user=current_sid()
        if sid_string(owner)!=user or not dacl.value:raise ValueError('PRIVATE_OWNER_REQUIRED')
        acl=C.cast(dacl,C.POINTER(ACL)).contents
        if acl.count>128:raise ValueError('ACL_LIMIT')
        allowed={user,'S-1-5-18','S-1-5-32-544'};user_allowed=False
        for index in range(acl.count):
            pointer=C.c_void_p();ok(a.GetAce(dacl,index,C.byref(pointer)),'ACL_UNAVAILABLE')
            raw=C.string_at(pointer,8);kind,flags=raw[0],raw[1]
            if kind==1:continue # Deny ACEs cannot grant access.
            if kind!=0:raise ValueError('UNSUPPORTED_ACCESS_ACE')
            trustee=sid_string(pointer.value+8)
            if trustee not in allowed:raise ValueError('PRIVATE_DACL_REQUIRED')
            if trustee==user and not flags&8:user_allowed=True
        if not user_allowed:raise ValueError('PRIVATE_DACL_REQUIRED')
        return {'ownerSid':user,'securityControl':control.value,'protected':bool(control.value&0x1000),'aclDigest':__import__('hashlib').sha256(C.string_at(dacl,acl.size)).hexdigest()}
    finally:k.LocalFree(descriptor)

def security_fingerprint(handle):
    owner=C.c_void_p();dacl=C.c_void_p();descriptor=C.c_void_p()
    result=a.GetSecurityInfo(handle,1,1|4,C.byref(owner),None,C.byref(dacl),None,C.byref(descriptor))
    if result:raise OSError(result,'ACL_UNAVAILABLE')
    try:
        control=W.WORD();revision=W.DWORD()
        ok(a.GetSecurityDescriptorControl(descriptor,C.byref(control),C.byref(revision)),'ACL_CONTROL_UNAVAILABLE')
        raw=C.string_at(dacl,C.cast(dacl,C.POINTER(ACL)).contents.size) if dacl.value else b'NULL'
        return __import__('hashlib').sha256(sid_string(owner).encode()+str(control.value).encode()+raw).hexdigest()
    finally:k.LocalFree(descriptor)


class PinnedPath:
    def __init__(self,value,*,write=False,delete=False,create=False,directory=None,share_write=False):
        self.path=native_path(value);self.handles=[]
        try:
            drive=self.path[:3];parts=self.path[3:].split('\\')
            for index in range(len(parts)+1):
                current=drive+'\\'.join(parts[:index]);final=index==len(parts)
                access=0x80|0x20000 # read attributes and security
                if final:access|=(0x40000000 if write else 0x80000000)|(0x10000 if delete else 0)
                share=1|2 if not final or directory or share_write else 1 # no delete-sharing; read files also deny writers
                handle=k.CreateFileW(current,access,share,None,1 if create and final else 3,0x02000000|0x00200000,None)
                if handle==INVALID:raise OSError(C.get_last_error(),'NATIVE_OPEN_REFUSED')
                self.handles.append(handle);details=information(handle)
                if not final and not details['directory']:raise ValueError('PARENT_NOT_DIRECTORY')
                if canonical(handle).casefold()!=current.rstrip('\\').casefold() and canonical(handle).casefold()!=current.casefold():raise ValueError('PATH_ALIAS_REFUSED')
            self.handle=self.handles[-1];self.identity=information(self.handle)
            if directory is not None and self.identity['directory']!=directory:raise ValueError('UNEXPECTED_OBJECT_TYPE')
            fs=C.create_unicode_buffer(32)
            ok(k.GetVolumeInformationByHandleW(self.handle,None,0,None,None,None,fs,len(fs)),'VOLUME_UNAVAILABLE')
            if fs.value!='NTFS':raise ValueError('NTFS_REQUIRED')
        except BaseException:self.close();raise
    def close(self):
        for handle in reversed(self.handles):k.CloseHandle(handle)
        self.handles=[]
    def __enter__(self):return self
    def __exit__(self,*_):self.close()
    def verify(self):
        if information(self.handle)!=self.identity:raise ValueError('OPENED_IDENTITY_CHANGED')
    def private(self,protected_root=False):return {**self.identity,**private_acl(self.handle,protected_root)}

def privatize_empty(value):
    with PinnedPath(value,directory=True) as opened:
        if list(Path(value).iterdir()):raise ValueError('EMPTY_STORAGE_REQUIRED')
        user=current_sid();descriptor=C.c_void_p();size=W.DWORD()
        sddl=f'O:{user}D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
        ok(a.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,1,C.byref(descriptor),C.byref(size)),'PRIVATE_DACL_FAILED')
        try:ok(a.SetFileSecurityW(str(value),4|0x80000000,descriptor),'PRIVATE_DACL_FAILED')
        finally:k.LocalFree(descriptor)
        return opened.private(protected_root=True)

def rename_handle(stage,destination,replace=False):
    destination=native_path(destination)
    with PinnedPath(Path(destination).parent,directory=True) as parent,PinnedPath(stage,delete=True) as source:
        # FILE_RENAME_INFO's variable-length name follows an aligned fixed header.
        class Rename(C.Structure):_fields_=[('replace',W.BOOLEAN),('root',HANDLE),('length',W.DWORD),('name',W.WCHAR*1)]
        name=destination.encode('utf-16le');offset=Rename.name.offset;buffer=C.create_string_buffer(offset+len(name)+2)
        header=C.cast(buffer,C.POINTER(Rename)).contents;header.replace=replace;header.root=None;header.length=len(name)
        C.memmove(C.addressof(buffer)+offset,name,len(name))
        if not k.SetFileInformationByHandle(source.handle,3,buffer,len(buffer)):
            error=C.get_last_error()
            if error in (80,183):raise FileExistsError(error,'DESTINATION_EXISTS')
            raise OSError(error,'NO_REPLACE_PUBLICATION_FAILED')
        source.verify()

def publish_new(stage,destination):
    return rename_handle(stage,destination,replace=False)


class NativeStorageGuard:
    """Host-held NTFS evidence; never rebuilt from controller-supplied proof."""
    slots={'state':'state','config':'config','workspace':'workspace','control':'runtime/control'}
    def __init__(self,root):
        self.stack=contextlib.ExitStack()
        try:
            self.root=self.stack.enter_context(PinnedPath(root,directory=True))
            self.root_proof=self.root.private(protected_root=True)
            self.ancestors=[(h,information(h),security_fingerprint(h)) for h in self.root.handles]
            self.pins={name:self.stack.enter_context(PinnedPath(Path(root)/relative,directory=True)) for name,relative in self.slots.items()}
            self.evidence={name:pin.private() for name,pin in self.pins.items()}
            if len({(v['volume'],v['fileId']) for v in self.evidence.values()})!=4:raise ValueError('STORAGE_SLOT_ALIAS')
        except BaseException:self.stack.close();raise
    def verify(self):
        if self.root.private(protected_root=True)!=self.root_proof:raise ValueError('NATIVE_STORAGE_CHANGED')
        for handle,identity,security in self.ancestors:
            if information(handle)!=identity or security_fingerprint(handle)!=security:raise ValueError('NATIVE_ANCESTOR_CHANGED')
        for name,pin in self.pins.items():
            pin.verify()
            if pin.private()!=self.evidence[name]:raise ValueError('NATIVE_SLOT_CHANGED')
        return {'root':self.root_proof,'slots':self.evidence}
    def close(self):self.stack.close()
    def __enter__(self):return self
    def __exit__(self,*_):self.close()


class Overlapped(C.Structure):
    _fields_=[('internal',C.c_size_t),('internalHigh',C.c_size_t),('offset',W.DWORD),('offsetHigh',W.DWORD),('event',HANDLE)]

@contextlib.contextmanager
def exclusive_lock(file,wait=False):
    """One native host lock class; no claim of cross-OS SQLite locking."""
    file=Path(file)
    try:
        with PinnedPath(file,write=True,create=True,directory=False,share_write=True):pass
    except OSError as error:
        if error.errno not in (80,183):raise
    k.LockFileEx.argtypes=[HANDLE,W.DWORD,W.DWORD,W.DWORD,W.DWORD,C.POINTER(Overlapped)];k.LockFileEx.restype=W.BOOL
    k.UnlockFileEx.argtypes=[HANDLE,W.DWORD,W.DWORD,W.DWORD,C.POINTER(Overlapped)];k.UnlockFileEx.restype=W.BOOL
    with PinnedPath(file,write=True,directory=False,share_write=True) as pin:
        pin.private();overlapped=Overlapped()
        if not k.LockFileEx(pin.handle,2|(0 if wait else 1),0,1,0,C.byref(overlapped)):
            error=C.get_last_error()
            if error in (33,158):raise BlockingIOError(error,'NATIVE_LOCK_BUSY')
            raise OSError(error,'NATIVE_LOCK_FAILED')
        try:yield
        finally:ok(k.UnlockFileEx(pin.handle,0,1,0,C.byref(overlapped)),'NATIVE_UNLOCK_FAILED')
