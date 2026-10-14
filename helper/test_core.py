import contextlib
import hashlib
import hmac
import json
import os
import tempfile
import unittest
from unittest.mock import patch
from core import Audit, Engine, Rejected, authenticate, canonical, digest, now, package_request, PROTOCOL


class Adapter:
    calls = 0
    revision = 1
    fail = False
    def target(self):
        return {"id": "a" * 64}
    def lock(self):
        return contextlib.nullcontext()
    def preview(self, request):
        return {"target": self.target(), "revision": self.revision, "packages": request["packages"]}
    def install(self):
        self.calls += 1
        if self.fail:
            raise RuntimeError("untrusted output with secret")
    def reconcile(self, preview):
        return {"matches": True, "healthy": True, "packages": preview["packages"]}


class CoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = os.path.join(self.tmp.name, "audit.sqlite")
        self.audit = Audit(self.file)
        self.adapter = Adapter()
        self.engine = Engine(self.audit, self.adapter)
        self.request = {"requestId": "12345678-1234-1234-1234-123456789012", "targetId": "a" * 64,
                        "manager": "apt", "packages": [{"name": "hello", "version": "2.10-3"}]}
    def tearDown(self):
        self.audit.db.close()
        self.tmp.cleanup()
    def prepare(self):
        record = self.engine.dispatch("prepare", self.request)
        return {"requestId": self.request["requestId"], "previewDigest": record["previewDigest"],
                "decisionNonce": "b" * 64, "expiresAt": now() + 60000}
    def test_exact_schema(self):
        for name in ["--help", "./a.deb", "a;id", "a\nb", "hello:amd64", "Aaa"]:
            with self.subTest(name=name), self.assertRaises(Rejected):
                package_request({**self.request, "packages": [{"name": name, "version": "1"}]})
        with self.assertRaises(Rejected):
            package_request({**self.request, "options": []})
        with self.assertRaises(Rejected):
            package_request({**self.request, "manager": "pip"})
    def test_single_use_and_duplicate(self):
        decision = self.prepare()
        with self.assertRaises(Rejected):
            self.engine.dispatch("prepare", self.request)
        self.engine.dispatch("authorize", decision)
        result = self.engine.dispatch("execute", decision)
        self.assertEqual(result["state"], "succeeded")
        with self.assertRaises(Rejected):
            self.engine.dispatch("execute", decision)
        self.assertEqual(self.adapter.calls, 1)
    def test_stale_plan_consumed(self):
        decision = self.prepare()
        self.engine.dispatch("authorize", decision)
        self.adapter.revision += 1
        result = self.engine.dispatch("execute", decision)
        self.assertEqual((result["state"], result["code"]), ("failed", "STALE_PREVIEW"))
        self.assertEqual(self.adapter.calls, 0)
    def test_forged_and_expired(self):
        decision = self.prepare()
        with self.assertRaises(Rejected):
            self.engine.dispatch("authorize", {**decision, "previewDigest": "0" * 64})
        with self.assertRaises(Rejected):
            self.engine.dispatch("authorize", {**decision, "expiresAt": now() - 1})
        self.engine.dispatch("authorize", decision)
        with self.assertRaises(Rejected):
            self.engine.dispatch("execute", {**decision, "decisionNonce": "c" * 64})
    def test_pre_effect_durability(self):
        decision = self.prepare()
        self.engine.dispatch("authorize", decision)
        original = self.audit.save
        def fail_running(record, new=False):
            if record["state"] == "running":
                raise OSError("disk failed")
            return original(record, new)
        with patch.object(self.audit, "save", fail_running):
            result = self.engine.dispatch("execute", decision)
        self.assertEqual(self.adapter.calls, 0)
        self.assertEqual(result["state"], "uncertain")
    def test_interrupt_restart_never_replays(self):
        decision = self.prepare()
        self.engine.dispatch("authorize", decision)
        record = self.audit.get(self.request["requestId"])
        record["state"] = "running"
        self.audit.save(record)
        self.audit.db.close()
        self.audit = Audit(self.file)
        self.engine = Engine(self.audit, self.adapter)
        self.assertEqual(self.audit.get(record["requestId"])["state"], "uncertain")
        with self.assertRaises(Rejected):
            self.engine.dispatch("execute", decision)
        reconciled = self.engine.dispatch("reconcile", {"requestId": record["requestId"]})
        self.assertEqual(reconciled["state"], "uncertain")
        self.assertEqual(self.adapter.calls, 0)
    def test_exception_is_sanitized_and_uncertain(self):
        decision = self.prepare()
        self.engine.dispatch("authorize", decision)
        self.adapter.fail = True
        result = self.engine.dispatch("execute", decision)
        self.assertEqual(result["state"], "uncertain")
        self.assertNotIn("secret", json.dumps(result))
    def test_auth_and_replay(self):
        envelope = {"protocol": PROTOCOL, "nonce": "d" * 64, "expiresAt": now() + 10000,
                    "action": "hello", "body": {}}
        envelope["mac"] = hmac.new(b"test", canonical(envelope).encode(), hashlib.sha256).hexdigest()
        with self.assertRaises(Rejected):
            authenticate(envelope, "wrong", self.audit)
        self.assertEqual(authenticate(envelope, "test", self.audit), ("hello", {}))
        with self.assertRaises(Rejected):
            authenticate(envelope, "test", self.audit)
    def test_lock_failure_consumes_execute_but_never_installs(self):
        decision = self.prepare()
        self.engine.dispatch("authorize", decision)
        with patch.object(self.adapter, "lock", side_effect=RuntimeError("locked")):
            result = self.engine.dispatch("execute", decision)
        self.assertEqual(result["state"], "failed")
        self.assertEqual(self.adapter.calls, 0)
        with self.assertRaises(Rejected):
            self.engine.dispatch("execute", decision)
    def test_restart_expires_authorized_records(self):
        decision = self.prepare()
        self.engine.dispatch("authorize", decision)
        self.audit.db.close()
        self.audit = Audit(self.file)
        self.engine = Engine(self.audit, self.adapter)
        self.assertEqual(self.audit.get(self.request["requestId"])["state"], "failed")
        with self.assertRaises(Rejected):
            self.engine.dispatch("execute", decision)
    def test_unhealthy_reconciliation_cannot_clear_recovery(self):
        decision = self.prepare()
        self.engine.dispatch("authorize", decision)
        self.adapter.fail = True
        self.engine.dispatch("execute", decision)
        with patch.object(self.adapter, "reconcile", return_value={"healthy": False, "matches": False}):
            self.engine.dispatch("reconcile", {"requestId": self.request["requestId"]})
        self.assertTrue(self.audit.unresolved())
    def test_target_substitution_consumes_decision(self):
        decision = self.prepare()
        self.engine.dispatch("authorize", decision)
        with patch.object(self.adapter, "target", return_value={"id": "b" * 64}):
            result = self.engine.dispatch("execute", decision)
        self.assertEqual(result["code"], "WRONG_TARGET")
        self.assertEqual(self.adapter.calls, 0)


if __name__ == "__main__":
    unittest.main()
