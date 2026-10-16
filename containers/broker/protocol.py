"""Bounded broker wire and durable claims. No Docker or host command execution here."""
import hashlib
import hmac
import json
import re
import sqlite3
import time
import uuid

PROTOCOL = 'abyssus-worker-v1'
MAX_WIRE = 262144
HEX = re.compile(r'[a-f0-9]{64}\Z')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
PROJECT = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\Z')

class Denied(Exception):
    pass

def require(condition, code='INVALID_REQUEST'):
    if not condition:
        raise Denied(code)

def exact(value, fields):
    require(type(value) is dict and set(value) == set(fields))

def bounded_int(value, low, high):
    require(type(value) is int and low <= value <= high)

def scalar(value):
    if type(value) is str:
        require(not any(0xD800 <= ord(c) <= 0xDFFF for c in value))
    elif type(value) is int:
        require(abs(value) <= 9007199254740991)
    elif value is None or type(value) is bool:
        pass
    elif type(value) is list:
        for item in value:
            scalar(item)
    elif type(value) is dict:
        for key, item in value.items():
            require(type(key) is str)
            scalar(key)
            scalar(item)
    else:
        raise Denied('INVALID_NUMBER')

def canonical(value):
    scalar(value)
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'))

def digest(value):
    return hashlib.sha256(canonical(value).encode('ascii')).hexdigest()

def mac(value, key):
    return hmac.new(key.encode('ascii'), canonical(value).encode('ascii'), hashlib.sha256).hexdigest()

def now():
    return int(time.time() * 1000)

def decode(wire):
    require(type(wire) is bytes and len(wire) <= MAX_WIRE and wire.endswith(b'\n') and b'\n' not in wire[:-1], 'INVALID_WIRE')
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'DUPLICATE_KEY')
            value[key] = item
        return value
    try:
        value = json.loads(wire.decode('utf-8', errors='strict'), object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(Denied('INVALID_NUMBER')))
        scalar(value)
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise Denied('INVALID_WIRE') from None

def command_request(body):
    exact(body, ['claimId', 'project', 'contextId', 'operation', 'timeoutMs', 'outputLimit'])
    require(type(body['claimId']) is str and UUID.fullmatch(body['claimId']))
    require(type(body['project']) is str and PROJECT.fullmatch(body['project']))
    require(type(body['contextId']) is str and HEX.fullmatch(body['contextId']))
    bounded_int(body['timeoutMs'], 1, 600000)
    bounded_int(body['outputLimit'], 1, 1000000)
    op = body['operation']
    require(type(op) is dict)
    if op.get('kind') == 'shell':
        exact(op, ['kind', 'command'])
        require(type(op['command']) is str and 0 < len(op['command'].encode('utf-8')) <= 65536 and '\0' not in op['command'])
    else:
        exact(op, ['kind', 'args'])
        require(op['kind'] == 'git' and type(op['args']) is list and 1 <= len(op['args']) <= 128)
        require(all(type(v) is str and len(v.encode('utf-8')) <= 4096 and '\0' not in v for v in op['args']))
        # These are internal fixed read operations, never arbitrary Git commands.
        args = op['args']
        if args[0] == 'rev-parse':
            require(args == ['rev-parse', '--show-toplevel'])
        elif args[0] == 'status':
            require(args == ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])
        elif args[0] == 'diff':
            require('--' in args)
            split = args.index('--')
            flags = args[1:split]
            require(len(flags) == len(set(flags)))
            require(set(flags) <= {'--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', '--ignore-submodules=all'})
            require({'--no-ext-diff', '--no-textconv', '--no-renames'} <= set(flags))
            for item in args[split + 1:]:
                require(item and not item.startswith(('/', '-')) and '\\' not in item and ':' not in item and '..' not in item.split('/'))
        else:
            raise Denied('FIXED_GIT_ONLY')
        require(len(canonical(op)) <= 65536)

def claim_identity(body):
    exact(body, ['claimId', 'binding'])
    require(type(body['claimId']) is str and UUID.fullmatch(body['claimId']))
    require(type(body['binding']) is str and HEX.fullmatch(body['binding']))

def open_database(file,persistent=False):
    factory=sqlite3.Connection
    if persistent:
        import os
        require(os.name=='nt','NATIVE_JOURNAL_REQUIRED')
        from native_sqlite import NativeConnection
        factory=NativeConnection
    database=sqlite3.connect(str(file),check_same_thread=False,factory=factory)
    try:configure_database(database,persistent);return database
    except BaseException:database.close();raise


