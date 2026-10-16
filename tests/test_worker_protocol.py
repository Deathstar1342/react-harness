import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import uuid

spec = importlib.util.spec_from_file_location('worker_protocol', Path(__file__).parents[1] / 'containers/broker/protocol.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

class Claims(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.file = str(Path(self.temp.name) / 'claims.sqlite')
        self.session = str(uuid.uuid4())
        self.j = p.Journal(self.file, self.session)
        self.request = {'claimId': str(uuid.uuid4()), 'project': 'project', 'contextId': 'a' * 64,
                        'operation': {'kind': 'shell', 'command': 'printf hello'}, 'timeoutMs': 1000, 'outputLimit': 1024}
        self.identity = {'storageId': str(uuid.uuid4()), 'projectId': 'b' * 64, 'imageId': 'sha256:' + 'c' * 64}
    def tearDown(self):
        self.j.db.close()
        self.temp.cleanup()
    def prepared(self):
        r = self.j.prepare(self.request, self.identity)
        return {'claimId': r['claimId'], 'binding': r['binding']}
    def test_exact_single_activation_and_replay_denial(self):
        token = self.prepared()
        self.assertEqual(self.j.get(token['claimId'])['state'], 'prepared')
        self.assertEqual(self.j.activate(token, self.identity)['state'], 'accepted')
        with self.assertRaisesRegex(p.Denied, 'CONSUMED'):
            self.j.activate(token, self.identity)
    def test_replacement_image_and_foreign_claim_reject_before_acceptance(self):
        token = self.prepared()
        with self.assertRaisesRegex(p.Denied, 'IDENTITY_CHANGED'):
            self.j.activate(token, {**self.identity, 'imageId': 'sha256:' + 'd' * 64})
        with self.assertRaisesRegex(p.Denied, 'CLAIM_MISMATCH'):
            self.j.activate({**token, 'binding': 'e' * 64}, self.identity)
        self.assertEqual(self.j.get(token['claimId'])['state'], 'prepared')
    def test_restart_never_replays_accepted_and_invalidates_prepared(self):
        token = self.prepared()
        self.j.activate(token, self.identity)
        self.request['claimId'] = str(uuid.uuid4())
        other = self.prepared()
        self.j.db.close()
        self.j = p.Journal(self.file, str(uuid.uuid4()))
        self.assertEqual(self.j.get(token['claimId'])['state'], 'uncertain')
        self.assertEqual(self.j.get(other['claimId'])['state'], 'expired')
        with self.assertRaisesRegex(p.Denied, 'CLAIM_MISMATCH'):
            self.j.activate(token, self.identity)
    def test_preparation_cancel_is_consumed_but_accepted_cancel_is_not_no_effect(self):
        token = self.prepared()
        self.j.cancel_prepared(token)
        with self.assertRaisesRegex(p.Denied, 'CONSUMED'):
            self.j.activate(token, self.identity)
        self.request['claimId'] = str(uuid.uuid4())
        other = self.prepared()
        self.j.activate(other, self.identity)
        with self.assertRaisesRegex(p.Denied, 'CONSUMED'):
            self.j.cancel_prepared(other)
    def test_authentication_binds_body_session_and_durable_nonce(self):
        key = 'f' * 64
        e = {'protocol': p.PROTOCOL, 'sessionId': self.session, 'nonce': 'a' * 64, 'expiresAt': p.now() + 15000, 'op': 'prepare', 'body': self.request}
        e['mac'] = p.mac(e, key)
        tampered = copy.deepcopy(e)
        tampered['body']['operation']['command'] = 'touch unintended'
        with self.assertRaisesRegex(p.Denied, 'AUTH_FAILED'):
            self.j.authenticate(tampered, key)
        self.assertEqual(self.j.authenticate(e, key)[0], 'prepare')
        with self.assertRaisesRegex(p.Denied, 'REPLAY'):
            self.j.authenticate(e, key)
        self.j.db.close()
        self.j = p.Journal(self.file, self.session)
        with self.assertRaisesRegex(p.Denied, 'REPLAY'):
            self.j.authenticate(e, key)
    def test_strict_wire_unicode_numbers_and_duplicates(self):
        for raw in [b'{"op":1,"op":2}\n', b'{"x":NaN}\n', b'{"x":1.5}\n', b'{"x":9007199254740992}\n', b'{"x":"\\ud800"}\n', b'{}\n{}\n', b'\xff\n']:
            with self.subTest(raw=raw), self.assertRaises(p.Denied):
                p.decode(raw)
        value = {'z': '\U0001f4a1', 'a': '\u00e9'}
        self.assertEqual(p.canonical(value), '{"a":"\\u00e9","z":"\\ud83d\\udca1"}')
        self.assertEqual(p.decode((p.canonical(value) + '\n').encode()), value)
    def test_no_host_options_or_unbounded_requests(self):
        for update in [{'image': 'evil'}, {'project': '../config'}, {'project': '/workspace/a'}, {'timeoutMs': True}, {'outputLimit': 1000001}, {'operation': {'kind': 'shell', 'command': 'x' * 65537}}]:
            with self.subTest(update=update), self.assertRaises(p.Denied):
                self.j.prepare({**self.request, **update}, self.identity)
    def test_failed_commit_cannot_publish_acceptance(self):
        token = self.prepared()
        self.j.db.execute("CREATE TRIGGER fail_accept BEFORE UPDATE ON claims BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
        with self.assertRaises(Exception):
            self.j.activate(token, self.identity)
        self.assertEqual(self.j.get(token['claimId'])['state'], 'prepared')

if __name__ == '__main__':
    unittest.main()
