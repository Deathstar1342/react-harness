"""Host-held, one-use mapping proofs. Controller messages carry only opaque IDs.

The caller supplies a trusted fixed-image probe implementation. This module never
accepts a controller-signed body as authority and never retries a failed probe.
"""
import hashlib
import copy
import hmac
import secrets
import time
import uuid
from protocol import require,exact,canonical,HEX,UUID

SLOTS=('state','config','workspace','control')
BINDING=('storageId','engineId','context','controllerImage','probeImage','launchId')
DOMAIN=b'abyssus-native-storage-proof-v1\0'

def validate_binding(value):
    import re
    exact(value,BINDING)
    for key in ('storageId','launchId'):require(type(value[key]) is str and UUID.fullmatch(value[key]),'INVALID_PROOF_BINDING')
    require(type(value['engineId']) is str and 0<len(value['engineId'])<=256 and all(32<ord(c)<127 for c in value['engineId']),'INVALID_PROOF_BINDING')
    require(type(value['context']) is str and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',value['context']),'INVALID_PROOF_BINDING')
    for key in ('controllerImage','probeImage'):require(type(value[key]) is str and re.fullmatch('sha256:[a-f0-9]{64}',value[key]),'INVALID_PROOF_BINDING')

def validate_native(value):
    import re
    exact(value,['root','slots']);exact(value['slots'],SLOTS)
    for name,item in [('root',value['root']),*value['slots'].items()]:
        exact(item,['volume','fileId','directory','ownerSid','securityControl','protected','aclDigest'])
        require(type(item['volume']) is str and re.fullmatch('[0-9]{1,20}',item['volume']),'INVALID_NATIVE_PROOF')
        require(type(item['fileId']) is str and re.fullmatch('[a-f0-9]{32}',item['fileId']),'INVALID_NATIVE_PROOF')
        require(item['directory'] is True,'INVALID_NATIVE_PROOF')
        require(type(item['ownerSid']) is str and re.fullmatch(r'S-1-[0-9-]{1,180}',item['ownerSid']),'INVALID_NATIVE_PROOF')
        require(type(item['securityControl']) is int and 0<=item['securityControl']<=65535 and type(item['protected']) is bool and item['protected']==bool(item['securityControl']&0x1000),'INVALID_NATIVE_PROOF')
        require(type(item['aclDigest']) is str and HEX.fullmatch(item['aclDigest']),'INVALID_NATIVE_PROOF')
        require(name!='root' or item['protected'],'PROTECTED_ROOT_DACL_REQUIRED')
    require(len({(v['volume'],v['fileId']) for v in value['slots'].values()})==4,'NATIVE_SLOT_ALIAS')

def validate_probe(value,challenge):
    import re
    exact(value,['version','revision','probeId','nonce','launchId','storageId','slots','sqlite'])
    require(all(type(value[k]) is int for k in ('version','revision')),'INVALID_PROBE_REVISION')
    require(all(type(value[k]) is str for k in ('probeId','nonce','launchId','storageId')),'INVALID_PROBE_BINDING')
    require(all(value[k]==challenge[k] for k in ('version','revision','probeId','nonce','launchId','storageId')),'PROBE_BINDING_CHANGED')
    exact(value['slots'],SLOTS)
    for slot in value['slots'].values():
        exact(slot,['dev','ino'])
        require(all(type(v) is str and re.fullmatch('[0-9]{1,30}',v) for v in slot.values()),'INVALID_LINUX_IDENTITY')
    require(len({(s['dev'],s['ino']) for s in value['slots'].values()})==4,'LINUX_SLOT_ALIAS')
    exact(value['sqlite'],['wal','secondWriterDenied','reopened'])
    require(all(type(v) is bool for v in value['sqlite'].values()),'INVALID_SQLITE_PROOF')
    require(value['sqlite']=={'wal':True,'secondWriterDenied':True,'reopened':True},'BIND_SQLITE_UNPROVEN')

class StorageProofs:
    def __init__(self,binding,key,native_guard,probe,clock=None):
        validate_binding(binding);require(type(key) is str and HEX.fullmatch(key),'INVALID_PROOF_KEY')
        self.binding=dict(binding);self.key=bytes.fromhex(key);self.guard=native_guard;self.probe=probe
        self.clock=clock or (lambda:int(time.time()*1000));self.pending={};self.failed=False
    def issue(self):
        require(not self.failed,'STORAGE_PROOF_FAILED');require(not self.pending,'PROOF_ALREADY_PENDING')
        issued=self.clock();challenge={'version':1,'revision':1,'probeId':str(uuid.uuid4()),'nonce':secrets.token_hex(32),'launchId':self.binding['launchId'],'storageId':self.binding['storageId']}
        try:
            native=copy.deepcopy(self.guard.verify());validate_native(native)
            measured=self.probe(dict(challenge));validate_probe(measured,challenge)
            require(self.guard.verify()==native,'NATIVE_STORAGE_CHANGED')
            require(issued<=self.clock()<=issued+30000,'PROBE_EXPIRED')
            token=secrets.token_hex(32)
            published=self.clock()
            body={**challenge,**self.binding,'issuedAt':published,'expiresAt':published+10000,'native':native,'linux':measured['slots'],'sqlite':measured['sqlite']}
            raw=canonical(body).encode();require(len(raw)<=16384,'PROOF_LIMIT')
            self.pending[token]=(body,hmac.new(self.key,DOMAIN+raw,hashlib.sha256).hexdigest())
            return token
        except BaseException:
            # Timeout/lost reply is not absence of effect. A fresh supervisor
            # lifecycle is required; pending work cannot auto-reprobe itself.
            self.failed=True;self.pending.clear();raise
    def consume(self,token,binding):
        require(type(token) is str and HEX.fullmatch(token),'INVALID_PROOF_ID')
        retained=self.pending.pop(token,None);require(retained is not None,'PROOF_CONSUMED_OR_UNKNOWN')
        try:
            body,signature=retained;validate_binding(binding)
            require(binding==self.binding,'PROOF_BINDING_CHANGED')
            require(body['issuedAt']<=self.clock()<=body['expiresAt'],'PROOF_EXPIRED')
            require(hmac.compare_digest(signature,hmac.new(self.key,DOMAIN+canonical(body).encode(),hashlib.sha256).hexdigest()),'PROOF_CHANGED')
            require(self.guard.verify()==body['native'],'NATIVE_STORAGE_CHANGED')
            # This return is private trusted-host state, never a renderer/API DTO.
            return body
        except BaseException:self.failed=True;self.pending.clear();raise
