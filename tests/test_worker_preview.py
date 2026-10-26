"""Portable controlled HTTP and doubled broker tests; not container acceptance."""
import base64
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parents[1]/'containers/broker'))
from previews import _helper
from protocol import Journal,Denied
from server import Broker

class HTTPFixture:
    def __init__(self,response,delay=0):
        self.socket=socket.socket();self.socket.bind(('127.0.0.1',0));self.socket.listen();self.port=self.socket.getsockname()[1];self.request=b'';self.response=response;self.delay=delay
        self.thread=threading.Thread(target=self.run,daemon=True);self.thread.start()
    def run(self):
        try:
            with self.socket.accept()[0] as client:
                client.settimeout(2)
                while b'\r\n\r\n' not in self.request:self.request+=client.recv(4096)
                time.sleep(self.delay)
                client.sendall(self.response)
        except OSError:pass
        finally:self.socket.close()
    def fetch(self,path='/'):
        try:return _helper.fetch(self.port,path)
        finally:self.thread.join(timeout=3)

class Helper(unittest.TestCase):
    def test_only_canonical_relative_targets(self):
        for target in ['http://127.0.0.1:1/','//private','/a/../b','/%2E%2E/b','/%2Fapi','/%5Capi','/%252E','/a\\b','/x#fragment','/x\r\nHost:bad','/.env','/.git/config','/@fs/etc/passwd','/x?x=%00','/x?x=%25','/a//b']:
            with self.subTest(target=target),self.assertRaises((ValueError,UnicodeError)):_helper.request_target(target)
        for target in ['/','/src/App.tsx?t=123','/@vite/client','/a%20b.png','/page?test=one%20two']:
            self.assertEqual(_helper.request_target(target),target)
        for port in [True,1,3128,65536,'3000']:
            with self.assertRaises(ValueError):_helper.fetch(port,'/')
    def test_actual_get_uses_literal_loopback_and_no_incoming_or_environment_credentials(self):
        f=HTTPFixture(b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nSet-Cookie: secret=x\r\nContent-Security-Policy: unsafe\r\nContent-Length: 5\r\n\r\nhello')
        with patch.dict('os.environ',{'HTTP_PROXY':'http://invalid','STARK_API_KEY':'PRIVATE_SENTINEL'}),patch('socket.getaddrinfo',side_effect=AssertionError('DNS must not run')):
            result=f.fetch('/page?t=1')
        self.assertEqual(result,{'status':200,'contentType':'text/html; charset=utf-8','body':base64.b64encode(b'hello').decode()})
        self.assertEqual(f.request,(f'GET /page?t=1 HTTP/1.1\r\nHost: 127.0.0.1:{f.port}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n').encode())
    def test_refuses_redirects_upgrades_encodings_conflicting_duplicate_or_large_headers(self):
        replies=[b'HTTP/1.1 302 Found\r\nLocation: http://private/\r\nContent-Type: text/html\r\nContent-Length: 0\r\n\r\n',b'HTTP/1.1 101 Upgrade\r\n\r\n',b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n',b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n',b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n',b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Padding: '+b'a'*17000+b'\r\n\r\n']
        for response in replies:
            with self.subTest(response=response[:60]),self.assertRaises(ValueError):HTTPFixture(response).fetch()
    def test_body_size_framing_chunks_and_type_are_bounded(self):
        for suffix in [b'Content-Length: 4194305\r\n\r\n',b'Content-Length: 3\r\n\r\na',b'Transfer-Encoding: chunked\r\n\r\n400001\r\n',b'Transfer-Encoding: chunked\r\n\r\n1\r\na\r\n0\r\nX-Trailer: bad\r\n\r\n']:
            with self.assertRaises(ValueError):HTTPFixture(b'HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\n'+suffix).fetch()
        with self.assertRaises(ValueError):HTTPFixture(b'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 0\r\n\r\n').fetch()
        result=HTTPFixture(b'HTTP/1.1 200 OK\r\nContent-Type: text/css\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n').fetch()
        self.assertEqual(base64.b64decode(result['body']),b'abc')
    def test_absolute_deadline(self):
        with patch.object(_helper,'SECONDS',.05),self.assertRaises((ValueError,OSError)):HTTPFixture(b'HTTP/1.1 200 OK\r\n\r\n',delay=.15).fetch()

class Docker:
    def __init__(self):self.contexts={};self.images={};self.storage_id=str(uuid.uuid4());self.image='sha256:'+'a'*64;self.checked=0;self.closed=[];self.env={'PATH':'fixture'}
    def preview_verify(self,owned):self.checked+=1
    def storage_barrier(self):pass
    def argv(self,args):return ['fixed-docker',*args]
    def process_options(self):return {}
    def close(self,context):self.closed.append(context);self.contexts.pop(context,None)

class FakeCLI:
    def __init__(self,data):self.stdin=io.BytesIO();self.stdout=io.BytesIO(data);self.stderr=io.BytesIO();self.killed=False
    def poll(self):return 0
    def wait(self,timeout=None):return 0
    def kill(self):self.killed=True

class OwnedTransport(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.docker=Docker();self.docker.storage=Path(self.tmp.name);self.journal=Journal(str(Path(self.tmp.name)/'claims.sqlite'),str(uuid.uuid4()));self.broker=Broker(self.journal,self.docker)
        request={'claimId':str(uuid.uuid4()),'project':'project','contextId':'b'*64,'operation':{'kind':'shell','command':'foreground server','previewPort':3001},'timeoutMs':10000,'outputLimit':1000}
        identity={'storageId':self.docker.storage_id,'projectId':'c'*64,'imageId':self.docker.image,'layout':'d'*64}
        self.record=self.journal.prepare(request,identity);self.record['state']='running';self.journal.save(self.record)
        self.docker.contexts[request['contextId']]={'project':'project','identity':identity,'container':'e'*64}
        self.token={key:self.record[key] for key in ('claimId','binding')}
        self.body=b'fixture asset'*5000
        self.reply=(json.dumps({'status':200,'contentType':'text/javascript; charset=utf-8','body':base64.b64encode(self.body).decode()})+'\n').encode()
    def tearDown(self):self.journal.db.close();self.tmp.cleanup()
    def open(self):
        with patch('previews.subprocess.Popen',return_value=FakeCLI(self.reply)) as launch:
            result=self.broker.dispatch('preview_open',{**self.token,'path':'/src/app.js'})
            args=launch.call_args.args[0]
            self.assertEqual(args[:6],['fixed-docker','exec','-i','--user','0:0','e'*64]);self.assertEqual(args[-1],'/opt/abyssus-worker/preview-http.py')
            return result
    def test_bound_pages_monotonic_no_refetch_and_close(self):
        result=self.open();offset=0;output=b'';checked=self.docker.checked
        while offset<result['totalBytes']:
            with patch('previews.subprocess.Popen',side_effect=AssertionError('read must not execute helper')):
                page=self.broker.dispatch('preview_read',{**self.token,'handle':result['handle'],'offset':offset})
            output+=base64.b64decode(page['data']);self.assertLessEqual(page['nextOffset']-offset,32768);offset=page['nextOffset']
        self.assertEqual(output,self.body);self.assertGreater(self.docker.checked,checked)
        with self.assertRaisesRegex(Denied,'CURSOR'):self.broker.dispatch('preview_read',{**self.token,'handle':result['handle'],'offset':0})
        self.broker.dispatch('preview_close',{**self.token,'handle':result['handle']});self.assertEqual(self.broker.previews.buffers,{})
    def test_refuses_arbitrary_targets_ports_headers_and_stale_session(self):
        for extra in [{'host':'127.0.0.1'},{'port':3128},{'headers':{}},{'socket':'/var/run/docker.sock'}]:
            with self.assertRaises(Denied):self.broker.dispatch('preview_open',{**self.token,'path':'/',**extra})
        result=self.open();self.journal.session=str(uuid.uuid4())
        with self.assertRaisesRegex(Denied,'CLAIM_MISMATCH'):self.broker.dispatch('preview_read',{**self.token,'handle':result['handle'],'offset':0})
    def test_cancel_invalidates_buffers_before_exact_cleanup(self):
        result=self.open();original=self.docker.close
        def close(context):self.assertEqual(self.broker.previews.buffers,{});original(context)
        self.docker.close=close;self.broker.dispatch('cancel',self.token)
        with self.assertRaises(Denied):self.broker.dispatch('preview_read',{**self.token,'handle':result['handle'],'offset':0})
        self.assertEqual(self.docker.closed,[self.record['contextId']])
    def test_retained_buffer_expiry_and_capacity(self):
        result=self.open();self.broker.previews.buffers[result['handle']]['expires']=0
        with self.assertRaisesRegex(Denied,'STALE'):self.broker.dispatch('preview_read',{**self.token,'handle':result['handle'],'offset':0})
        for _ in range(8):self.open()
        with patch('previews.subprocess.Popen',side_effect=AssertionError('capacity before exec')),self.assertRaisesRegex(Denied,'BUFFER_LIMIT'):self.broker.dispatch('preview_open',{**self.token,'path':'/'})
    def test_uncertain_or_finished_claim_never_reopens(self):
        for state in ('prepared','accepted','finished','uncertain'):
            self.record['state']=state;self.journal.save(self.record)
            with patch('previews.subprocess.Popen',side_effect=AssertionError('stale before exec')),self.assertRaisesRegex(Denied,'STALE'):self.broker.dispatch('preview_open',{**self.token,'path':'/'})

if __name__=='__main__':unittest.main()
