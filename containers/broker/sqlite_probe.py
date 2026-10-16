"""Fresh native-host SQLite WAL/contender/reopen proof; no shared-OS DB use."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from protocol import require,exact,HEX,canonical
from native_io import private_path,root_handle

def child(mode,value):
    exact(value,['database','nonce']);require(HEX.fullmatch(value['nonce']))
    file=Path(value['database']);require(file.is_absolute() and file.is_file() and not file.is_symlink(),'UNSAFE_PROBE_DB')
    if os.name=='nt':
        from windows_handles import PinnedPath
        # The parent intentionally holds a SQLite write transaction. Verify
        # file identity/ACL without imposing copy-source deny-write sharing.
        with PinnedPath(file,directory=False,share_write=True) as pin:pin.private()
    else:private_path(file)
    db=sqlite3.connect(file,timeout=0)
    try:
        if mode=='contend':
            try:db.execute('BEGIN IMMEDIATE')
            except sqlite3.OperationalError as error:
                require(error.sqlite_errorcode==sqlite3.SQLITE_BUSY,'UNEXPECTED_LOCK_ERROR');return {'denied':True}
            db.rollback();raise RuntimeError('SECOND_WRITER_NOT_DENIED')
        require(mode=='reopen','INVALID_PROBE_MODE')
        require(db.execute('SELECT nonce FROM proof').fetchall()==[(value['nonce'],)],'PROBE_REOPEN_FAILED')
        return {'reopened':True}
    finally:db.close()

def probe_native(directory,nonce):
    require(type(nonce) is str and HEX.fullmatch(nonce),'INVALID_PROBE_NONCE')
    directory=Path(directory);require(directory.is_dir() and not list(directory.iterdir()),'FRESH_PROBE_REQUIRED');private_path(directory)
    env={k:os.environ[k] for k in ('SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG') if k in os.environ}
    def run(mode):
        result=subprocess.run([sys.executable,'-I','-B',str(Path(__file__).resolve()),mode],input=canonical({'database':str(directory/'native.sqlite'),'nonce':nonce}),text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15,env=env,cwd=directory)
        require(result.returncode==0 and len(result.stdout)<1024,'NATIVE_SQLITE_'+mode.upper()+'_FAILED');return json.loads(result.stdout)
    with root_handle(directory):
        db=sqlite3.connect(directory/'native.sqlite',timeout=0)
        try:
            require(db.execute('PRAGMA journal_mode=WAL').fetchone()==('wal',),'NATIVE_WAL_REQUIRED')
            db.execute('PRAGMA synchronous=FULL');db.execute('CREATE TABLE proof(nonce TEXT NOT NULL)');db.commit()
            db.execute('BEGIN IMMEDIATE');db.execute('INSERT INTO proof VALUES (?)',(nonce,))
            require(run('contend')=={'denied':True},'NATIVE_LOCK_UNPROVEN');db.commit()
            require(run('reopen')=={'reopened':True},'NATIVE_REOPEN_UNPROVEN')
        finally:db.close()
    return {'wal':True,'secondWriterDenied':True,'reopened':True}

if __name__=='__main__':
    try:
        require(len(sys.argv)==2 and sys.argv[1] in ('contend','reopen'),'INVALID_PROBE_MODE')
        raw=sys.stdin.read(8193);require(len(raw)<=8192,'PROBE_LIMIT');print(canonical(child(sys.argv[1],json.loads(raw))))
    except Exception:raise SystemExit(1)
