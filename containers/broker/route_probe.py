"""One-shot fixed-image proof for the exact bound Windows broker socket."""
import json
import ipaddress
import time
import secrets
import socketserver
import threading
from protocol import require,exact,canonical
from windows_network import windows_adapters,candidates

class LocalServer(socketserver.ThreadingTCPServer):
    daemon_threads=True
    allow_reuse_address=False
    def handle_error(self,*_):pass

def prove_server(docker,image,session_id):
    # All candidates came from read-only native inventory. No wildcard binding,
    # firewall update, host command, or LAN/public adapter can enter this loop.
    for candidate in candidates(windows_adapters()):
        nonce=secrets.token_hex(32);observed=threading.Event();issued=int(time.time()*1000)
        class Challenge(socketserver.StreamRequestHandler):
            def handle(self):
                self.request.settimeout(5)
                try:
                    raw=self.rfile.readline(2049);require(len(raw)<=2048 and raw.endswith(b'\n'))
                    value=json.loads(raw);exact(value,['version','sessionId','nonce','port'])
                    expected={'version':1,'sessionId':session_id,'nonce':nonce,'port':self.server.server_address[1]}
                    require(type(value['version']) is int and type(value['port']) is int and value==expected and not observed.is_set())
                    self.wfile.write((canonical({**expected,'accepted':True})+'\n').encode());self.wfile.flush();observed.set()
                except Exception:return
        try:server=LocalServer((candidate['bind'],0),Challenge)
        except OSError:continue
        port=server.server_address[1];thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();container=None;proved=False
        try:
            args=['--network','bridge','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','128m','--cpus','1','--user','1000:1000','--entrypoint','/usr/local/bin/node','-i',image,'/app/containers/route-probe.mjs']
            container=docker.resources.create(args,image,'attestation')
            info=docker.resources.verify(docker.resources.find(container));config=info['HostConfig']
            require(not info['Mounts'] and config['NetworkMode']=='bridge' and config['ReadonlyRootfs'] and not config['Privileged'] and config['CapDrop']==['ALL'] and not config.get('CapAdd') and not config.get('Devices') and not config.get('DeviceRequests') and not config.get('Binds') and not config.get('VolumesFrom') and not config.get('PidMode') and config.get('IpcMode')=='private' and not config.get('UTSMode') and config['SecurityOpt']==['no-new-privileges'],'UNSAFE_ROUTE_PROBE')
            challenge={'version':1,'sessionId':session_id,'nonce':nonce,'host':candidate['connect'],'port':port}
            try:result=docker.call(['start','--attach','--interactive',container],timeout=15,input=canonical(challenge)+'\n')
            except Exception:
                # A failed route only permits another candidate after exact owned
                # probe removal is confirmed. It never dispatches project work.
                docker.resources.remove(container);container=None;continue
            expected={'version':1,'sessionId':session_id,'nonce':nonce,'port':port,'accepted':True}
            require(len(result)<=2048,'PRIVATE_ROUTE_UNPROVEN');reply=json.loads(result);exact(reply,[*expected,'address'])
            address=ipaddress.ip_address(reply['address']);require(address.version==4 and address.is_private and not address.is_unspecified and not address.is_link_local and not address.is_multicast,'PRIVATE_ROUTE_UNPROVEN')
            require({k:reply[k] for k in expected}==expected and observed.is_set() and (candidate['connect']=='host.docker.internal' or str(address)==candidate['connect']),'PRIVATE_ROUTE_UNPROVEN')
            info=docker.resources.verify(docker.resources.find(container));require(info['State']['Status']=='exited' and info['State']['ExitCode']==0,'PRIVATE_ROUTE_UNPROVEN')
            docker.resources.remove(container);container=None;proved=True
        finally:
            server.shutdown();thread.join(timeout=10)
            if not proved:server.server_close()
            # An uncertain cleanup remains owned; never try another candidate.
            if container:docker.resources.remove(container)
        if proved:
            # Same socket remains bound. Broker installs its authenticated handler
            # before restarting serve_forever; there is no unbind/rebind window.
            server.route={**candidate,'connectIP':str(address),'port':port,'sessionId':session_id,'proof':{'version':1,'nonce':nonce,'engineId':docker.engine_id,'probeImage':image,'address':str(address),'bindAddress':candidate['bind'],'port':port,'sessionId':session_id,'issuedAt':issued,'expiresAt':issued+30000}}
            return server
    raise RuntimeError('PRIVATE_DOCKER_ROUTE_UNAVAILABLE')

def verify_route(server):
    route=server.route
    require(server.server_address==(route['bind'],route['port']),'BROKER_SOCKET_CHANGED')
    require(any(all(candidate[k]==route[k] for k in ('bind','connect','adapterId')) for candidate in candidates(windows_adapters())),'BROKER_ADAPTER_CHANGED')
