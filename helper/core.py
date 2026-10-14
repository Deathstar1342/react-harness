"""Protocol-independent durable state. No package effects or automatic recovery."""
import hashlib
import hmac
import json
import re
import sqlite3
import time

PROTOCOL = "abyssus-helper-v1"
HEX = re.compile(r"[a-f0-9]{64}\Z")
IDENT = re.compile(r"[a-f0-9-]{36}\Z")
NAME = re.compile(r"[a-z0-9][a-z0-9+.-]{1,63}\Z")
VERSION = re.compile(r"[0-9][A-Za-z0-9.+:~\-]{0,127}\Z")


class Rejected(Exception):
    """Only fixed codes are returned to clients; never exception text."""


def require(ok, code="INVALID_REQUEST"):
    if not ok:
        raise Rejected(code)


def exact(value, fields):
    require(type(value) is dict and set(value) == set(fields))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def now():
    return int(time.time() * 1000)


def package_request(body):
    exact(body, ["requestId", "targetId", "manager", "packages"])
    require(type(body["requestId"]) is str and IDENT.fullmatch(body["requestId"]))
    require(type(body["targetId"]) is str and HEX.fullmatch(body["targetId"]))
    require(body["manager"] == "apt", "UNSUPPORTED_MANAGER")
    packages = body["packages"]
    require(type(packages) is list and 1 <= len(packages) <= 16)
    names = set()
    for item in packages:
        require(type(item) is dict and set(item) in ({"name"}, {"name", "version"}))
        require(type(item["name"]) is str and NAME.fullmatch(item["name"]))
        if "version" in item:
            require(type(item["version"]) is str and VERSION.fullmatch(item["version"]))
        require(item["name"] not in names)
        names.add(item["name"])


