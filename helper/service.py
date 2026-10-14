"""Root-only fixed-location service. Invoked exclusively by trusted launcher."""
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import socket
import sqlite3
import struct
import sys

sys.path.insert(0, "/usr/lib/abyssus-helper")
from core import Audit, Engine, Rejected, authenticate, canonical, exact, require, PROTOCOL
from apt_adapter import AptAdapter

ROOT = Path("/var/lib/abyssus-helper")
CONFIG = Path("/etc/abyssus-helper/config.json")
SOCKET = "/run/abyssus-helper/control.sock"


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: require(False))


def main():
    require(os.getuid() == 0, "ROOT_REQUIRED")
    os.chdir("/")
    os.umask(0o077)
    config = strict_json(CONFIG.read_bytes())
    exact(config, ["version", "uid", "gid", "installationId", "key"])
    require(config["version"] == 1 and type(config["uid"]) is int and config["uid"] > 0)
    # Lifetime lock includes every project/backend and recovery. Never unlink it.
    lock = open(ROOT / "service.lock", "a+b")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    audit = Audit(ROOT / "audit.sqlite")
    engine = Engine(audit, AptAdapter(config["installationId"]))
    engine.adapter.target()
    if os.path.lexists(SOCKET):
        require(Path(SOCKET).is_socket(), "UNSAFE_SOCKET")
        os.unlink(SOCKET)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(SOCKET)
    os.chown(SOCKET, config["uid"], config["gid"])
    os.chmod(SOCKET, 0o600)
    listener.listen(8)
    while True:
        connection, _ = listener.accept()
        with connection:
            nonce = None
            try:
                connection.settimeout(5)
                _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                require(uid == config["uid"], "UNAUTHORIZED_PRINCIPAL")
                chunks = bytearray()
                while not chunks.endswith(b"\n"):
                    chunk = connection.recv(4096)
                    require(chunk and len(chunks) + len(chunk) <= 16384, "REQUEST_TOO_LARGE")
                    chunks.extend(chunk)
                require(b"\n" not in chunks[:-1], "INVALID_FRAMING")
                envelope = strict_json(chunks)
                action, body = authenticate(envelope, config["key"], audit)
                nonce = envelope["nonce"]
                result = engine.dispatch(action, body)
                response = {"protocol": PROTOCOL, "nonce": nonce, "ok": True, "result": result}
            except Exception as error:
                response = {"protocol": PROTOCOL, "nonce": nonce, "ok": False,
                            "error": str(error) if isinstance(error, Rejected) else "HELPER_FAILED"}
            # Lost responses never cancel or replay the transaction.
            response["mac"] = hmac.new(config["key"].encode(), canonical(response).encode(), hashlib.sha256).hexdigest()
            try:
                connection.sendall((canonical(response) + "\n").encode())
            except OSError:
                pass


if __name__ == "__main__":
    main()
