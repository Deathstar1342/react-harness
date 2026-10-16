import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

class Staging(unittest.TestCase):
    def setUp(self):
        script=Path(__file__).resolve().parents[1]/'scripts/stage-container-runtime.py'
        spec=importlib.util.spec_from_file_location('stage_container_runtime',script);self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        self.root=Path(tempfile.mkdtemp(prefix='m31-payload-stage-',dir=os.environ.get('M31_TEST_ROOT'))).resolve()
        for name in ('package.json','desktop/entry.cjs','desktop/main.js','containers/broker/support_entry.py','containers/worker-runner.py','helper/core.py'):
            file=self.root/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text('fixture',encoding='utf-8')
    def test_exact_new_manifest_and_no_overwrite(self):
        file=self.module.stage(self.root,'a'*40,'sha256:'+'b'*64,'sha256:'+'c'*64)
        self.assertEqual(json.loads(file.read_text()),{'version':1,'source':'a'*40,'controllerImage':'sha256:'+'b'*64,'workerImage':'sha256:'+'c'*64})
        before=file.read_bytes()
        with self.assertRaises(FileExistsError):self.module.stage(self.root,'d'*40,'sha256:'+'e'*64,'sha256:'+'f'*64)
        self.assertEqual(file.read_bytes(),before)
    def test_mutable_tag_and_incomplete_staging_never_write_manifest(self):
        with self.assertRaises(ValueError):self.module.stage(self.root,'a'*40,'abyssus:latest','sha256:'+'c'*64)
        (self.root/'desktop/main.js').unlink()
        with self.assertRaises(FileNotFoundError):self.module.stage(self.root,'a'*40,'sha256:'+'b'*64,'sha256:'+'c'*64)
        self.assertFalse((self.root/'container-runtime.json').exists())
    def test_source_path_cannot_be_staging_output(self):
        with self.assertRaises(ValueError):self.module.stage(Path(__file__).resolve().parents[1],'a'*40,'sha256:'+'b'*64,'sha256:'+'c'*64)

if __name__=='__main__':unittest.main()
