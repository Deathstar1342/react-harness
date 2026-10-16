import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import sys

@unittest.skipUnless(os.name=='nt','Windows native handles')
class NativeHandles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root=Path(__file__).resolve().parents[1]/'containers/broker'
        sys.path.insert(0,str(root));import windows_handles
        cls.native=windows_handles
    def setUp(self):
        self.root=Path(tempfile.mkdtemp(prefix='m31-native-',dir=os.environ.get('M31_TEST_ROOT'))).resolve()
    def test_opened_parent_cannot_be_renamed_and_file_identity_is_stable(self):
        file=self.root/'file.txt';file.write_text('fixture')
        with self.native.PinnedPath(file,directory=False) as handle:
            self.assertEqual(handle.identity['size'],7)
            self.assertRegex(handle.identity['fileId'],r'^[a-f0-9]{32}$')
            with self.assertRaises(OSError):os.rename(self.root,self.root.with_name(self.root.name+'-renamed'))
            with self.assertRaises(OSError):file.write_text('changed')
            handle.verify()
    def test_private_acl_is_proved_after_explicit_empty_folder_initialization(self):
        proof=self.native.privatize_empty(self.root)
        self.assertRegex(proof['ownerSid'],r'^S-1-')
        self.assertRegex(proof['aclDigest'],r'^[a-f0-9]{64}$')
        (self.root/'state').mkdir()
        with self.native.PinnedPath(self.root/'state',directory=True) as handle:self.assertEqual(handle.private()['ownerSid'],proof['ownerSid'])
        with self.assertRaises(ValueError):self.native.privatize_empty(self.root)
    def test_native_no_replace_publication_retains_source_on_collision(self):
        stage=self.root/'stage';stage.mkdir();(stage/'file').write_text('contents')
        destination=self.root/'destination';destination.mkdir()
        with self.assertRaises(OSError):self.native.publish_new(stage,destination)
        self.assertTrue((stage/'file').is_file());destination.rmdir()
        self.native.publish_new(stage,destination)
        self.assertFalse(stage.exists());self.assertEqual((destination/'file').read_text(),'contents')
    def test_actual_bounded_transfer_preserves_dirty_files_and_exclusions(self):
        from transfers import scan,copy,verify_stage,publish
        source=self.root/'source';source.mkdir();(source/'hello.txt').write_text('edited bytes');(source/'node_modules').mkdir();(source/'node_modules/ignored').write_text('cache')
        manifest=scan(source);self.assertEqual(manifest['bytes'],12);self.assertEqual(manifest['excluded'][0]['path'],'node_modules')
        stage=self.root/'stage';copy(source,stage,manifest);identity=verify_stage(stage,manifest)
        publish(stage,self.root/'destination',identity)
        self.assertEqual((self.root/'destination/hello.txt').read_text(),'edited bytes');self.assertEqual((source/'hello.txt').read_text(),'edited bytes')

    def set_acl(self,path,sddl,protected=True):
        n=self.native;descriptor=n.C.c_void_p();size=n.W.DWORD()
        n.ok(n.a.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,1,n.C.byref(descriptor),n.C.byref(size)),'TEST_ACL_FAILED')
        try:n.ok(n.a.SetFileSecurityW(str(path),4|(0x80000000 if protected else 0x20000000),descriptor),'TEST_ACL_FAILED')
        finally:n.k.LocalFree(descriptor)
    def test_protected_root_and_inherited_private_children_have_distinct_policy(self):
        self.native.privatize_empty(self.root);child=self.root/'child';child.mkdir()
        with self.native.PinnedPath(self.root,directory=True) as root:self.assertTrue(root.private(protected_root=True)['protected'])
        with self.native.PinnedPath(child,directory=True) as pin:
            self.assertFalse(pin.private()['protected'])
            with self.assertRaisesRegex(ValueError,'PROTECTED_ROOT'):pin.private(protected_root=True)
    def test_broad_inherited_and_null_dacls_are_refused(self):
        user=self.native.current_sid()
        self.set_acl(self.root,f'O:{user}D:P(A;OICI;FA;;;{user})(A;OICI;FR;;;WD)')
        child=self.root/'child';child.mkdir()
        with self.native.PinnedPath(child,directory=True) as pin:
            with self.assertRaisesRegex(ValueError,'PRIVATE_DACL'):pin.private()
        self.set_acl(self.root,f'O:{user}D:NO_ACCESS_CONTROL')
        with self.native.PinnedPath(self.root,directory=True) as pin:
            with self.assertRaisesRegex(ValueError,'PRIVATE_OWNER'):pin.private()
    def test_slot_acl_change_invalidates_held_storage_guard(self):
        self.native.privatize_empty(self.root)
        for name in ['state','config','workspace','runtime/control']:(self.root/name).mkdir(parents=True)
        with self.native.NativeStorageGuard(self.root) as guard:
            guard.verify();user=self.native.current_sid()
            self.set_acl(self.root/'config',f'O:{user}D:P(A;OICI;FA;;;{user})(A;OICI;FR;;;WD)')
            with self.assertRaises(ValueError):guard.verify()
    def test_changes_after_manifest_are_refused_without_replay(self):
        from transfers import scan,copy
        for kind in ['write','mtime','replace']:
            with self.subTest(kind=kind):
                source=self.root/kind;source.mkdir();file=source/'file';file.write_text('initial')
                manifest=scan(source)
                if kind=='write':file.write_text('changed')
                elif kind=='mtime':os.utime(file,ns=(file.stat().st_atime_ns,file.stat().st_mtime_ns+1000000000))
                else:
                    old=source.with_name(kind+'-old');source.rename(old);source.mkdir();(source/'file').write_text('initial')
                with self.assertRaises(Exception):copy(source,self.root/(kind+'-stage'),manifest)
                self.assertFalse((self.root/(kind+'-destination')).exists())
    def test_junction_is_refused_without_following_it(self):
        import struct
        n=self.native;target=self.root/'target';target.mkdir();junction=self.root/'junction';junction.mkdir()
        substitute=('\\??\\'+str(target)).encode('utf-16le');display=str(target).encode('utf-16le')
        names=substitute+b'\0\0'+display+b'\0\0'
        data=struct.pack('<IHHHHHH',0xA0000003,8+len(names),0,0,len(substitute),len(substitute)+2,len(display))+names
        handle=n.k.CreateFileW(str(junction),0x40000000,3,None,3,0x02200000,None)
        self.assertNotEqual(handle,n.INVALID)
        n.k.DeviceIoControl.argtypes=[n.HANDLE,n.W.DWORD,n.C.c_void_p,n.W.DWORD,n.C.c_void_p,n.W.DWORD,n.C.POINTER(n.W.DWORD),n.C.c_void_p];n.k.DeviceIoControl.restype=n.W.BOOL
        try:
            buffer=n.C.create_string_buffer(data);returned=n.W.DWORD();n.ok(n.k.DeviceIoControl(handle,0x000900A4,buffer,len(data),None,0,n.C.byref(returned),None),'TEST_JUNCTION_FAILED')
        finally:n.k.CloseHandle(handle)
        with self.assertRaisesRegex(ValueError,'REPARSE'):self.native.PinnedPath(junction,directory=True)


    def test_modified_file_stat_and_fstat_measure_same_held_handle_fields(self):
        from native_io import fs
        from transfers import stamp
        file=self.root/'modified';file.write_text('before');file.write_text('after')
        # Explicitly move last-write time to distinguish creation/change fields.
        os.utime(file,ns=(file.stat().st_atime_ns,file.stat().st_mtime_ns+1000000000))
        by_path=fs.stat(str(file));fd=fs.open(str(file),fs.O_RDONLY|fs.O_NOFOLLOW)
        try:self.assertEqual(stamp(by_path),stamp(fs.fstat(fd)))
        finally:fs.close(fd)


    def test_native_private_records_and_lineage_lock_are_shared_and_exclusive(self):
        from transfer_service import write_new,private_json,lineage_lock,save_lineage
        self.native.privatize_empty(self.root)
        write_new(self.root/'record',{'version':1})
        self.assertEqual(private_json(self.root/'record'),{'version':1})
        with lineage_lock(self.root):
            with self.assertRaisesRegex(Exception,'TRANSFER_LINEAGE_BUSY'):
                with lineage_lock(self.root):pass
        with lineage_lock(self.root):save_lineage(self.root,{'roots':[]})
        self.assertEqual(private_json(self.root/'origins.json'),{'roots':[]})


    def test_actual_native_sqlite_wal_blocks_second_process_and_reopens(self):
        from sqlite_probe import probe_native
        self.native.privatize_empty(self.root)
        self.assertEqual(probe_native(self.root,'f'*64),{'wal':True,'secondWriterDenied':True,'reopened':True})
        with self.assertRaises(Exception):probe_native(self.root,'f'*64)


    def test_native_adapter_inventory_is_read_only_and_never_nominates_wildcard(self):
        from windows_network import windows_adapters,candidates
        rows=windows_adapters();self.assertIsInstance(rows,list)
        self.assertTrue(all(v['bind']!='0.0.0.0' for v in candidates(rows)))


    def test_private_descendant_acl_not_inferred_from_parent(self):
        self.native.privatize_empty(self.root)
        for name in ['state','config','workspace','runtime/control']:(self.root/name).mkdir(parents=True)
        file=self.root/'config/provider';file.write_text('placeholder')
        with self.native.NativeStorageGuard(self.root) as guard:
            guard.verify();user=self.native.current_sid()
            self.set_acl(file,f'O:{user}D:P(A;;FA;;;{user})(A;;FR;;;WD)')
            with self.assertRaisesRegex(ValueError,'PRIVATE_DACL'):guard.verify()

    def test_hardlinks_and_nonlocal_paths_are_rejected(self):
        file=self.root/'file';file.write_text('x');os.link(file,self.root/'hardlink')
        with self.assertRaises(ValueError):self.native.PinnedPath(file,directory=False)
        for value in ['D:relative',r'\\server\share\file',r'D:\x\..\y',r'D:\x:stream']:
            with self.assertRaises(ValueError):self.native.native_path(value)

if __name__=='__main__':unittest.main()
