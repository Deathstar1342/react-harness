"""Fixed root-owned runner; project code always runs as the selected non-root UID.

Broker receives signed sequence records, never shell stdout as control evidence.
The signing key arrives on private root stdin and is not inherited by children.
"""
import ctypes
import re
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time

# Root module has no project imports, PYTHONPATH, site initialization or search cwd.
ROOT = Path('/run/abyssus-worker')

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)

def run(request):
    import pty
    import tty
    uid, gid = request['uid'], request['gid']
    if os.getuid() != 0 or type(uid) is not int or uid <= 0 or type(gid) is not int or gid <= 0:
        raise RuntimeError('INVALID_PRINCIPAL')
    root = '/workspace/' + request['project']
    state = ROOT / 'state.json'
    ROOT.mkdir(mode=0o700, exist_ok=True)
    os.chmod(ROOT, 0o700)
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/home/worker', 'LANG': 'C.UTF-8', 'TERM': 'dumb',
           'PS1': '', 'PS2': '', 'PROMPT_COMMAND': '', 'HISTFILE': '/dev/null', 'NO_COLOR': '1',
           'HTTP_PROXY': 'http://127.0.0.1:3128', 'HTTPS_PROXY': 'http://127.0.0.1:3128',
           'http_proxy': 'http://127.0.0.1:3128', 'https_proxy': 'http://127.0.0.1:3128',
           'NO_PROXY': 'localhost,127.0.0.1,::1', 'npm_config_cache': '/cache/npm', 'PIP_CACHE_DIR': '/cache/pip'}
    cwd = root
    if state.exists() and request['operation']['kind'] == 'shell':
        old = json.loads(state.read_text())
        cwd = old['cwd']
        if cwd != root and not cwd.startswith(root + '/') or any(part == '..' for part in cwd.split('/')):
            raise RuntimeError('CWD_CHANGED')
        env.update(old['env'])
    sequence = 0
    def emit(body):
        nonlocal sequence
        packet = {'claimId': request['claimId'], 'sequence': sequence, **body}
        signature = hmac.new(request['proofKey'].encode(), canonical(packet).encode(), hashlib.sha256).hexdigest()
        sys.stdout.write(canonical({**packet, 'mac': signature}) + '\n')
        sys.stdout.flush()
        sequence += 1
    op = request['operation']
    # File descriptors carry only untrusted cwd/env state, never exit/control evidence.
    cwd_r, cwd_w = os.pipe()
    env_r, env_w = os.pipe()
    if op['kind'] == 'shell':
        script = f"trap 'builtin pwd -P >&{cwd_w}; /usr/bin/env -0 >&{env_w}' EXIT\n" + op['command']
        argv = ['/bin/bash', '--noprofile', '--norc', '-c', script]
    else:
        # Fixed Git commands; disable all user config hooks/filter evaluation.
        argv = ['/usr/bin/git', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null', *op['args']]
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
    for name in ("BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"):
        env.pop(name, None)
    master, slave = pty.openpty()
    tty.setraw(slave)
    def drop():
        os.setsid()
        os.setgroups([])
        os.setresgid(gid, gid, gid)
        os.setresuid(uid, uid, uid)
        class Header(ctypes.Structure):
            _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]
        class Data(ctypes.Structure):
            _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]
        libc = ctypes.CDLL(None, use_errno=True)
        header = Header(0x20080522, 0)
        data = (Data * 2)()
        if libc.capset(ctypes.byref(header), ctypes.byref(data)) != 0 or libc.prctl(47, 4, 0, 0, 0) != 0 or libc.prctl(38, 1, 0, 0, 0) != 0:
            os._exit(126)
        resolved = os.path.realpath(cwd, strict=True)
        if resolved != cwd or resolved != root and not resolved.startswith(root + '/'):
            os._exit(126)
        os.chdir(cwd)
    if op['kind'] == 'git':
        fixed = ['/usr/bin/git', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']
        config = subprocess.run([*fixed, 'config', '--null', '--name-only', '--get-regexp', r'^filter\..*\.(clean|smudge|process|required)$'], cwd='/', env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, preexec_fn=drop, timeout=10)
        if config.returncode not in (0, 1) or len(config.stdout) > 65536:
            raise RuntimeError('GIT_CONFIG_UNAVAILABLE')
        overrides = []
        for name in set(config.stdout.decode('utf-8').split('\0')) - {''}:
            base = name.rsplit('.', 1)[0]
            if not base.startswith('filter.') or len(base) > 512 or any(ord(c) < 32 for c in base):
                raise RuntimeError('GIT_CONFIG_INVALID')
            for operation in ('clean', 'smudge', 'process'):
                overrides += ['-c', base + '.' + operation + '=']
            overrides += ['-c', base + '.required=false']
        argv = [*fixed, *overrides, *op['args']]
    process = subprocess.Popen(argv, cwd='/', env=env, stdin=slave, stdout=slave, stderr=slave,
                               pass_fds=(cwd_w, env_w), preexec_fn=drop, close_fds=True)
    os.close(slave)
    os.close(cwd_w)
    os.close(env_w)
    for fd in (master, cwd_r, env_r):
        os.set_blocking(fd, False)
    output_bytes = 0
    truncated = False
    snapshots = {cwd_r: b'', env_r: b''}
    capture_overflow = False
    end = time.monotonic() + request['timeoutMs'] / 1000
    timed_out = False
    try:
        while process.poll() is None:
            if time.monotonic() >= end:
                timed_out = True
                os.killpg(process.pid, signal.SIGKILL)
                break
            for fd in select.select([master, cwd_r, env_r], [], [], 0.05)[0]:
                try:
                    data = os.read(fd, 8192)
                except OSError:
                    continue
                if fd != master:
                    capture_overflow |= len(snapshots[fd]) + len(data) > 65536
                    snapshots[fd] = (snapshots[fd] + data)[:65536]
                elif data:
                    allowed = data[:max(0, request['outputLimit'] - output_bytes)]
                    truncated |= len(allowed) < len(data)
                    output_bytes += len(allowed)
                    if allowed:
                        emit({'event': 'output', 'data': base64.b64encode(allowed).decode()})
        code = process.wait(timeout=5)
        # Drain bounded buffers after actual wait; background children cannot forge exit status.
        for fd in (master, cwd_r, env_r):
            for _ in range(128):
                try:
                    data = os.read(fd, 8192)
                except OSError:
                    break
                if not data:
                    break
                if fd != master:
                    capture_overflow |= len(snapshots[fd]) + len(data) > 65536
                    snapshots[fd] = (snapshots[fd] + data)[:65536]
                else:
                    allowed = data[:max(0, request['outputLimit'] - output_bytes)]
                    truncated |= len(allowed) < len(data)
                    output_bytes += len(allowed)
                    if allowed:
                        emit({'event': 'output', 'data': base64.b64encode(allowed).decode()})
        reset = False
        if op['kind'] == 'shell':
            try:
                if capture_overflow or not snapshots[env_r].endswith(b'\0') or len(snapshots[cwd_r]) > 4096:
                    raise ValueError()
                next_cwd = snapshots[cwd_r].decode('utf-8').rstrip('\n')
                if any(ord(c) < 32 for c in next_cwd) or any(part in ('.','..') for part in next_cwd.split('/')):
                    raise ValueError()
                if next_cwd != root and not next_cwd.startswith(root + '/'):
                    raise ValueError()
                next_env = {}
                for item in snapshots[env_r].split(b'\0'):
                    if b'=' in item:
                        name, value = item.decode('utf-8').split('=', 1)
                        if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', name):
                            next_env[name] = value
                if len(canonical(next_env)) > 65536 or not next_env:
                    raise ValueError()
                state.write_text(canonical({'cwd': next_cwd, 'env': next_env}))
                os.chmod(state, 0o600)
            except (ValueError, UnicodeError):
                reset = True
                state.unlink(missing_ok=True)
        background = set()
        for attempt in range(20):
            live = []
            for entry in Path('/proc').iterdir():
                if entry.name.isdigit():
                    try:
                        status = (entry / 'status').read_text()
                        owner = re.search(r'^Uid:\s+(\d+)', status, re.M)
                        zombie = re.search(r'^State:\s+Z', status, re.M)
                        if owner and int(owner[1]) == uid and not zombie:
                            live.append(int(entry.name))
                    except (FileNotFoundError, ProcessLookupError):
                        pass
            if not live:
                break
            background.update(live)
            for pid in live:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            time.sleep(0.05)
        else:
            raise RuntimeError('DESCENDANT_CLEANUP_UNCERTAIN')
        if background:
            reset = True
            state.unlink(missing_ok=True)
        emit({'event': 'exit', 'exitCode': code, 'timedOut': timed_out, 'truncated': truncated, 'shellReset': reset, 'backgroundPids': sorted(background)[:256]})
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        for fd in (master, cwd_r, env_r):
            os.close(fd)

if __name__ == '__main__':
    raw = sys.stdin.buffer.readline(131073)
    if len(raw) > 131072:
        raise SystemExit(2)
    run(json.loads(raw))