def configure_database(database,persistent=False):
    # Only explicit trusted Windows host callers choose retained journals.
    # Linux/controller databases retain their existing modes and locking model.
    if persistent:
        import os
        require(os.name=='nt','NATIVE_JOURNAL_REQUIRED')
    mode='PERSIST' if persistent else 'DELETE'
    observed=database.execute('PRAGMA journal_mode='+mode).fetchone()
    memory=not persistent and observed==('memory',) and all(not row[2] for row in database.execute('PRAGMA database_list'))
    require(observed==(mode.lower(),) or memory,'JOURNAL_MODE_CHANGED')
    database.execute('PRAGMA synchronous=FULL')
    require(database.execute('PRAGMA synchronous').fetchone()==(2,),'JOURNAL_DURABILITY_CHANGED')


class Journal:
    """One serialized owner. FULL commit precedes effects; capacity never evicts claims."""
    def __init__(self, file, session, *, persistent=False):
        self.session = session
        self.db = open_database(file,persistent)
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS claims(id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS nonces(id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
        ''')
        for (raw,) in self.db.execute('SELECT data FROM claims').fetchall():
            record = json.loads(raw)
            if record['state'] in ('prepared', 'accepted', 'running'):
                record['state'] = 'expired' if record['state'] == 'prepared' else 'uncertain'
                record['code'] = 'BROKER_RESTARTED'
                self.save(record)

    def authenticate(self, envelope, key):
        exact(envelope, ['protocol', 'sessionId', 'nonce', 'expiresAt', 'op', 'body', 'mac'])
        require(envelope['protocol'] == PROTOCOL and envelope['sessionId'] == self.session, 'SESSION_MISMATCH')
        require(type(envelope['nonce']) is str and HEX.fullmatch(envelope['nonce']), 'AUTH_FAILED')
        bounded_int(envelope['expiresAt'], now() + 1, now() + 30000)
        require(type(envelope['mac']) is str and HEX.fullmatch(envelope['mac']), 'AUTH_FAILED')
        unsigned = {k: v for k, v in envelope.items() if k != 'mac'}
        require(hmac.compare_digest(envelope['mac'], mac(unsigned, key)), 'AUTH_FAILED')
        with self.db:
            self.db.execute('DELETE FROM nonces WHERE expires < ?', (now(),))
            require(self.db.execute('SELECT count(*) FROM nonces').fetchone()[0] < 4096, 'RATE_LIMIT')
            try:
                self.db.execute('INSERT INTO nonces VALUES (?,?)', (envelope['nonce'], envelope['expiresAt']))
            except sqlite3.IntegrityError:
                raise Denied('REPLAY') from None
        return envelope['op'], envelope['body']

    def get(self, claim_id):
        row = self.db.execute('SELECT data FROM claims WHERE id=?', (claim_id,)).fetchone()
        require(row is not None, 'UNKNOWN_CLAIM')
        return json.loads(row[0])

    def save(self, record, new=False):
        record['updatedAt'] = now()
        with self.db:
            if new:
                require(self.db.execute('SELECT count(*) FROM claims').fetchone()[0] < 10000, 'JOURNAL_FULL')
                try:
                    self.db.execute('INSERT INTO claims VALUES (?,?)', (record['claimId'], canonical(record)))
                except sqlite3.IntegrityError:
                    raise Denied('DUPLICATE_CLAIM') from None
            else:
                require(self.db.execute('UPDATE claims SET data=? WHERE id=?', (canonical(record), record['claimId'])).rowcount == 1, 'UNKNOWN_CLAIM')
        return record

    def prepare(self, request, identity):
        command_request(request)
        record = {**request, 'sessionId': self.session, 'identity': identity, 'expiresAt': now() + 30000}
        record['binding'] = digest(record)
        record.update(state='prepared', createdAt=now(), code='PREPARED')
        return self.save(record, new=True)

    def owned(self, body):
        claim_identity(body)
        record = self.get(body['claimId'])
        require(record['sessionId'] == self.session and record['binding'] == body['binding'], 'CLAIM_MISMATCH')
        return record

    def activate(self, body, identity):
        record = self.owned(body)
        require(record['state'] == 'prepared', 'CLAIM_CONSUMED')
        require(now() < record['expiresAt'], 'CLAIM_EXPIRED')
        require(record['identity'] == identity, 'IDENTITY_CHANGED')
        record.update(state='accepted', code='ACTIVATION_ACCEPTED')
        return self.save(record)  # Never invoke any runner before this commit.

    def cancel_prepared(self, body):
        record = self.owned(body)
        require(record['state'] == 'prepared', 'CLAIM_CONSUMED')
        record.update(state='cancelled', code='PREPARATION_CANCELLED')
        return self.save(record)
