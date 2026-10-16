import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))

@unittest.skipUnless(os.name=='nt','Actual native private target metadata')
class Targets(unittest.TestCase):
    def setUp(self):
        from windows_handles import privatize_empty,NativeStorageGuard
        self.root=Path(tempfile.mkdtemp(prefix='m31-targets-',dir=os.environ.get('M31_TEST_ROOT'))).resolve();privatize_empty(self.root)
        for name in ('state','config','workspace','runtime','runtime/control'):(self.root/name).mkdir()
        self.guard=NativeStorageGuard(self.root);self.guard.verify()
    def tearDown(self):self.guard.close()
    def target(self,relative='profile/state.sqlite',kind='sqlite',mode='existing',root='state'):return {'root':root,'relative':relative,'kind':kind,'mode':mode}
    def test_finite_paths_roots_and_duplicate_classes(self):
        from storage_targets import validate_targets
        for relative in ('/absolute','../escape','a/../b','a\\b','C:/absolute','a//b','con','a.','a:b','a/COM1.txt','CONIN$','CONOUT$','COM\u00b9','LPT\u00b2.txt',''):
            with self.subTest(relative=relative),self.assertRaises(Exception):validate_targets([self.target(relative)])
        for root in ('workspace','runtime','operator','original'):
            with self.assertRaises(Exception):validate_targets([self.target(root=root)])
        with self.assertRaises(Exception):validate_targets([self.target(),self.target('PROFILE/state.sqlite')])
        with self.assertRaises(Exception):validate_targets([self.target('not-a-database')])
    def test_create_proves_parent_and_existing_target_requires_actual_metadata(self):
        from storage_targets import verify_targets
        verify_targets(self.guard,[self.target(mode='create')])
        with self.assertRaises(FileNotFoundError):verify_targets(self.guard,[self.target()])
        (self.root/'state/profile').mkdir();(self.root/'state/profile/state.sqlite').write_text('fixture')
        self.assertRegex(verify_targets(self.guard,[self.target()]),'^[a-f0-9]{64}$')
        with self.assertRaises(Exception):verify_targets(self.guard,[self.target(kind='directory')])
    def test_only_exact_sqlite_transients_may_be_absent(self):
        from storage_targets import verify_targets
        (self.root/'state/profile').mkdir();database=self.root/'state/profile/state.sqlite';database.write_text('fixture');journal=Path(str(database)+'-journal');journal.write_text('temporary');journal.unlink()
        verify_targets(self.guard,[self.target()]);database.unlink()
        with self.assertRaises(FileNotFoundError):verify_targets(self.guard,[self.target()])
    def test_transient_hardlink_replacement_is_not_absence(self):
        from storage_targets import verify_targets
        (self.root/'state/profile').mkdir();database=self.root/'state/profile/state.sqlite';database.write_text('fixture');other=self.root/'state/other';other.write_text('unsafe');os.link(other,Path(str(database)+'-wal'))
        with self.assertRaises(Exception):verify_targets(self.guard,[self.target()])
    def test_main_database_replacement_cannot_rebind_the_session(self):
        from storage_targets import PrivateTargets
        (self.root/'state/profile').mkdir();database=self.root/'state/profile/state.sqlite';database.write_text('original');authority=PrivateTargets(self.guard)
        authority.observe([self.target()]);database.rename(database.with_name('old.sqlite'));database.write_text('replacement')
        with self.assertRaisesRegex(Exception,'DATABASE_CHANGED'):authority.observe([self.target()])
        database.unlink()
        with self.assertRaisesRegex(Exception,'RECOVERY_REQUIRED'):authority.observe([self.target(mode='create')])
    def test_digest_changes_with_exact_targets_phase_and_session(self):
        from storage_targets import target_digest,validate_targets
        import uuid
        binding={'storageId':str(uuid.uuid4()),'launchId':str(uuid.uuid4())};session=str(uuid.uuid4());target=[self.target()];before=target_digest(target,binding,session,'controller')
        self.assertNotEqual(before,target_digest(target,binding,str(uuid.uuid4()),'controller'));self.assertNotEqual(before,target_digest(target,binding,session,'initialize'))
        self.assertNotEqual(before,target_digest([self.target(mode='create')],binding,session,'controller'))
        for relative in ('a'*1025,'x/\ud800','é'*513):
            with self.assertRaises(Exception):validate_targets([self.target(relative)])
    def test_unrelated_file_count_does_not_expand_target_observation(self):
        from storage_targets import verify_targets
        from windows_handles import PinnedPath
        (self.root/'state/profile').mkdir();(self.root/'state/profile/state.sqlite').write_text('fixture')
        for i in range(256):(self.root/'state'/str(i)).write_text('unrelated')
        with patch('storage_targets.PinnedPath',wraps=PinnedPath) as opened:verify_targets(self.guard,[self.target()])
        self.assertEqual(opened.call_count,2) # parent+database; auxiliaries use metadata-only native helper

    def test_exact_private_file_acl_loss_and_restoration_cannot_reactivate(self):
        from storage_targets import PrivateTargets
        from windows_handles import current_sid
        from test_desktop_windows import NativeHandles
        import windows_handles as native
        file=self.root/'config/provider.json';file.write_text('{}');target=self.target('provider.json','file',root='config');authority=PrivateTargets(self.guard)
        authority.observe([target]);helper=NativeHandles();helper.native=native;user=current_sid()
        helper.set_acl(file,f'O:{user}D:P(A;;FA;;;{user})(A;;FA;;;WD)')
        with self.assertRaises(Exception):authority.observe([target])
        helper.set_acl(file,f'O:{user}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{user})')
        with self.assertRaisesRegex(Exception,'RECOVERY_REQUIRED'):authority.observe([target])
    def test_scoped_observation_does_not_open_unrelated_atomic_publications(self):
        import threading
        import time
        import sqlite3
        from storage_targets import PrivateTargets
        database=self.root/'state/live.sqlite';writer=sqlite3.connect(database);writer.execute('CREATE TABLE value(n INTEGER)');writer.commit()
        record=self.root/'state/atomic.json';record.write_text('0');errors=[];durations=[]
        def publish():
            try:
                for index in range(200):
                    temporary=self.root/'state/pending.json';temporary.write_text(str(index));os.replace(temporary,record)
            except BaseException as error:errors.append(repr(error))
        thread=threading.Thread(target=publish);thread.start();authority=PrivateTargets(self.guard)
        try:
            for index in range(200):
                writer.execute('INSERT INTO value VALUES (?)',(index,));writer.commit()
                start=time.perf_counter();authority.observe([self.target('live.sqlite')]);durations.append(time.perf_counter()-start)
            thread.join(timeout=10);self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
            self.assertEqual(writer.execute('SELECT count(*) FROM value').fetchone(),(200,));self.assertLess(max(durations),2)
        finally:writer.close();thread.join(timeout=10)

if __name__=='__main__':unittest.main()
