import json
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))
from route_probe import prove_server,verify_route
from protocol import canonical

class RetainedRoute(unittest.TestCase):
    def setUp(self):
        owner=self;self.creates=0;self.removes=0;self.lost=False;self.server=None
        class Docker:
            engine_id='fixture-engine'
            def create(self,args,image,kind):owner.creates+=1;return 'a'*64
            def find(self,container):return container
            def verify(self,row):
                return {'Mounts':[],'HostConfig':{'NetworkMode':'bridge','ReadonlyRootfs':True,'Privileged':False,'CapDrop':['ALL'],'IpcMode':'private','SecurityOpt':['no-new-privileges']},'State':{'Status':'exited','ExitCode':0}}
            def remove(self,container):owner.removes+=1
            def call(self,args,timeout,input):
                if owner.lost:raise TimeoutError()
                value=json.loads(input)
                with socket.create_connection(('127.0.0.1',value['port']),timeout=2) as peer:
                    peer.sendall((canonical({k:value[k] for k in ('version','sessionId','nonce','port')})+'\n').encode())
                    with peer.makefile('rb') as stream:result=json.loads(stream.readline())
                return canonical({**result,'address':'127.0.0.1'})
        self.docker=Docker();self.docker.resources=self.docker
        self.inventory=patch('route_probe.windows_adapters',return_value=[]);self.inventory.start()
    def tearDown(self):
        if self.server:self.server.server_close()
        self.inventory.stop()
    def test_reproof_uses_same_held_socket_with_distinct_phase_session_nonce(self):
        self.server=prove_server(self.docker,'sha256:'+'b'*64,str(uuid.uuid4()));first=dict(self.server.route);socket_id=self.server.fileno();address=self.server.server_address
        result=prove_server(self.docker,'sha256:'+'b'*64,str(uuid.uuid4()),self.server)
        self.assertIs(result,self.server);self.assertEqual(self.server.fileno(),socket_id);self.assertEqual(self.server.server_address,address)
        self.assertNotEqual(first['sessionId'],self.server.route['sessionId']);self.assertNotEqual(first['proof']['nonce'],self.server.route['proof']['nonce']);verify_route(self.server)
        self.assertEqual((self.creates,self.removes),(2,2))
    def test_failed_retained_route_never_selects_another_socket(self):
        self.server=prove_server(self.docker,'sha256:'+'b'*64,str(uuid.uuid4()));self.lost=True
        with self.assertRaisesRegex(Exception,'RETAINED_ROUTE_UNPROVEN'):prove_server(self.docker,'sha256:'+'b'*64,str(uuid.uuid4()),self.server)
        self.assertEqual((self.creates,self.removes),(2,2));self.assertEqual(self.server.fileno(),-1)

if __name__=='__main__':unittest.main()
