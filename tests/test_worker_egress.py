import importlib.util
from pathlib import Path
import socket
import unittest

spec = importlib.util.spec_from_file_location('worker_egress', Path(__file__).parents[1] / 'containers/broker/egress.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

class Egress(unittest.TestCase):
    def resolve(self, ips):
        return lambda *args: [(socket.AF_INET6 if ':' in ip else socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 443)) for ip in ips]
    def test_private_raw_mapped_reserved_and_metadata_targets_rejected(self):
        for ip in ['127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '100.100.100.200', '::1', 'fe80::1', 'fd00::1', '::ffff:8.8.8.8']:
            with self.subTest(ip=ip), self.assertRaises(p.Refused):
                p.public_addresses('example.org', 443, self.resolve([ip]))
    def test_dns_connection_pins_public_answer_and_rejects_mixed_answers(self):
        result = p.public_addresses('example.org', 443, self.resolve(['8.8.8.8']))
        self.assertEqual(result[0][3][0], '8.8.8.8')
        with self.assertRaises(p.Refused):
            p.public_addresses('example.org', 443, self.resolve(['8.8.8.8', '127.0.0.1']))
    def test_alternate_literal_and_arbitrary_ports_never_reach_resolver(self):
        def forbidden(*args):
            self.fail('Unsafe target reached DNS')
        for host in ['127.1', '0177.0.0.1', '0x7f000001', '2130706433', 'example.org@127.0.0.1', 'a%00b', '[::1]', '/run/broker.sock']:
            with self.subTest(host=host), self.assertRaises(p.Refused):
                p.public_addresses(host, 443, forbidden)
        with self.assertRaises(p.Refused):
            p.public_addresses('example.org', 2375, forbidden)
    def test_connect_preserves_tls_and_http_strips_proxy_credentials(self):
        self.assertEqual(p.request_header(b'CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443'), ('example.org', 443, None))
        host, port, header = p.request_header(b'GET http://example.org/a?q=x HTTP/1.1\r\nHost: example.org\r\nProxy-Authorization: secret')
        self.assertEqual((host, port), ('example.org', 80))
        self.assertIn(b'GET /a?q=x HTTP/1.1', header)
        self.assertNotIn(b'secret', header)
        self.assertIn(b'Connection: close', header)
    def test_bad_schemes_smuggling_credentials_and_header_mismatch(self):
        for raw in [b'CONNECT example.org:2375 HTTP/1.1', b'GET file:///etc/passwd HTTP/1.1', b'GET http://user:pass@example.org HTTP/1.1', b'GET http://example.org HTTP/1.1\r\nHost: evil.org', b'GET http://example.org HTTP/1.1\r\nHost: example.org\r\nHost: example.org', b'GET http://example.org HTTP/1.1\r\nHost: example.org\r\nContent-Length: 1\r\nTransfer-Encoding: chunked', b'CONNECT [::1]:443 HTTP/1.1']:
            with self.subTest(raw=raw), self.assertRaises(p.Refused):
                p.request_header(raw)

if __name__ == '__main__':
    unittest.main()
