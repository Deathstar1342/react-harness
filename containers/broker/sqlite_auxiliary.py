"""Metadata-only finite SQLite auxiliary observation; default pins stay strict."""
import ctypes as C
from ctypes import wintypes as W
from pathlib import Path
from protocol import require
from windows_handles import k,INVALID,FileId,AttributeTag,Standard,ok,canonical,private_acl,object_identity,native_path

SUFFIXES=('-journal','-wal','-shm')


def stable(pin):
    current=object_identity(pin.handle)
    require(all(current[key]==pin.identity[key] for key in ('volume','fileId','directory')),'PRIVATE_ANCHOR_CHANGED')
    pin.private()


def metadata(handle):
    identity=FileId();attrs=AttributeTag();info=Standard()
    for kind,value in ((18,identity),(9,attrs),(1,info)):ok(k.GetFileInformationByHandleEx(handle,kind,C.byref(value),C.sizeof(value)),'SQLITE_AUXILIARY_METADATA_FAILED')
    require(not attrs.attributes&0x400 and not attrs.tag and not info.directory,'SQLITE_AUXILIARY_TYPE')
    require(info.links in (0,1),'SQLITE_AUXILIARY_LINKS')
    return {'volume':str(identity.volume),'fileId':bytes(identity.id).hex(),'links':info.links,'deleting':bool(info.deletePending)}


def observe_auxiliary(main,parent,suffix,checkpoint=lambda:None):
    require(suffix in SUFFIXES and not main.identity['directory'] and parent.identity['directory'] and main.path.endswith('.sqlite') and Path(main.path).parent==Path(parent.path),'SQLITE_AUXILIARY_CLASS')
    stable(main);stable(parent);file=native_path(main.path+suffix)
    # Only this derived auxiliary leaf permits deletion. Ancestors, main DB,
    # ordinary private records, source and workspace handles retain old policy.
    handle=k.CreateFileW(file,0x80|0x20000,1|2|4,None,3,0x02000000|0x00200000,None)
    if handle==INVALID:
        error=C.get_last_error()
        if error in (2,3):stable(main);stable(parent);return 'absent'
        raise OSError(error,'SQLITE_AUXILIARY_OPEN_FAILED')
    try:
        before=metadata(handle);require(before['volume']==main.identity['volume'],'SQLITE_AUXILIARY_VOLUME');private_acl(handle)
        require(before['links']==1 or before['deleting'],'SQLITE_AUXILIARY_DETACHED')
        if not before['deleting']:require(canonical(handle).casefold()==file.casefold(),'SQLITE_AUXILIARY_ALIAS')
        checkpoint()
        after=metadata(handle);require(all(after[key]==before[key] for key in ('volume','fileId')),'SQLITE_AUXILIARY_CHANGED');private_acl(handle)
        stable(main);stable(parent)
        if after['deleting'] or before['links']==1 and after['links']==0:return 'absent'
        require(after['links']==1,'SQLITE_AUXILIARY_DETACHED');require(canonical(handle).casefold()==file.casefold(),'SQLITE_AUXILIARY_ALIAS');return 'present'
    finally:k.CloseHandle(handle)
