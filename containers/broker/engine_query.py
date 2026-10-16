"""Fixed private read-only engine inventory entry; no generic command API."""
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from protocol import require,decode
from windows_engine import fixed_engine_query
try:
    raw=sys.stdin.buffer.readline(4097);require(len(raw)<=4096,'ENGINE_QUERY_LIMIT');args=decode(raw)
    sys.stdout.write(fixed_engine_query(args))
except Exception:raise SystemExit(1)
