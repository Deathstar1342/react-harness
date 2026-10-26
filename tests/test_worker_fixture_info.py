"""Portable deterministic CI fixture readiness checks, no worker or Docker required."""
import json
import tempfile
from pathlib import Path
import unittest
import uuid
from fixture_info import read_fixture_info

class FixtureInfoTests(unittest.TestCase):
    def test_complete_identity_bound_readiness_and_restart(self):
        source='a'*40;owner=str(uuid.uuid4())
        original=dict(schema='connected-preview-fixture-v1',source=source,owner=owner,projectId=str(uuid.uuid4()),chatId=str(uuid.uuid4()),processId=str(uuid.uuid4()),pairingCode='fixture-control',starts=1,instance=str(uuid.uuid4()))
        with tempfile.TemporaryDirectory(prefix='fixture-info-readiness-') as directory:
            target=Path(directory)/'info.json'
            read=lambda starts=1,previous=None:read_fixture_info(target,source,owner,starts,previous)
            self.assertIsNone(read())
            for raw in ('','{',json.dumps(original)[:30],json.dumps(original)[:-1]+',"instance":"duplicate"}', 'x'*4097):
                target.write_text(raw);self.assertIsNone(read())
            for changes in ({'source':'b'*40},{'owner':str(uuid.uuid4())},{'schema':'other'},{'starts':True},{'instance':'invalid'},{'pairingCode':''}):
                target.write_text(json.dumps(dict(original,**changes)));self.assertIsNone(read())
            target.write_text(json.dumps(original));self.assertEqual(read(),original)
            self.assertIsNone(read(0,original['instance']))
            stale=dict(original,starts=0);target.write_text(json.dumps(stale));self.assertIsNone(read(0,original['instance']))
            fresh=dict(stale,instance=str(uuid.uuid4()));target.write_text(json.dumps(fresh))
            self.assertEqual(read(0,original['instance']),fresh)
            self.assertIsNone(read())

if __name__=='__main__':unittest.main()
