import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))

@unittest.skipUnless(os.name=='nt','Actual Windows host journal durability')
class NativeJournals(unittest.TestCase):
    def fixture(self):
        from windows_handles import privatize_empty,PinnedPath
        root=Path(tempfile.mkdtemp(prefix='m31-journal-identity-',dir=os.environ.get('M31_TEST_ROOT'))).resolve();privatize_empty(root);file=root/'claims.sqlite'
        with PinnedPath(file,write=True,create=True,directory=False) as pin:pin.private()
        return root,file
    def test_missing_database_is_not_created_by_connect(self):
        from protocol import open_database
        root,file=self.fixture();file.unlink()
        with self.assertRaises(FileNotFoundError):open_database(file,True)
        self.assertFalse(file.exists());self.assertEqual(list(root.iterdir()),[])
    def test_retained_main_cannot_be_replaced_and_cursor_factory_cannot_escape(self):
        from protocol import open_database
        import sqlite3
        root,file=self.fixture();db=open_database(file,True)
        try:
            with self.assertRaises(PermissionError):file.rename(root/'replacement.sqlite')
            with self.assertRaisesRegex(Exception,'CURSOR_FACTORY'):db.cursor(sqlite3.Cursor)
            db.execute('CREATE TABLE sample(value INTEGER)');db.executemany('INSERT INTO sample VALUES (?)',[(1,),(2,)]);db.commit()
            self.assertEqual(list(db.execute('SELECT value FROM sample')),[(1,),(2,)])
        finally:db.close()
    def test_lazy_cursor_and_commit_poison_allow_rollback_and_close(self):
        from protocol import open_database
        from unittest.mock import patch
        root,file=self.fixture();db=open_database(file,True)
        try:
            db.execute('CREATE TABLE sample(value INTEGER)');db.execute('INSERT INTO sample VALUES (1)');db.commit()
            cursor=db.cursor();cursor.execute('SELECT value FROM sample')
            with patch('native_sqlite.stable',side_effect=ValueError('FIXTURE_IDENTITY_CHANGED')):
                with self.assertRaisesRegex(Exception,'IDENTITY_CHANGED'):cursor.fetchone()
            for operation in (lambda:cursor.execute('SELECT 1'),lambda:cursor.executescript('SELECT 1;'),lambda:cursor.fetchmany(),lambda:cursor.fetchall(),lambda:next(cursor),db.commit):
                with self.assertRaisesRegex(Exception,'RECOVERY_REQUIRED'):operation()
            db.rollback();cursor.close()
        finally:db.close();db.close()
    def test_interrupted_persist_transaction_reopens_without_replaying_accepted_claim(self):
        from windows_handles import privatize_empty,PinnedPath
        from protocol import Journal
        root=Path(tempfile.mkdtemp(prefix='m31-host-journal-',dir=os.environ.get('M31_TEST_ROOT'))).resolve();privatize_empty(root);file=root/'claims.sqlite';claim=str(uuid.uuid4())
        code="""import os,sys,json
sys.path.insert(0,sys.argv[1])
from protocol import Journal
from windows_handles import PinnedPath
with PinnedPath(sys.argv[2],write=True,create=True,directory=False) as pin:pin.private()
j=Journal(sys.argv[2],sys.argv[3],persistent=True)
body={'claimId':sys.argv[4],'project':'project','contextId':'a'*64,'operation':{'kind':'shell','command':'synthetic never executed'},'timeoutMs':1000,'outputLimit':1000}
identity={'storageId':sys.argv[3],'projectId':'b'*64,'imageId':'sha256:'+'c'*64}
prepared=j.prepare(body,identity);j.activate({'claimId':prepared['claimId'],'binding':prepared['binding']},identity)
j.db.execute('CREATE TABLE uncommitted(value TEXT)');j.db.commit();j.db.execute("INSERT INTO uncommitted VALUES ('must roll back')")
os._exit(7)
"""
        result=subprocess.run([sys.executable,'-I','-B','-c',code,str(Path(__file__).resolve().parents[1]/'containers/broker'),str(file),str(uuid.uuid4()),claim],capture_output=True,text=True,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(result.returncode,7,result.stderr);journal=Path(str(file)+'-journal');self.assertTrue(journal.exists())
        with PinnedPath(journal,directory=False,share_write=True) as pin:pin.private()
        recovered=Journal(str(file),str(uuid.uuid4()),persistent=True)
        try:
            self.assertEqual(recovered.db.execute('PRAGMA journal_mode').fetchone(),('persist',));self.assertEqual(recovered.db.execute('PRAGMA synchronous').fetchone(),(2,))
            self.assertEqual(recovered.db.execute('SELECT count(*) FROM uncommitted').fetchone(),(0,));self.assertEqual(recovered.get(claim)['state'],'uncertain');self.assertEqual(recovered.get(claim)['code'],'BROKER_RESTARTED')
            with self.assertRaises(Exception):recovered.activate({'claimId':claim,'binding':recovered.get(claim)['binding']},recovered.get(claim)['identity'])
        finally:recovered.db.close()
        self.assertTrue(journal.exists())
        with PinnedPath(journal,directory=False,share_write=True) as pin:pin.private()

if __name__=='__main__':unittest.main()
