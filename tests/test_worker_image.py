"""Trusted desktop immutable image binding before resource recovery; engine replies doubled."""
import json
from types import SimpleNamespace
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parents[1]/'containers/broker'))
from docker_runtime import Docker
from protocol import Denied
from desktop_host import DesktopHost

class SelectedImage(unittest.TestCase):
    def test_invalid_selection_refuses_before_any_engine_query(self):
        with patch.object(Docker,'call') as call:
            for value in ('latest','abyssus-worker:m29','sha256:'+'g'*64,42,'sha256:'+'a'*64+'\n'):
                with self.assertRaises(Denied):Docker('unused','unused','unused','default',value)
            call.assert_not_called()

    def test_failure_categories_are_fixed_and_never_replay(self):
        host=object.__new__(DesktopHost);host.launch={'context':'fixture'};host.env={}
        for args,stderr,expected in ((['image','inspect','unused'],b'PRIVATE_ACCOUNT_TEXT','ENGINE_IMAGE_FAILED'),(['run'],b'PRIVATE_ACCOUNT_TEXT ERR_MODULE_NOT_FOUND','ENGINE_INITIALIZE_MODULE_MISSING'),(['run'],b'Initialization refused or interrupted. PRIVATE_ACCOUNT_TEXT','ENGINE_INITIALIZE_PROFILE_REFUSED'),(['run'],b'PRIVATE_ACCOUNT_TEXT','ENGINE_INITIALIZE_FAILED')):
            with patch('desktop_host.subprocess.run',return_value=SimpleNamespace(returncode=1,stdout=b'',stderr=stderr)) as run:
                with self.assertRaisesRegex(Denied,'^'+expected+'$'):host.call(args)
                run.assert_called_once()

    def test_desktop_missing_or_malformed_image_never_falls_back(self):
        launch={'storage':'/unused','mode':'existing','storageId':'a'*8+'-aaaa-aaaa-aaaa-'+'a'*12,'context':'default','engineId':'fixture','controllerImage':'sha256:'+'a'*64,'key':'a'*64,'token':'b'*64,'launchId':'b'*8+'-bbbb-bbbb-bbbb-'+'b'*12}
        with patch.object(DesktopHost,'call') as call,patch('sys.platform','linux'),patch('os.getuid',return_value=1000,create=True),patch('os.getgid',return_value=1000,create=True):
            for fields in ({},{'workerImage':'abyssus-worker:m29'},{'workerImage':None}):
                with self.assertRaises(Denied):DesktopHost({**launch,**fields})
            call.assert_not_called()

    def test_exact_selected_image_never_uses_tag_and_mismatch_precedes_recovery(self):
        selected='sha256:'+'a'*64
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();(root/'runtime').mkdir();(root/'.storage-id').write_text('fixture')
            for returned in (selected,'sha256:'+'b'*64):
                calls=[]
                def query(_self,args,*_args,**_kwargs):
                    calls.append(args)
                    if args[0]=='context':return 'unix:///fixture.sock'
                    if args[0]=='info':return json.dumps({'ID':'fixture','OSType':'linux','Architecture':'amd64','SecurityOptions':[]})
                    if args[:2]==['image','inspect']:
                        self.assertEqual(args[2],selected);return returned
                    raise AssertionError('Unexpected engine call')
                with patch('os.getuid',return_value=1000,create=True),patch('os.getgid',return_value=1000,create=True),patch.object(Path,'is_socket',return_value=True),patch.object(Docker,'call',query),patch('resources.Resources') as resources,patch('attestation.Attestor'):
                    if returned==selected:
                        adapter=Docker(str(root),'fixture',str(root),'default',selected)
                        self.assertEqual(adapter.image,selected);resources.return_value.recover.assert_called_once()
                    else:
                        with self.assertRaisesRegex(Denied,'WORKER_IMAGE_CHANGED'):Docker(str(root),'fixture',str(root),'default',selected)
                        resources.assert_not_called()
                self.assertFalse(any('abyssus-worker:m29' in call for call in calls))

if __name__=='__main__':unittest.main()
