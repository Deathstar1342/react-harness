"""CI-only bounded observation of the connected fixture's complete private handoff."""
import json
from pathlib import Path
import re
import uuid

def unique(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise ValueError('Duplicate fixture key')
        result[key]=value
    return result

def read_fixture_info(path,source,owner,expected_starts,previous_instance=None):
    try:
        with Path(path).open('rb') as stream:raw=stream.read(4097)
        if len(raw)>4096:return None
        info=json.loads(raw,object_pairs_hook=unique)
        if not isinstance(info,dict) or set(info)!={'schema','source','owner','projectId','chatId','processId','pairingCode','starts','instance'}:return None
        if info['schema']!='connected-preview-fixture-v1' or info['source']!=source or info['owner']!=owner:return None
        if not re.fullmatch('[a-f0-9]{40}',source) or type(info['starts']) is not int or info['starts']!=expected_starts:return None
        for key in ('owner','projectId','chatId','processId','instance'):
            if not isinstance(info[key],str) or str(uuid.UUID(info[key]))!=info[key]:return None
        if not isinstance(info['pairingCode'],str) or not 1<=len(info['pairingCode'])<=256:return None
        if info['instance']==previous_instance:return None
        return info
    except (FileNotFoundError,UnicodeError,json.JSONDecodeError,ValueError,TypeError):return None
