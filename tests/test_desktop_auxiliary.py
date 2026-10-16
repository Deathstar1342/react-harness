import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))

@unittest.skipUnless(os.name=='nt','Actual native SQLite transient metadata sharing')
class Auxiliary(unittest.TestCase):
    def setUp(self):
        from windows_handles import privatize_empty
        self.root=Path(tempfile.mkdtemp(prefix='m31-auxiliary-',dir=os.environ.get('M31_TEST_ROOT'))).resolve();privatize_empty(self.root);self.database=self.root/'fixture.sqlite'
    def open(self,mode):
        db=sqlite3.connect(self.database,timeout=.2);self.assertEqual(db.execute('PRAGMA journal_mode='+mode).fetchone(),(mode.lower(),));db.execute('PRAGMA synchronous=FULL');db.execute('CREATE TABLE fixture(value TEXT)');db.commit();return db
    def observe(self,suffix,checkpoint=lambda:None):
        from windows_handles import PinnedPath
        from sqlite_auxiliary import observe_auxiliary
        with PinnedPath(self.root,directory=True) as parent,PinnedPath(self.database,directory=False,share_write=True) as main:return observe_auxiliary(main,parent,suffix,checkpoint)
    def test_delete_commit_succeeds_while_exact_metadata_reader_is_open(self):
        db=self.open('DELETE');db.execute("INSERT INTO fixture VALUES ('committed')")
        try:
            self.assertEqual(self.observe('-journal',db.commit),'absent');self.assertEqual(db.execute('SELECT count(*) FROM fixture').fetchone(),(1,))
        finally:db.close()
        self.assertFalse(Path(str(self.database)+'-journal').exists())
    def test_persist_commit_and_database_growth_do_not_compare_file_size(self):
        db=self.open('PERSIST');db.execute('INSERT INTO fixture VALUES (?)',('x'*65536,))
        try:
            self.assertEqual(self.observe('-journal',db.commit),'present');self.assertEqual(db.execute('SELECT count(*) FROM fixture').fetchone(),(1,))
        finally:db.close()
    def test_wal_last_connection_close_succeeds_during_auxiliary_observation(self):
        db=self.open('WAL');db.execute("INSERT INTO fixture VALUES ('committed')");db.commit()
        self.assertEqual(self.observe('-wal',db.close),'absent');self.assertFalse(Path(str(self.database)+'-wal').exists())
        reopened=sqlite3.connect(self.database)
        try:self.assertEqual(reopened.execute('SELECT count(*) FROM fixture').fetchone(),(1,))
        finally:reopened.close()
    def test_shm_last_close_is_optional_without_writer_failure(self):
        db=self.open('WAL');db.execute("INSERT INTO fixture VALUES ('committed')");db.commit()
        self.assertEqual(self.observe('-shm',db.close),'absent');self.assertFalse(Path(str(self.database)+'-shm').exists())
    def test_non_deleted_rename_during_observation_is_refused(self):
        db=self.open('PERSIST');db.close();file=Path(str(self.database)+'-journal')
        with self.assertRaisesRegex(Exception,'ALIAS'):self.observe('-journal',lambda:file.rename(self.root/'moved-journal'))
    def test_deleted_auxiliary_grants_nothing_to_replacement(self):
        db=self.open('PERSIST');db.close();file=Path(str(self.database)+'-journal');other=self.root/'other';other.write_text('private');replaced=[]
        def replace():
            file.unlink()
            try:os.link(other,file);replaced.append(True)
            except PermissionError:replaced.append(False) # Windows may retain delete-pending name until our reader closes.
        self.assertEqual(self.observe('-journal',replace),'absent')
        if not replaced[0]:os.link(other,file)
        with self.assertRaisesRegex(Exception,'LINKS'):self.observe('-journal')
    def test_unexplained_zero_link_metadata_is_not_absence(self):
        from unittest.mock import patch
        from sqlite_auxiliary import metadata
        db=self.open('PERSIST');db.close()
        def detached(handle):return {**metadata(handle),'links':0,'deleting':False}
        with patch('sqlite_auxiliary.metadata',side_effect=detached),self.assertRaisesRegex(Exception,'DETACHED'):self.observe('-journal')
    def test_absence_does_not_authorize_hardlinked_replacement(self):
        db=self.open('DELETE');db.close();self.assertEqual(self.observe('-journal'),'absent');other=self.root/'other';other.write_text('private');os.link(other,Path(str(self.database)+'-journal'))
        with self.assertRaisesRegex(Exception,'LINKS'):self.observe('-journal')
    def test_arbitrary_suffix_is_refused(self):
        db=self.open('DELETE');db.close()
        for suffix in ('','-other','/../other'):
            with self.assertRaisesRegex(Exception,'CLASS'):self.observe(suffix)
    def test_existing_reparse_leaf_is_refused_when_unprivileged_links_supported(self):
        db=self.open('DELETE');db.close();other=self.root/'other';other.write_text('private')
        try:os.symlink(other,Path(str(self.database)+'-journal'))
        except OSError as error:
            if getattr(error,'winerror',None)==1314:self.skipTest('Existing unprivileged symlink creation unavailable; no setting changed')
            raise
        with self.assertRaisesRegex(Exception,'TYPE'):self.observe('-journal')
    def test_actual_broad_auxiliary_dacl_is_refused(self):
        from windows_handles import C,W,a,k,current_sid,ok
        db=self.open('PERSIST');db.close();file=Path(str(self.database)+'-journal');user=current_sid();descriptor=C.c_void_p();size=W.DWORD()
        ok(a.ConvertStringSecurityDescriptorToSecurityDescriptorW(f'O:{user}D:P(A;;FA;;;{user})(A;;FR;;;WD)',1,C.byref(descriptor),C.byref(size)),'FIXTURE_SDDL')
        a.SetFileSecurityW.argtypes=[W.LPCWSTR,W.DWORD,C.c_void_p];a.SetFileSecurityW.restype=W.BOOL
        try:ok(a.SetFileSecurityW(str(file),4|0x80000000,descriptor),'FIXTURE_DACL')
        finally:k.LocalFree(descriptor)
        with self.assertRaisesRegex(Exception,'PRIVATE_DACL'):self.observe('-journal')

if __name__=='__main__':unittest.main()
