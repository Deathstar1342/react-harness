"""Image-owned, isolated-interpreter GET adapter. Never a host URL/HTTP proxy.

Only the trusted broker invokes this file in an exact already-owned worker.
No imports from project cwd, shell, DNS, redirect, cookies or ambient proxy env.
"""
import base64
import json
import re
import socket
import sys
import time
from urllib.parse import quote, unquote

HEADER_LIMIT = 16384
BODY_LIMIT = 4 * 1024 * 1024
SECONDS = 15
TYPES = {'text/html', 'text/plain', 'text/css', 'text/javascript', 'application/javascript',
         'application/json', 'application/wasm', 'image/png', 'image/jpeg', 'image/gif',
         'image/webp', 'image/svg+xml', 'image/x-icon', 'font/woff', 'font/woff2',
         'application/font-woff', 'font/ttf', 'font/otf'}


def require(value):
    if not value:
        raise ValueError('PREVIEW_RESPONSE_REFUSED')


def request_target(value):
    require(type(value) is str and 0 < len(value) <= 2048 and value.startswith('/') and
            all(0x21 <= ord(c) < 0x7f for c in value) and not any(c in value for c in '\\#'))
    pathname, _, query = value.partition('?')
    require(not pathname.startswith('//') and '//' not in pathname)
    require(not re.search(r'%(?![0-9A-F]{2})', value))
    decoded = unquote(pathname, errors='strict')
    require(not any(c in decoded for c in '\\%?#') and not any(ord(c) < 32 or ord(c) == 127 for c in decoded))
    require(quote(decoded, safe="/!$&'()*+,-.:;=@_~") == pathname)
    parts = decoded.split('/')[1:]
    require(all(part not in ('.', '..') for part in parts))
    require(not any(part.lower().startswith(('.env', '.git', '.ssh', '.aws', '.config')) or part in ('@fs', '@id') for part in parts))
    require(not re.search(r'%(?:0[0-9A-F]|1[0-9A-F]|7F|25|5C)', query))
    return value


def fetch(port, target):
    require(type(port) is int and 1024 <= port <= 65535 and port != 3128)
    target = request_target(target)
    deadline = time.monotonic() + SECONDS
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        def receive(count):
            remaining = deadline - time.monotonic()
            require(remaining > 0)
            sock.settimeout(min(remaining, 3))
            return sock.recv(count)
        sock.settimeout(3)
        sock.connect(('127.0.0.1', port))
        sock.sendall((f'GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n').encode('ascii'))
        data = b''
        while b'\r\n\r\n' not in data:
            block = receive(min(4096, HEADER_LIMIT + 1 - len(data)))
            require(block)
            data += block
            require(len(data.partition(b'\r\n\r\n')[0]) <= HEADER_LIMIT)
        header, _, pending = data.partition(b'\r\n\r\n')
        lines = header.decode('ascii').split('\r\n')
        match = re.fullmatch(r'HTTP/1\.[01] ([0-9]{3}) [\x20-\x7e]{0,128}', lines[0])
        require(match)
        status = int(match[1])
        require(200 <= status <= 599 and not 300 <= status <= 399)
        headers = {}
        for line in lines[1:]:
            name, sep, raw = line.partition(':')
            name = name.lower()
            require(sep and re.fullmatch('[a-z0-9-]{1,64}', name) and name not in headers and
                    all(32 <= ord(c) < 127 for c in raw))
            headers[name] = raw.strip()
        require(len(headers) <= 64 and headers.get('content-encoding', 'identity').lower() == 'identity')
        kind = headers.get('content-type', '').split(';')[0].strip().lower()
        require(kind in TYPES)
        # Only media type survives, never upstream cookies/location/security headers.
        mime = kind + ('; charset=utf-8' if kind.startswith('text/') or kind in ('application/javascript','application/json') else '')
        length = headers.get('content-length')
        transfer = headers.get('transfer-encoding')
        require(not (length is not None and transfer is not None))
        def exact_bytes(count):
            nonlocal pending
            require(0 <= count <= BODY_LIMIT + 2)
            while len(pending) < count:
                block = receive(min(65536, count-len(pending)))
                require(block)
                pending += block
            result, pending = pending[:count], pending[count:]
            return result
        body = bytearray()
        if transfer is not None:
            require(transfer.lower() == 'chunked')
            for _ in range(16384):
                while b'\r\n' not in pending:
                    require(len(pending) < 32)
                    block = receive(32-len(pending))
                    require(block)
                    pending += block
                line, _, pending = pending.partition(b'\r\n')
                require(re.fullmatch(b'[0-9A-Fa-f]{1,8}', line))
                count = int(line, 16)
                require(len(body) + count <= BODY_LIMIT)
                if count == 0:
                    require(exact_bytes(2) == b'\r\n')  # No response trailers.
                    break
                body.extend(exact_bytes(count))
                require(exact_bytes(2) == b'\r\n')
            else:
                raise ValueError('PREVIEW_CHUNK_LIMIT')
        elif length is not None:
            require(re.fullmatch('0|[1-9][0-9]{0,7}', length) and int(length) <= BODY_LIMIT)
            body.extend(exact_bytes(int(length)))
        else:
            body.extend(pending)
            while True:
                require(len(body) <= BODY_LIMIT)
                block = receive(min(65536, BODY_LIMIT + 1-len(body)))
                if not block:
                    break
                body.extend(block)
        require(len(body) <= BODY_LIMIT and time.monotonic() < deadline)
        return {'status':status, 'contentType':mime, 'body':base64.b64encode(body).decode('ascii')}


def main():
    raw = sys.stdin.buffer.readline(4097)
    require(len(raw) <= 4096 and raw.endswith(b'\n'))
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value)
            value[key] = item
        return value
    request = json.loads(raw, object_pairs_hook=pairs)
    require(type(request) is dict and set(request) == {'port','path'})
    sys.stdout.write(json.dumps(fetch(request['port'], request['path']), separators=(',', ':')) + '\n')

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No upstream body, credentials, paths or reflected header in errors.
        sys.stderr.write('PREVIEW_FETCH_FAILED\n')
        raise SystemExit(1)
