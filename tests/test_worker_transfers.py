import os
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'containers/broker'))
from transfers import component, policy, scan, copy, publish

class TransferPolicy(unittest.TestCase):
    def test_unsafe_names(self):
        for name in ['../escape', 'CON.txt', 'x:y', 'x.', 'x ', 'nul', 'a\\b', 'e\u0301']:
            with self.subTest(name=name), self.assertRaises(Exception): component(name)
    def test_policy(self):
        self.assertIsNotNone(policy('.env', [], False))
        self.assertIsNone(policy('.env', ['.env'], False))
        self.assertIsNotNone(policy('.aws/credentials', ['.aws/credentials'], False))
        self.assertIsNotNone(policy('node_modules/x', [], False))
        self.assertIsNotNone(policy('.git/config', [], True))
        self.assertIsNone(policy('.git/objects/ab/0123', [], True))
        with self.assertRaises(Exception): policy('.git/objects/info/alternates', [], True)

@unittest.skipUnless(os.name == 'posix', 'Linux descriptor-relative source implementation')
class TransferCopy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root/'source'; self.source.mkdir()
        (self.source/'file.txt').write_bytes(b'dirty working bytes')
    def tearDown(self): self.temp.cleanup()
    def test_copy_preserves_source_and_no_clobber(self):
        before=(self.source/'file.txt').stat()
        (self.source/'.env').write_text('ordinary=private')
        manifest=scan(self.source)
        self.assertEqual(manifest['excluded'][0]['path'],'.env')
        stage=self.root/'stage'; copy(self.source,stage,manifest)
        self.assertEqual((stage/'file.txt').read_bytes(), b'dirty working bytes')
        self.assertFalse((stage/'.env').exists())
        self.assertTrue((stage/'.git/HEAD').exists())
        after=(self.source/'file.txt').stat()
        self.assertEqual((before.st_mtime_ns,before.st_mode),(after.st_mtime_ns,after.st_mode))
        destination=self.root/'destination'; destination.mkdir()
        with self.assertRaises(OSError): publish(stage,destination)
        self.assertTrue(stage.exists()); self.assertEqual(list(destination.iterdir()),[])
        destination.rmdir(); publish(stage,destination)
        self.assertTrue((destination/'file.txt').exists())
    def test_change_rejected(self):
        manifest=scan(self.source)
        (self.source/'file.txt').write_text('changed')
        with self.assertRaises(Exception): copy(self.source,self.root/'stage',manifest)
    def test_links_collisions_secrets(self):
        (self.source/'link').symlink_to(self.root)
        with self.assertRaises(Exception): scan(self.source)
        (self.source/'link').unlink()
        (self.source/'FILE.txt').write_text('collision')
        with self.assertRaises(Exception): scan(self.source)
        (self.source/'FILE.txt').unlink()
        (self.source/'file.txt').write_text('STARK_API_KEY=must-never-copy')
        self.assertEqual(scan(self.source)['bytes'],len(b'STARK_API_KEY=must-never-copy'))
        with self.assertRaises(Exception): scan(self.source,secrets=[b'must-never-copy'])
    def test_cancel_preserves_residue(self):
        manifest=scan(self.source)
        def stop(): raise InterruptedError()
        with self.assertRaises(InterruptedError): copy(self.source,self.root/'stage',manifest,check=stop)
        self.assertTrue((self.root/'stage').exists())
        self.assertEqual((self.source/'file.txt').read_bytes(),b'dirty working bytes')

if __name__ == '__main__': unittest.main()
