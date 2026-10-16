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
        self.root=Path(tempfile.mkdtemp(prefix='m31-native-'))
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
        with self.native.PinnedPath(self.root/'state',directory=True) as handle:self.assertEqual(handle.private()['ownerSid'],proof['ownerSid'])
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
    def test_hardlinks_and_nonlocal_paths_are_rejected(self):
        file=self.root/'file';file.write_text('x');os.link(file,self.root/'hardlink')
        with self.assertRaises(ValueError):self.native.PinnedPath(file,directory=False)
        for value in ['D:relative',r'\\server\share\file',r'D:\x\..\y',r'D:\x:stream']:
            with self.assertRaises(ValueError):self.native.native_path(value)

if __name__=='__main__':unittest.main()
