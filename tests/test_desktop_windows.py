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
        with self.native.PinnedPath(self.root/'state',directory=True) as handle:self.assertIn(handle.private()['ownerSid'],{proof['ownerSid'],'S-1-5-18','S-1-5-32-544'})
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

    def test_native_transfer_maps_linux_identity_and_retains_published_uncertainty(self):
        import time,uuid
        from protocol import Journal
        from server import Broker
        from transfer_service import area,write_new,select,authorize
        for failure in ('none','lost-publication-probe','changed-redemption'):
            with self.subTest(failure=failure):
                base=self.root/failure;base.mkdir();storage=base/'storage';storage.mkdir();self.native.privatize_empty(storage)
                for name in ('runtime','runtime/control','workspace'):(storage/name).mkdir()
                storage_id=str(uuid.uuid4());(storage/'.storage-id').write_text(storage_id+'\n')
                journal=Journal(str(storage/'runtime/journal.sqlite'),str(uuid.uuid4()))
                class Docker:
                    contexts={};images={};calls=0
                    def storage_barrier(self):pass
                    def project_identity(self,project):
                        self.calls+=1
                        if failure=='lost-publication-probe':raise TimeoutError()
                        return {'project':project,'sessionId':journal.session,'identity':['55','99' if failure=='changed-redemption' and self.calls>1 else '66']}
                docker=Docker();docker.storage=storage;docker.storage_id=storage_id;broker=Broker(journal,docker)
                area(storage);broker.transfers.verify_journal();write_new(storage/'runtime/control/session.json',{'storageId':storage_id,'sessionId':journal.session})
                source=base/'original';source.mkdir();(source/'file').write_text('original');install=base/'install';install.mkdir()
                try:
                    # Local mandated D fixtures live beneath .codex. Limit this fixture-only
                    # ancestor policy substitution to selection; production policy stays strict.
                    from unittest.mock import patch
                    from transfer_service import NEVER
                    with patch('transfer_service.NEVER',NEVER-{'.codex'}):token,ticket=select(storage,storage_id,install,'import',source)
                    authorize(storage,token,ticket)
                    broker.dispatch('transfer_begin',{'code':token,'kind':'import','project':None})
                    end=time.monotonic()+10
                    while True:
                        result=broker.dispatch('transfer_observe',{'code':token})
                        if result['phase'] not in ('copying','publishing'):break
                        self.assertLess(time.monotonic(),end);time.sleep(.01)
                    self.assertEqual((Path(ticket['destination'])/'file').read_text(),'original')
                    self.assertEqual((source/'file').read_text(),'original')
                    self.assertNotIn('nativeIdentity',result);self.assertNotIn('linuxMapping',result)
                    if failure=='lost-publication-probe':
                        self.assertEqual(result['phase'],'uncertain',result);self.assertTrue(result['residue']);self.assertIsNone(result['identity'])
                        with self.assertRaises(Exception):broker.dispatch('transfer_receipt',{'code':token})
                    else:
                        self.assertEqual(result['phase'],'succeeded',result);self.assertEqual(result['identity'],['55','66'])
                        if failure=='changed-redemption':
                            with self.assertRaisesRegex(Exception,'MAPPING_CHANGED'):broker.dispatch('transfer_receipt',{'code':token})
                            calls=docker.calls
                            with self.assertRaisesRegex(Exception,'NOT_COMPLETE'):broker.dispatch('transfer_receipt',{'code':token})
                            self.assertEqual(calls,docker.calls)
                        else:
                            self.assertEqual(broker.dispatch('transfer_receipt',{'code':token}),result)
                            with self.assertRaises(Exception):broker.dispatch('transfer_receipt',{'code':token})
                    calls=docker.calls
                    with self.assertRaises(Exception):broker.dispatch('transfer_begin',{'code':token,'kind':'import','project':None})
                    self.assertEqual(calls,docker.calls)
                finally:broker.transfers.close();journal.db.close()

    def test_native_inventory_refuses_commands_before_opening_cli(self):
        from unittest.mock import patch
        from windows_engine import fixed_engine_query
        with patch('windows_engine.fixed_cli') as opened:
            for args in (['run','anything'],['context','create','anything'],['--context','remote bad','info','--format','{{json .}}'],['context','inspect','local','--format','{{json .}}']):
                with self.assertRaises(Exception):fixed_engine_query(args)
            opened.assert_not_called()
    def test_actual_staged_payload_is_pinned_and_wrong_digest_refused(self):
        import hashlib
        from native_payload import NativePayload
        manifest=Path(sys.executable).parent/'manifest.json'
        if not manifest.exists():self.skipTest('Explicit staged private runtime required')
        source=self.root/'app';(source/'containers/broker').mkdir(parents=True);file=source/'containers/broker/fixture.py';file.write_text('fixture = True')
        expected=hashlib.sha256(manifest.read_bytes()).hexdigest()
        with self.assertRaises(Exception):NativePayload(source,'0'*64)
        (source/'helper').mkdir()
        for name in ('containers/worker-runner.py','containers/worker-bridge.py','containers/container-apt.py','helper/apt_adapter.py','helper/core.py'):(source/name).write_text('fixture = True')
        payload=NativePayload(source,expected)
        try:
            self.assertEqual(payload.runtime_digest,expected)
            with self.assertRaises(OSError):file.write_text('changed')
            with self.assertRaises(OSError):source.rename(self.root/'renamed')
        finally:payload.close()
        file.write_text('released');self.assertEqual(file.read_text(),'released')

    def set_acl(self,path,sddl,protected=True):
        n=self.native;descriptor=n.C.c_void_p();size=n.W.DWORD()
        n.ok(n.a.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,1,n.C.byref(descriptor),n.C.byref(size)),'TEST_ACL_FAILED')
        try:n.ok(n.a.SetFileSecurityW(str(path),1|4|(0x80000000 if protected else 0x20000000),descriptor),'TEST_ACL_FAILED')
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
            with self.assertRaisesRegex(ValueError,'PRIVATE_DACL'):pin.private()
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


    def test_scaffold_interruption_never_silently_initializes_nonempty_storage(self):
        import uuid
        from windows_scaffold import WindowsScaffold,verify_committed_scaffold
        from transfer_service import write_new
        for phase in ['intent','scaffold','profile-verified','root-marker','committed']:
            with self.subTest(phase=phase):
                root=self.root/phase;root.mkdir();storage_id=str(uuid.uuid4());launch_id=str(uuid.uuid4());setup=WindowsScaffold(root,storage_id,launch_id)
                def checkpoint(current):
                    if current==phase:raise RuntimeError('injected interruption')
                try:
                    with self.assertRaisesRegex(RuntimeError,'injected interruption'):
                        setup.begin(checkpoint);setup.profile_started();write_new(root/'state/container-storage.json',{'version':1,'storageId':storage_id,'profileId':str(uuid.uuid4()),'kind':'local-bind'});setup.finish(checkpoint)
                    replacement=WindowsScaffold(root,storage_id,str(uuid.uuid4()))
                    with self.assertRaises(Exception):replacement.begin()
                    if phase=='committed':verify_committed_scaffold(root,storage_id)
                    else:
                        with self.assertRaises(Exception):verify_committed_scaffold(root,storage_id)
                finally:setup.close()

    def test_user_allow_does_not_override_effective_deny(self):
        user=self.native.current_sid()
        self.set_acl(self.root,f'O:{user}D:P(D;OICI;0x2;;;WD)(A;OICI;FA;;;{user})')
        with self.native.PinnedPath(self.root,directory=True) as pin:
            with self.assertRaisesRegex(ValueError,'PRIVATE_USER_ACCESS'):pin.private()

    def test_owner_policy_keeps_actual_sid_and_root_current_user_only(self):
        from unittest.mock import patch
        user=self.native.current_sid()
        for owner in [user,'S-1-5-18','S-1-5-32-544']:
            self.native.validate_private_owner(owner,user)
        for owner in ['S-1-5-21-1-2-3-1001','S-1-1-0']:
            with self.assertRaisesRegex(ValueError,'PRIVATE_OWNER'):self.native.validate_private_owner(owner,user)
        for owner in ['S-1-5-18','S-1-5-32-544']:
            with self.assertRaisesRegex(ValueError,'PRIVATE_OWNER'):self.native.validate_private_owner(owner,user,True)
        self.native.privatize_empty(self.root)
        for name in ['state','config','workspace','runtime/control']:(self.root/name).mkdir(parents=True)
        with self.native.NativeStorageGuard(self.root) as guard:
            before=guard.verify()
            # Simulate a changed owner result at the native security boundary;
            # actual inherited owners and DACLs are separately read above.
            original=self.native.private_acl
            def changed(handle,protected_root=False):
                result=original(handle,protected_root)
                if handle==guard.pins['config'].handle:result={**result,'ownerSid':'S-1-5-18' if result['ownerSid']!='S-1-5-18' else user}
                return result
            with patch.object(self.native,'private_acl',changed):
                with self.assertRaisesRegex(ValueError,'NATIVE_SLOT_CHANGED'):guard.verify()

    def test_engine_known_folder_lookup_and_write_acl_refusal_are_native_read_only(self):
        from windows_engine import program_files,trusted_installer_sid,trusted_program_acl
        self.assertTrue(program_files().is_dir());self.assertRegex(trusted_installer_sid(),r'^S-1-5-80-')
        self.native.privatize_empty(self.root);user=self.native.current_sid();trusted={user,'S-1-5-18','S-1-5-32-544'}
        with self.native.PinnedPath(self.root,directory=True) as pin:trusted_program_acl(pin.handle,trusted)
        self.set_acl(self.root,f'O:{user}D:P(A;OICI;FA;;;{user})(A;OICI;FW;;;WD)')
        with self.native.PinnedPath(self.root,directory=True) as pin:
            with self.assertRaisesRegex(Exception,'WRITABLE_DOCKER_INSTALL'):trusted_program_acl(pin.handle,trusted)

    def test_hardlinks_and_nonlocal_paths_are_rejected(self):
        file=self.root/'file';file.write_text('x');os.link(file,self.root/'hardlink')
        with self.assertRaises(ValueError):self.native.PinnedPath(file,directory=False)
        for value in ['D:relative',r'\\server\share\file',r'D:\x\..\y',r'D:\x:stream']:
            with self.assertRaises(ValueError):self.native.native_path(value)

if __name__=='__main__':unittest.main()
