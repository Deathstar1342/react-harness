"""Explicit administrator entrypoints, after trusted artifact staging.

No passwords, package installs, shell interpolation, or automatic dpkg repair.
"""
import fcntl
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import subprocess
import sys
import uuid

CODE = Path("/usr/lib/abyssus-helper")
CONFIG = Path("/etc/abyssus-helper")
STATE = Path("/var/lib/abyssus-helper")
UNIT = Path("/etc/systemd/system/abyssus-helper.service")


def directory(path, mode):
    if path.exists() or path.is_symlink():
        st = path.lstat()
        if path.is_symlink() or not path.is_dir() or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError("UNSAFE_ADMIN_DIRECTORY")
    else:
        path.mkdir(mode=mode)
    os.chmod(path, mode)


def write(path, data, mode=0o600):
    temporary = path.with_name(path.name + ".new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except BaseException:
        if temporary.exists():
            temporary.unlink()
        raise


def systemctl(*args):
    subprocess.run(["/usr/bin/systemctl", *args], check=True, cwd="/", env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    if os.getuid() != 0 or not Path("/run/systemd/system").is_dir():
        raise RuntimeError("ROOT_AND_SYSTEMD_REQUIRED")
    os.umask(0o077)
    action = sys.argv[1]
    directory(STATE, 0o700)
    # Admin operations cannot race each other. Service is stopped before its lock is acquired.
    admin_lock = open(STATE / "admin.lock", "a+b")
    fcntl.flock(admin_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    exists = (CONFIG / "config.json").exists()
    if action == "setup" and exists:
        raise RuntimeError("ALREADY_CONFIGURED_USE_REPAIR")
    if action in ("repair", "uninstall") and not exists:
        raise RuntimeError("NOT_CONFIGURED")
    if exists:
        config = json.loads((CONFIG / "config.json").read_text())
        systemctl("stop", "abyssus-helper.service")
    else:
        uid = int(sys.argv[2])
        if uid <= 0:
            raise RuntimeError("NONROOT_UID_REQUIRED")
        account = pwd.getpwuid(uid)
        identity = STATE / "identity.json"
        if identity.exists():
            installation_id = str(uuid.UUID(json.loads(identity.read_text())["installationId"]))
        else:
            installation_id = str(uuid.uuid4())
            write(identity, json.dumps({"installationId": installation_id}))
        config = {"version": 1, "uid": uid, "gid": account.pw_gid, "installationId": installation_id}
    service_lock = open(STATE / "service.lock", "a+b")
    fcntl.flock(service_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if action == "uninstall":
        systemctl("disable", "abyssus-helper.service")
        UNIT.unlink()
        # These fixed root-owned directories contain only helper authority/artifacts.
        shutil.rmtree(CONFIG)
        shutil.rmtree(CODE)
        systemctl("daemon-reload")
        print("UNINSTALLED_AUDIT_AND_PACKAGES_PRESERVED")
        return
    directory(CONFIG, 0o711)
    config["key"] = secrets.token_hex(32)
    write(CONFIG / "config.json", json.dumps(config))
    descriptor = {"protocol": "abyssus-helper-v1", "key": config["key"], "uid": config["uid"],
                  "installationId": config["installationId"], "socket": "/run/abyssus-helper/control.sock"}
    credential = CONFIG / "client.json"
    write(credential, json.dumps(descriptor))
    subprocess.run(["/usr/bin/setfacl", "-m", f"u:{config['uid']}:r--", str(credential)], check=True,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   env={"PATH": "/usr/bin:/bin"}, cwd="/")
    write(UNIT, (CODE / "abyssus-helper.service").read_text(), 0o644)
    systemctl("daemon-reload")
    systemctl("enable", "abyssus-helper.service")
    fcntl.flock(service_lock, fcntl.LOCK_UN)
    systemctl("start", "abyssus-helper.service")
    print("HELPER_CONFIGURED" if action == "setup" else "HELPER_REPAIRED_NO_PACKAGE_REPLAY")


if __name__ == "__main__":
    main()
