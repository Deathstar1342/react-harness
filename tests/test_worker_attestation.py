import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).parents[1]/'containers/broker'))
import attestation as a
from protocol import Denied

def archive(extras=()):
    buffer=io.BytesIO()
    with tarfile.open(fileobj=buffer,mode='w') as tar:
        for name in ['usr','usr/bin','usr/lib','usr/lib/python3.11','usr/lib/x86_64-linux-gnu','opt','opt/abyssus-worker']:
            info=tarfile.TarInfo(name);info.type=tarfile.DIRTYPE;info.mode=0o755;tar.addfile(info)
        for name,content in [('usr/bin/python3.11',b'python'),('usr/bin/git',b'git'),('opt/abyssus-worker/worker-runner.py',b'runner'),*extras]:
            info=tarfile.TarInfo(name);info.size=len(content);info.mode=0o755;tar.addfile(info,io.BytesIO(content))
    buffer.seek(0)
    return buffer

class Attestation(unittest.TestCase):
    def test_changed_or_added_trusted_code_changes_the_independent_manifest(self):
        baseline=a.manifest(archive())
        added=a.manifest(archive([('usr/lib/python3.11/sitecustomize.py',b'evil')]))
        self.assertNotEqual(baseline,added)
        self.assertIn('usr/lib/python3.11/sitecustomize.py',added)
        for path in ('usr/bin/env','usr/lib/python311.zip','usr/local/lib/python311.zip','usr/lib64/ld-linux-x86-64.so.2'):
            with self.subTest(path=path):
                self.assertNotEqual(baseline,a.manifest(archive([(path,b'injected bootstrap')])) )
    def test_duplicate_traversal_and_byte_limit_reject_without_extraction(self):
        for extras in [[('usr/bin/git',b'replaced')],[('../outside',b'x')],[('/absolute',b'x')],[('./usr/bin/python',b'x')]]:
            with self.subTest(extras=extras),self.assertRaises(Denied):a.manifest(archive(extras))
        with self.assertRaises(Denied):a.manifest(archive(),max_bytes=1)
    def test_missing_trusted_roots_cannot_attest(self):
        b=io.BytesIO()
        with tarfile.open(fileobj=b,mode='w'):pass
        b.seek(0)
        with self.assertRaisesRegex(Denied,'MISSING'):a.manifest(b)
    def test_independent_watchdog_terminates_stalled_export_and_cleans_exact_container(self):
        calls=[]
        class Docker:
            env={}
            @property
            def resources(self):return self
            def create(self,args,image,kind):return 'b'*64
            def remove(self,id):calls.append(['rm',id])
            def call(self,args):
                calls.append(args)
                if args[0]=='image':return json.dumps([{'Id':'sha256:'+'a'*64,'Config':{'Env':[]},'Architecture':'amd64','Os':'linux'}])
                if args[0]=='create':return 'b'*64
                return ''
            def argv(self,args):return [sys.executable,'-c','import time;time.sleep(60)']
        inspector=a.Attestor.__new__(a.Attestor);inspector.docker=Docker();inspector.expected_env=[]
        start=time.monotonic()
        with patch.object(a,'EXPORT_SECONDS',.1),self.assertRaises(Exception):inspector.inspect('sha256:'+'a'*64)
        self.assertLess(time.monotonic()-start,3)
        self.assertIn(['rm','b'*64],calls)
    def test_hidden_volume_or_changed_environment_rejected_before_export(self):
        for config in [{'Env':[],'Volumes':{'/usr/lib':{}}},{'Env':['LD_PRELOAD=/evil']}]:
            class Docker:
                def call(self,args):
                    self.assert_image=args[0]=='image'
                    return json.dumps([{'Id':'sha256:'+'a'*64,'Config':config}])
            inspector=a.Attestor.__new__(a.Attestor);inspector.docker=Docker();inspector.expected_env=[]
            with self.assertRaisesRegex(Denied,'CONTROL_METADATA'):inspector.inspect('sha256:'+'a'*64)

if __name__=='__main__':unittest.main()
