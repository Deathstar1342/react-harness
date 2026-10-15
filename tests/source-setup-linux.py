"""Disposable non-root Linux only: real terminal privacy and checksum rejection.

No workstation provisioning, real apt transaction, provider request or download.
"""
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
KEY = "SYNTHETIC-PRIVATE-KEY-NOT-FOR-ECHO"


def terminal(argv, env, answers, timeout=20, cwd=ROOT):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(argv[0], argv, env)
    output = bytearray()
    offset = 0
    try:
        for marker, answer in answers:
            deadline = time.monotonic() + timeout
            while marker.encode() not in output[offset:]:
                assert time.monotonic() < deadline, "Expected terminal prompt was not received"
                if select.select([fd], [], [], 0.2)[0]:
                    output.extend(os.read(fd, 8192))
            offset = len(output)
            os.write(fd, answer)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if select.select([fd], [], [], 0.2)[0]:
                try:
                    part = os.read(fd, 8192)
                except OSError:
                    break
                if not part:
                    break
                output.extend(part)
        else:
            raise AssertionError("Terminal did not finish within its deadline")
        _, status = os.waitpid(pid, 0)
        pid = 0
        assert KEY.encode() not in output, "Hidden synthetic key appeared in terminal output"
        return os.waitstatus_to_exitcode(status), bytes(output)
    except BaseException as error:
        tail = bytes(output).decode(errors="replace").replace(KEY, "[hidden synthetic key]")[-10000:]
        raise AssertionError(f"Terminal check stopped ({type(error).__name__}); sanitized output:\n{tail}") from error
    finally:
        os.close(fd)
        if pid:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)


