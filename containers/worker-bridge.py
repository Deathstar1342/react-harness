"""Worker's own loopback proxy bridge. No default route or Docker control."""
import os
import socket
import socketserver
import sys
sys.path.insert(0, '/opt/abyssus-worker/broker')
from egress import relay

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(10)
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as upstream:
                upstream.settimeout(10)
                upstream.connect('/run/egress/proxy.sock')
                relay(self.request, upstream)
        except OSError:
            pass
class Bridge(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    def handle_error(self, request, address):
        pass
with Bridge(('127.0.0.1', 3128), Handler) as server:
    server.serve_forever()