class Audit:
    def __init__(self, file):
        self.db = sqlite3.connect(file)
        self.db.execute("PRAGMA journal_mode=DELETE")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, record TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, id TEXT NOT NULL, event TEXT NOT NULL);
        """)
        for (raw,) in self.db.execute("SELECT record FROM requests").fetchall():
            record = json.loads(raw)
            if record["state"] in ("authorized", "running"):
                record["state"] = "uncertain" if record["state"] == "running" else "failed"
                record["code"] = "HELPER_RESTARTED"
                self.save(record)

    def nonce(self, nonce, expires):
        with self.db:
            self.db.execute("DELETE FROM nonces WHERE expires < ?", (now(),))
            require(self.db.execute("SELECT COUNT(*) FROM nonces").fetchone()[0] < 4096, "RATE_LIMIT")
            try:
                self.db.execute("INSERT INTO nonces VALUES(?,?)", (nonce, expires))
            except sqlite3.IntegrityError:
                raise Rejected("REPLAY") from None

    def get(self, request_id):
        require(type(request_id) is str and IDENT.fullmatch(request_id))
        row = self.db.execute("SELECT record FROM requests WHERE id=?", (request_id,)).fetchone()
        require(row is not None, "NOT_FOUND")
        return json.loads(row[0])

    def save(self, record, new=False):
        record["updatedAt"] = now()
        with self.db:
            if new:
                require(self.db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] < 10000, "AUDIT_CAPACITY")
                try:
                    self.db.execute("INSERT INTO requests VALUES(?,?)", (record["requestId"], canonical(record)))
                except sqlite3.IntegrityError:
                    raise Rejected("DUPLICATE_REQUEST") from None
            else:
                self.db.execute("UPDATE requests SET record=? WHERE id=?", (canonical(record), record["requestId"]))
            self.db.execute("INSERT INTO events(id,event) VALUES(?,?)", (record["requestId"], canonical(record)))

    def unresolved(self):
        return any(json.loads(row[0])["state"] == "uncertain" and not json.loads(row[0]).get("reconciliation", {}).get("healthy")
                   for row in self.db.execute("SELECT record FROM requests"))


def authenticate(envelope, key, audit):
    exact(envelope, ["protocol", "nonce", "expiresAt", "action", "body", "mac"])
    require(envelope["protocol"] == PROTOCOL, "PROTOCOL_MISMATCH")
    require(type(envelope["nonce"]) is str and HEX.fullmatch(envelope["nonce"]), "AUTH_FAILED")
    require(type(envelope["expiresAt"]) is int and now() < envelope["expiresAt"] <= now() + 30000, "AUTH_EXPIRED")
    require(type(envelope["mac"]) is str and HEX.fullmatch(envelope["mac"]), "AUTH_FAILED")
    unsigned = {k: v for k, v in envelope.items() if k != "mac"}
    expected = hmac.new(key.encode(), canonical(unsigned).encode(), hashlib.sha256).hexdigest()
    require(hmac.compare_digest(envelope["mac"], expected), "AUTH_FAILED")
    audit.nonce(envelope["nonce"], envelope["expiresAt"])
    return envelope["action"], envelope["body"]


class Engine:
    def __init__(self, audit, adapter):
        self.audit, self.adapter = audit, adapter

    def dispatch(self, action, body):
        if action == "hello":
            exact(body, [])
            return {"protocol": PROTOCOL, "target": self.adapter.target()}
        if action == "prepare":
            package_request(body)
            require(not self.audit.unresolved(), "RECOVERY_REQUIRED")
            require(body["targetId"] == self.adapter.target()["id"], "WRONG_TARGET")
            # Resolve under the real package-system lock; no package mutation.
            with self.adapter.lock():
                preview = self.adapter.preview(body)
            require(len(canonical(preview)) <= 128 * 1024, "UNBOUNDED_PREVIEW")
            record = {"requestId": body["requestId"], "request": body, "preview": preview,
                      "previewDigest": digest(preview), "state": "noop" if not preview["packages"] else "prepared", "createdAt": now(),
                      "expiresAt": now() + 120000, "code": "PREPARED" if preview["packages"] else "ALREADY_INSTALLED"}
            self.audit.save(record, new=True)
            return record
        if action in ("status", "reconcile"):
            exact(body, ["requestId"])
            record = self.audit.get(body["requestId"])
            if action == "reconcile":
                require(record["state"] in ("uncertain", "failed", "succeeded"), "INVALID_STATE")
                with self.adapter.lock():
                    record["reconciliation"] = self.adapter.reconcile(record["preview"])
                # Observations never rewrite the original outcome.
                self.audit.save(record)
            return record
        require(action in ("authorize", "execute"), "UNKNOWN_ACTION")
        exact(body, ["requestId", "previewDigest", "decisionNonce", "expiresAt"])
        record = self.audit.get(body["requestId"])
        require(type(body["decisionNonce"]) is str and HEX.fullmatch(body["decisionNonce"]))
        require(body["previewDigest"] == record["previewDigest"], "STALE_PREVIEW")
        require(type(body["expiresAt"]) is int and now() < body["expiresAt"] <= record["expiresAt"], "DECISION_EXPIRED")
        require(not self.audit.unresolved(), "RECOVERY_REQUIRED")
        if action == "authorize":
            require(record["state"] == "prepared", "INVALID_STATE")
            record.update(state="authorized", decision=body, code="AUTHORIZED")
            self.audit.save(record)
            return record
        require(record["state"] == "authorized" and record["decision"] == body, "INVALID_STATE")
        # A failed execute consumes this decision; no implicit retry.
        try:
            with self.adapter.lock():
                require(record["request"]["targetId"] == self.adapter.target()["id"], "WRONG_TARGET")
                fresh = self.adapter.preview(record["request"])
                require(digest(fresh) == record["previewDigest"], "STALE_PREVIEW")
                require(now() < body["expiresAt"], "DECISION_EXPIRED")
                record.update(state="running", code="RUNNING")
                self.audit.save(record)  # Must be durable before any package effect.
                self.adapter.install()
                observed = self.adapter.reconcile(record["preview"])
                require(observed["matches"] and observed["healthy"], "OUTCOME_MISMATCH")
                record.update(state="succeeded", code="INSTALLED", reconciliation=observed)
                self.audit.save(record)
        except Exception as error:
            record.update(state="uncertain" if record["state"] == "running" else "failed",
                          code=str(error) if isinstance(error, Rejected) else "PACKAGE_OPERATION_FAILED")
            self.audit.save(record)
        return record
