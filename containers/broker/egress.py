"""Credential-free public HTTP(S) proxy. Its only listener is a private Unix socket.

Runs separately from the Docker broker with a scrubbed environment. No filesystem,
command, management, credential, or arbitrary-port endpoint exists.
"""
import ipaddress
import re
import selectors
import socket
import socketserver
import threading
import time
from urllib.parse import urlsplit

MAX_HEADER = 16384
MAX_CONNECTIONS = 32
HOST = re.compile(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\Z')

class Refused(Exception):
    pass

def public_addresses(host, port, resolver=socket.getaddrinfo):
    if not HOST.fullmatch(host) or '..' in host or port not in (80, 443):
        raise Refused()
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None and (literal.version != 4 or not literal.is_global or str(literal) != host):
        raise Refused()
    # Reject abbreviated/octal/hex IPv4 forms instead of asking libc to interpret them.
    if literal is None and (host.replace('.', '').isdigit() or host.startswith('0x')):
        raise Refused()
    answers = resolver(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    result = []
    for family, kind, protocol, _, address in answers:
        ip = ipaddress.ip_address(address[0])
        if not ip.is_global or ip.is_multicast or ip.is_reserved or (ip.version == 6 and ip.ipv4_mapped is not None):
            raise Refused()
        # IPv6 egress is deliberately unsupported in v1; no mapped address fallback.
        if family == socket.AF_INET:
            result.append((family, kind, protocol, address))
    if not result:
        raise Refused()
    return result

def authority(value, default):
    if '@' in value or '%' in value or '[' in value or ']' in value or value.count(':') > 1:
        raise Refused()
    host, separator, port = value.partition(':')
    if separator and (not port.isascii() or not port.isdigit() or str(int(port)) != port):
        raise Refused()
    return host.lower(), int(port) if separator else default

def request_header(raw):
    try:
        text = raw.decode('ascii')
        lines = text.split('\r\n')
        method, target, version = lines[0].split(' ')
        if version != 'HTTP/1.1' or not re.fullmatch('[A-Z]{1,16}', method):
            raise Refused()
        headers = []
        seen = set()
        for line in lines[1:]:
            if not line:
                continue
            name, sep, value = line.partition(':')
            if not sep or not re.fullmatch('[A-Za-z0-9-]{1,64}', name) or any(ord(c) < 32 and c != '\t' for c in value):
                raise Refused()
            name = name.lower()
            if name in seen:
                raise Refused()
            seen.add(name)
            if name not in ('proxy-authorization', 'proxy-connection', 'connection'):
                headers.append((name, value.strip()))
        if 'transfer-encoding' in seen and 'content-length' in seen:
            raise Refused()
        if method == 'CONNECT':
            host, port = authority(target, 443)
            if port != 443:
                raise Refused()
            return host, port, None
        url = urlsplit(target)
        if url.scheme != 'http' or not url.netloc or url.fragment or url.username or url.password:
            raise Refused()
        host, port = authority(url.netloc, 80)
        if port != 80:
            raise Refused()
        expected = host + (':80' if ':' in url.netloc else '')
        if dict(headers).get('host', '').lower() != expected:
            raise Refused()
        path = url.path or '/'
        if url.query:
            path += '?' + url.query
        first = f'{method} {path} HTTP/1.1\r\n'
        forwarded = first + ''.join(f'{k}: {v}\r\n' for k, v in headers) + 'Connection: close\r\n\r\n'
        return host, port, forwarded.encode('ascii')
    except (ValueError, UnicodeError):
        raise Refused() from None

def relay(left, right, initial=b'', deadline=120):
    right.sendall(initial)
    selector = selectors.DefaultSelector()
    selector.register(left, selectors.EVENT_READ, right)
    selector.register(right, selectors.EVENT_READ, left)
    end = time.monotonic() + deadline
    try:
        while time.monotonic() < end:
            for key, _ in selector.select(min(1, max(0, end - time.monotonic()))):
                data = key.fileobj.recv(32768)
                if not data:
                    return
                key.data.sendall(data)
    finally:
        selector.close()

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        if not self.server.slots.acquire(blocking=False):
            return
        try:
            self.request.settimeout(10)
            buf = b''
            while b'\r\n\r\n' not in buf:
                piece = self.request.recv(1024)
                if not piece:
                    return
                buf += piece
                if len(buf) > MAX_HEADER:
                    raise Refused()
            header, tail = buf.split(b'\r\n\r\n', 1)
            host, port, forwarded = request_header(header)
            vetted = public_addresses(host, port)
            upstream = None
            for family, kind, protocol, address in vetted:
                candidate = socket.socket(family, kind, protocol)
                candidate.settimeout(10)
                try:
                    candidate.connect(address)  # Numeric vetted IP, never a second DNS lookup.
                    upstream = candidate
                    break
                except OSError:
                    candidate.close()
            if upstream is None:
                raise Refused()
            with upstream:
                if forwarded is None:
                    self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                relay(self.request, upstream, (forwarded or b'') + tail)
        except (Refused, OSError):
            try:
                self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass
        finally:
            self.server.slots.release()

def serve(file):
    class Proxy(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True
        slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        def handle_error(self, request, address):
            pass  # Never log request URLs, headers, credentials or exception payloads.
    with Proxy(file, Handler) as server:
        import os
        os.chmod(file, 0o666)  # Parent host runtime is 0700; socket conveys public egress only.
        server.serve_forever()

if __name__ == '__main__':
    import os
    import sys
    if len(sys.argv) != 2 or not hasattr(socketserver, 'ThreadingUnixStreamServer'):
        raise SystemExit(2)
    os.umask(0o077)
    serve(sys.argv[1])