assert os.name == "posix" and os.getuid() != 0
subprocess.run(["bash", "setup.sh", "--check"], cwd=ROOT, check=True, timeout=30)
print("PASS actual Linux read-only prerequisite and namespace check")
with tempfile.TemporaryDirectory(prefix="source-setup-pty-") as temp:
    base = pathlib.Path(temp)
    checkout = base / "fixture checkout"
    checkout.mkdir()
    home = base / "private profile"
    env = {**os.environ, "HARNESS_HOME": str(home)}
    code = "import {runGuidedSetup} from './scripts/source-setup.ts'; try { await runGuidedSetup(process.argv[1]); } catch { console.error('Setup stopped safely'); process.exitCode=1; }"
    command = [shutil.which("node"), "--import", "tsx", "--input-type=module", "-e", code, str(checkout)]
    replies = [("Profile folder [", b"\n"), ("API base URL [", b"https://fixture.invalid/v1\n"),
               ("API key (hidden", (KEY + "\n").encode()), ("architect exact", b"\n"),
               ("coder exact", b"\n"), ("critic exact", b"\n")]
    status, _ = terminal(command, env, replies)
    assert status == 0
    config = home / "profile/config/.env"
    assert KEY in config.read_text() and config.stat().st_mode & 0o777 == 0o600
    selection = (checkout / ".source-setup/home").read_text()
    assert selection == str(home) + "\n" and KEY not in selection
    marker = (home / "profile/profile.json").read_text()
    blanks = [(name, b"\n") for name, _ in replies]
    status, _ = terminal(command, env, blanks)
    assert status == 0 and KEY in config.read_text()
    assert (home / "profile/profile.json").read_text() == marker
    original = config.read_bytes()
    status, _ = terminal(command, env, replies[:2] + [("API key (hidden", b"\x03")])
    assert status != 0 and config.read_bytes() == original
    print("PASS actual PTY hidden key, private save, rerun preservation and Ctrl+C cancellation")

    # Exercise the actual launcher with a fixed npm observer instead of a server.
    (checkout / "scripts").mkdir()
    for src, dest in [(ROOT / "start.sh", checkout / "start.sh"), (ROOT / "scripts/source-common.sh", checkout / "scripts/source-common.sh")]:
        shutil.copyfile(src, dest)
    (checkout / "dist/client").mkdir(parents=True)
    (checkout / "dist/client/index.html").write_text("fixture")
    (checkout / "node_modules").mkdir()
    launch_bin = base / "launch-bin"
    launch_bin.mkdir()
    observer = launch_bin / "npm"
    observer.write_text("#!/bin/bash\nnode -e 'if(process.env.HARNESS_HOME!==process.env.EXPECTED_PROFILE || process.env.STARK_API_KEY || process.env.STARK_BASE_URL || process.env.CODER_MODEL)process.exit(1)'\n")
    observer.chmod(0o700)
    launch_env = {**os.environ, "PATH": str(launch_bin) + ":" + os.environ["PATH"], "HARNESS_HOME": "/ignored-stale-home", "EXPECTED_PROFILE": str(home), "STARK_API_KEY": KEY, "STARK_BASE_URL": "https://stale.invalid", "CODER_MODEL": "stale"}
    # source_select_node prepends the Node directory, so put the observer beside
    # an explicit Node symlink in our private bin to retain the controlled npm.
    os.symlink(shutil.which("node"), launch_bin / "node")
    subprocess.run(["bash", str(checkout / "start.sh")], env=launch_env, check=True, timeout=30)
    print("PASS actual launcher remembers profile and strips stale provider/key overrides")

    # Simulate missing Node and a tampered download. Never invoke apt or real curl.
    fake = base / "bin"
    fake.mkdir()
    for name in ["bash", "uname", "dirname", "git", "make", "g++", "python3", "tar", "xz", "sha256sum", "bwrap", "socat", "mkdir", "mktemp"]:
        os.symlink(shutil.which(name), fake / name)
    (fake / "tar").unlink()
    (fake / "tar").write_text("#!/bin/bash\nprintf unexpected > \"$TAR_SENTINEL\"\nexit 99\n")
    (fake / "curl").write_text('#!/bin/bash\n[[ -z "${STARK_API_KEY+x}" && -z "${OPENAI_API_KEY+x}" ]] || exit 88\nprintf tampered > "${!#}"\n')
    for name in ["tar", "curl"]:
        (fake / name).chmod(0o700)
    fake_home = base / "new-user"
    fake_home.mkdir()
    sentinel = base / "tar-was-run"
    fake_env = {**os.environ, "HOME": str(fake_home), "PATH": str(fake), "TAR_SENTINEL": str(sentinel), "STARK_API_KEY": KEY, "OPENAI_API_KEY": KEY}
    status, output = terminal(["/bin/bash", "setup.sh", "--no-start"], fake_env, [("Install verified Node", b"y\n")])
    assert status != 0 and b"checksum mismatch" in output and not sentinel.exists()
    assert not (fake_home / ".local/share/abyssus-source-node/node-v24.16.0-linux-x64").exists()
    print("PASS tampered runtime rejected before extraction, no sudo/download, inherited keys stripped")

    # End-to-end one-command path in a fresh disposable checkout: real verified
    # Node download/npm/build, no sudo, provider calls, preview or distro changes.
    fresh = base / "fresh checkout"
    fresh.mkdir()
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    for name in filter(None, tracked):
        src, dest = ROOT / name, fresh / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
    node_mask = base / "force-local-node"
    node_mask.mkdir()
    (node_mask / "node").write_text("#!/bin/bash\nexit 1\n")
    (node_mask / "node").chmod(0o700)
    clean_home, clean_profile = base / "clean user", base / "clean profile"
    clean_home.mkdir()
    clean_env = {**os.environ, "HOME": str(clean_home), "PATH": str(node_mask) + ":" + os.environ["PATH"], "HARNESS_HOME": str(clean_profile)}
    status, _ = terminal(["/bin/bash", "setup.sh", "--no-start"], clean_env,
                         [("Install verified Node", b"y\n"), ("Profile folder [", b"\n"),
                          ("API base URL [", b"\n"), ("API key (hidden", b"\n"),
                          ("architect exact", b"\n"), ("coder exact", b"\n"), ("critic exact", b"\n")], timeout=240, cwd=fresh)
    assert status == 0
    assert (clean_home / ".local/share/abyssus-source-node/node-v24.16.0-linux-x64/bin/node").is_file()
    assert (fresh / "dist/client/index.html").is_file()
    assert (fresh / ".source-setup/home").read_text() == str(clean_profile) + "\n"
    assert json.loads((clean_profile / "profile/profile.json").read_text())["protocol"] == "native-tools-v1"
    print("PASS complete clean source setup: verified local Node, npm/SQLite/PTY, private profile and real UI build")
