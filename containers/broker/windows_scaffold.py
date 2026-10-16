"""Explicit fresh Windows storage scaffold with durable interruption refusal."""
from pathlib import Path
import uuid
from protocol import exact,require,UUID
from transfer_service import private_json,write_new
from windows_handles import PinnedPath,privatize_empty,NativeStorageGuard,rename_handle

class WindowsScaffold:
    def __init__(self,root,storage_id,launch_id):
        require(UUID.fullmatch(storage_id) and UUID.fullmatch(launch_id),'INVALID_NATIVE_SETUP')
        self.root=Path(root);self.storage_id=storage_id;self.launch_id=launch_id;self.file=self.root/'.native-setup.json';self.guard=None
    def save(self,phase):
        value={'version':1,'storageId':self.storage_id,'launchId':self.launch_id,'phase':phase}
        temporary=self.root/('.native-setup-'+str(uuid.uuid4())+'.pending');write_new(temporary,value);rename_handle(temporary,self.file,replace=True)
    def begin(self,checkpoint=lambda _:None):
        with PinnedPath(self.root,directory=True):
            require(not list(self.root.iterdir()),'EMPTY_NATIVE_STORAGE_REQUIRED')
            privatize_empty(self.root)
            # Published before creating slot directories or running a container.
            write_new(self.file,{'version':1,'storageId':self.storage_id,'launchId':self.launch_id,'phase':'intent'})
            checkpoint('intent')
            for name in ['state','config','workspace','runtime','runtime/control','runtime/probes']:(self.root/name).mkdir()
            for name in ['state','config','workspace']:
                marker=self.root/name/'.storage-id'
                with PinnedPath(marker,write=True,create=True,directory=False) as pin:
                    import ctypes as C
                    from windows_handles import k,W,ok
                    data=(self.storage_id+'\n').encode();written=W.DWORD();k.WriteFile.argtypes=[W.HANDLE,C.c_void_p,W.DWORD,C.POINTER(W.DWORD),C.c_void_p];k.WriteFile.restype=W.BOOL
                    buffer=C.create_string_buffer(data);ok(k.WriteFile(pin.handle,buffer,len(data),C.byref(written),None),'STORAGE_MARKER_WRITE_FAILED');require(written.value==len(data),'STORAGE_MARKER_WRITE_FAILED');ok(k.FlushFileBuffers(pin.handle),'STORAGE_MARKER_FLUSH_FAILED')
            self.guard=NativeStorageGuard(self.root);self.guard.verify();self.save('scaffold');checkpoint('scaffold')
            return self.guard
    def profile_started(self):
        require(self.guard is not None,'NO_NATIVE_SCAFFOLD');self.guard.verify();self.save('profile-intent')
    def finish(self,checkpoint=lambda _:None):
        require(self.guard is not None,'NO_NATIVE_SCAFFOLD');self.guard.verify()
        journal=private_json(self.file,2048);require(journal=={'version':1,'storageId':self.storage_id,'launchId':self.launch_id,'phase':'profile-intent'},'NATIVE_SETUP_CHANGED')
        receipt=private_json(self.root/'state/container-storage.json',2048)
        exact(receipt,['version','storageId','profileId','kind'])
        require(type(receipt['version']) is int and receipt['version']==1 and receipt['storageId']==self.storage_id and UUID.fullmatch(receipt['profileId']) and receipt['kind']=='local-bind','NATIVE_PROFILE_UNVERIFIED')
        self.save('profile-verified');checkpoint('profile-verified')
        # Marker commit comes last; reply loss never allows repeating initialization.
        from native_io import fs
        marker=self.root/'.storage-id';fd=fs.open(str(marker),fs.O_WRONLY|fs.O_CREAT|fs.O_EXCL|fs.O_NOFOLLOW)
        try:
            data=(self.storage_id+'\n').encode();require(fs.write(fd,data)==len(data),'STORAGE_MARKER_WRITE_FAILED');fs.fsync(fd)
        finally:fs.close(fd)
        checkpoint('root-marker');self.save('committed');checkpoint('committed')
    def close(self):
        if self.guard:self.guard.close();self.guard=None

def verify_committed_scaffold(root,storage_id):
    journal=private_json(Path(root)/'.native-setup.json',2048);exact(journal,['version','storageId','launchId','phase'])
    require(type(journal['version']) is int and journal['version']==1 and journal['storageId']==storage_id and UUID.fullmatch(journal['launchId']) and journal['phase']=='committed','NATIVE_SETUP_INCOMPLETE')
    require((Path(root)/'.storage-id').read_text()==storage_id+'\n','STORAGE_CHANGED')
