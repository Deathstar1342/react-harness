"""Complete source inventory and source/platform/image binding regressions."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('source_payload_verify',Path(__file__).resolve().parents[1]/'scripts/source-payload-verify.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class SourcePayload(unittest.TestCase):
    def setUp(self):
        self.base=Path(tempfile.mkdtemp(prefix='m32-payload-',dir=os.environ.get('TEMP',os.environ.get('RUNNER_TEMP'))))
        self.root=self.base/'payload';self.root.mkdir();(self.root/'app').mkdir();(self.root/'support-runtime').mkdir()
        self.source='a'*40;self.controller='sha256:'+'b'*64;self.worker='sha256:'+'c'*64
        value={'version':1,'source':self.source,'controllerImage':self.controller,'workerImage':self.worker}
        (self.root/'app/container-runtime.json').write_text(json.dumps(value));(self.root/'provenance.json').write_text(json.dumps({**value,'platform':'linux','arch':'x64'}))
        (self.root/'support-runtime/manifest.json').write_text(json.dumps({'platform':'linux','pythonVersion':'3.13.16'}))
        (self.root/'app/snowman-\u2603.txt').write_text('unicode fixture',encoding='utf8')
        self.inventory()
    def inventory(self):
        (self.root/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(self.root).as_posix()+'\n' for p in sorted(self.root.rglob('*')) if p.is_file() and p.name!='SHA256SUMS'),encoding='utf8')
    def verify(self):module.verify(self.root,self.source,self.controller,self.worker,'linux')
    def test_complete_payload_and_relocation(self):
        self.verify();self.root.rename(self.base/'relocated');self.root=self.base/'relocated';self.verify()
    def test_missing_extra_tamper_and_hardlink(self):
        (self.root/'extra').write_text('extra')
        with self.assertRaises(ValueError):self.verify()
        (self.root/'extra').unlink();file=self.root/'app/container-runtime.json';original=file.read_bytes();file.write_bytes(b'changed')
        with self.assertRaises(ValueError):self.verify()
        file.write_bytes(original);os.link(file,self.base/'hardlink')
        with self.assertRaises(ValueError):self.verify()
    def test_traversal_collision_and_win32_alias_before_read(self):
        for name in ['../outside','/outside','app/CONIN$','app/COM\u00b9','app/x:ads','app/./file']:
            (self.root/'SHA256SUMS').write_text('0'*64+'  '+name+'\n')
            with self.assertRaises(ValueError):self.verify()
        self.inventory();old=(self.root/'SHA256SUMS').read_text();(self.root/'SHA256SUMS').write_text(old+old.splitlines()[0]+'\n')
        with self.assertRaises(ValueError):self.verify()
    def test_bound_image_and_source_even_when_rehashed(self):
        for key,value in [('source','d'*40),('workerImage',self.controller)]:
            payload=json.loads((self.root/'app/container-runtime.json').read_text());payload[key]=value
            (self.root/'app/container-runtime.json').write_text(json.dumps(payload));self.inventory()
            with self.assertRaises(ValueError):self.verify()
    def test_wrong_platform_and_host_native_closure(self):
        manifest=self.root/'support-runtime/manifest.json';manifest.write_text(json.dumps({'platform':'win32','pythonVersion':'3.13.16'}));self.inventory()
        with self.assertRaises(ValueError):self.verify()
        manifest.write_text(json.dumps({'platform':'linux','pythonVersion':'3.13.16'}));(self.root/'app/backend.node').write_bytes(b'wrong ABI');self.inventory()
        with self.assertRaises(ValueError):self.verify()


if __name__=='__main__':unittest.main()
