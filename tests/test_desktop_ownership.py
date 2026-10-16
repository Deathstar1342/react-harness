"""Portable exact ownership guards; no Docker/host processes are created."""
import copy
import os
import tempfile
import subprocess
import threading
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))
from desktop_host import DesktopHost
from protocol import Denied

class Ownership(unittest.TestCase):
    def setUp(self):
        self.host=object.__new__(DesktopHost);self.host.storage=Path('/storage');self.host.launch={'storageId':'storage-id'}
        self.host.owner={'id':'a'*64,'name':'owned','image':'sha256:'+'b'*64,'owner':'owner'}
        self.info={'Id':'a'*64,'Name':'/owned','Image':self.host.owner['image'],'Config':{'Labels':{'abyssus.desktop':'owner','abyssus.storage':'storage-id'},'User':'1001:1001'},'Mounts':[{'Type':'bind','Source':str(self.host.storage/source),'Destination':target,'RW':rw} for source,target,rw in [('state','/abyssus',True),('config','/abyssus/profile/config',True),('workspace','/workspace',True),('runtime/control','/run/abyssus-broker',False)]],
        'HostConfig':{'Privileged':False,'ReadonlyRootfs':True,'NetworkMode':'bridge','CapDrop':['ALL'],'CapAdd':None,'Devices':[],'DeviceRequests':None,'Binds':None,'VolumesFrom':None,'PidMode':'','IpcMode':'private','UTSMode':'','Tmpfs':{'/tmp':'size=128m,mode=1777'},'Init':True,'PidsLimit':128,'Memory':2147483648,'NanoCpus':2000000000,'SecurityOpt':['no-new-privileges'],'PortBindings':{'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':''}]}}}
        self.host.call=lambda args: 'a'*64+'\n' if args[0]=='ps' else json.dumps([self.info])
        self.uid=patch('desktop_host.os.getuid',return_value=1001,create=True);self.gid=patch('desktop_host.os.getgid',return_value=1001,create=True);self.uid.start();self.gid.start()
    def tearDown(self):self.uid.stop();self.gid.stop()
    def test_actual_docker_bridge_normalization_is_exact(self):
        self.assertEqual(self.host.owned()['Id'],'a'*64)
        for mode in ['default','host','none','custom','container:other']:
            with self.subTest(mode=mode):
                self.info['HostConfig']['NetworkMode']=mode
                with self.assertRaisesRegex(Denied,'CONTROLLER_NETWORK_CHANGED'):self.host.owned()
    def test_additional_mounts_and_writable_control_are_refused(self):
        original=copy.deepcopy(self.info)
        self.info['Mounts'].append({'Type':'volume','Source':'untrusted','Destination':'/extra','RW':True})
        with self.assertRaises(Denied):self.host.owned()
        self.info=original;self.info['Mounts'][-1]['RW']=True
        with self.assertRaisesRegex(Denied,'CONTROLLER_MOUNTS_CHANGED'):self.host.owned()
    def test_privilege_devices_and_namespaces_are_refused(self):
        original=copy.deepcopy(self.info)
        for field,value in [('CapAdd',['SYS_ADMIN']),('Devices',[{}]),('VolumesFrom',['other']),('PidMode','host'),('IpcMode','host'),('ReadonlyRootfs',False),('Privileged',True)]:
            with self.subTest(field=field):
                self.info=copy.deepcopy(original);self.info['HostConfig'][field]=value
                with self.assertRaises(Denied):self.host.owned()
    def test_exact_owned_identity_is_required_before_configuration(self):
        self.info['Config']['Labels']['abyssus.desktop']='other'
        with self.assertRaisesRegex(Denied,'OWNERSHIP_CHANGED'):self.host.owned()
    def test_absence_is_observation_not_cleanup_success(self):
        self.host.call=lambda args:''
        self.assertIsNone(self.host.owned())
        self.host.storage_check=lambda:None;self.host.stopped_receipt=lambda:False
        self.assertEqual(self.host.dispatch({'op':'stopped'}),{'stopped':False})
        with self.assertRaisesRegex(Denied,'CONTROLLER_DRAIN_UNVERIFIED'):self.host.dispatch({'op':'drain'})


class BrokerExit(unittest.TestCase):
    @unittest.skipUnless(os.name=='posix','actual Linux lifetime lease')
    def test_reconnected_supervisor_waits_for_listener_teardown_lease(self):
        root=Path(tempfile.mkdtemp(prefix='m31-broker-exit-'));runtime=root/'runtime';runtime.mkdir(mode=0o700);(runtime/'control').mkdir(mode=0o700)
        (runtime/'control/session.json').write_text('fixture')
        code="import fcntl,sys;from pathlib import Path;p=Path(sys.argv[1]);f=(p/'broker.lock').open('a');fcntl.flock(f,fcntl.LOCK_EX);print('held',flush=True);sys.stdin.readline();(p/'control/session.json').unlink();f.close()"
        child=subprocess.Popen([sys.executable,'-I','-B','-c',code,str(runtime)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(),'held')
            (runtime/'broker.lock').chmod(0o600)
            host=object.__new__(DesktopHost);host.storage=root;host.broker=None
            done=threading.Event();errors=[]
            def wait():
                try:host.wait_broker_exit()
                except BaseException as error:errors.append(error)
                finally:done.set()
            thread=threading.Thread(target=wait);thread.start()
            self.assertFalse(done.wait(.1));child.stdin.write('close\n');child.stdin.flush();self.assertEqual(child.wait(timeout=10),0)
            self.assertTrue(done.wait(10));thread.join();self.assertEqual(errors,[])
        finally:
            if child.poll() is None:child.kill();child.wait(timeout=10)

if __name__=='__main__':unittest.main()
