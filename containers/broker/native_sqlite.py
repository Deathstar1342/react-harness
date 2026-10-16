"""Fixed Windows host SQLite journal; path authority precedes SQLite open."""
import sqlite3
import threading
from pathlib import Path
from windows_handles import PinnedPath
from sqlite_auxiliary import stable,observe_auxiliary
from protocol import require

class NativeCursor(sqlite3.Cursor):
    def execute(self,sql,*args,**kwargs):
        with self.connection.native_lock:
            if sql.strip().upper()!='ROLLBACK':self.connection.observe()
            return super().execute(sql,*args,**kwargs)
    def executemany(self,*args,**kwargs):
        with self.connection.native_lock:self.connection.observe();return super().executemany(*args,**kwargs)
    def executescript(self,*args,**kwargs):
        with self.connection.native_lock:self.connection.observe();return super().executescript(*args,**kwargs)
    def fetchone(self):
        with self.connection.native_lock:self.connection.observe();return super().fetchone()
    def fetchmany(self,*args,**kwargs):
        with self.connection.native_lock:self.connection.observe();return super().fetchmany(*args,**kwargs)
    def fetchall(self):
        with self.connection.native_lock:self.connection.observe();return super().fetchall()
    def __iter__(self):return self
    def __next__(self):
        with self.connection.native_lock:self.connection.observe();return super().__next__()
    def close(self):
        with self.connection.native_lock:return super().close()

class NativeConnection(sqlite3.Connection):
    def __init__(self,file,*args,**kwargs):
        self.native_parent=None;self.native_main=None;self.native_failed=False;self.native_lock=threading.RLock();self.native_open=False
        try:
            # Existing only. Trusted fresh lifecycle code creates the exact empty
            # file separately; connect must never create a missing journal.
            self.native_parent=PinnedPath(Path(file).parent,directory=True);self.native_parent.private()
            self.native_main=PinnedPath(file,directory=False,share_write=True);self.native_main.private();self.observe()
            super().__init__(file,*args,**kwargs);self.native_open=True;self.observe()
        except BaseException:self.close();raise
    def observe(self):
        with self.native_lock:
            require(not self.native_failed,'NATIVE_JOURNAL_RECOVERY_REQUIRED')
            try:
                stable(self.native_parent);stable(self.native_main)
                for suffix in ('-journal','-wal','-shm'):observe_auxiliary(self.native_main,self.native_parent,suffix)
            except BaseException:self.native_failed=True;raise
    def cursor(self,factory=None):
        with self.native_lock:
            require(factory is None or factory is NativeCursor,'NATIVE_CURSOR_FACTORY_REFUSED');self.observe()
            return super().cursor(factory=NativeCursor)
    def execute(self,sql,*args,**kwargs):
        # Use the fixed cursor even for convenience APIs and lazy iteration.
        with self.native_lock:
            if sql.strip().upper()=='ROLLBACK':return super().cursor(factory=NativeCursor).execute(sql,*args,**kwargs)
            return self.cursor().execute(sql,*args,**kwargs)
    def executemany(self,*args,**kwargs):return self.cursor().executemany(*args,**kwargs)
    def executescript(self,*args,**kwargs):return self.cursor().executescript(*args,**kwargs)
    def commit(self):
        with self.native_lock:self.observe();return super().commit()
    def rollback(self):
        with self.native_lock:return super().rollback()
    def __enter__(self):
        self.native_lock.acquire()
        try:self.observe();super().__enter__();return self
        except BaseException:self.native_lock.release();raise
    def __exit__(self,kind,value,trace):
        try:
            if kind is None:
                try:self.observe()
                except BaseException:super().rollback();raise
            return super().__exit__(kind,value,trace)
        finally:self.native_lock.release()
    def close(self):
        with self.native_lock:
            try:
                if self.native_open:super().close();self.native_open=False
            finally:
                self.native_failed=True
                if self.native_main:self.native_main.close();self.native_main=None
                if self.native_parent:self.native_parent.close();self.native_parent=None
