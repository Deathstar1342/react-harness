"""Build-time exact image manifest producer; never pulls/builds/starts an engine.

Trusted setup supplies immutable image IDs from its completed build/inspection.
M32 owns guided source entrypoints. This command only stages a new desktop file.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat


def stage(app,source,controller,worker):
    app=Path(app).absolute();checkout=Path(__file__).resolve().parents[1]
    if app.resolve()!=app or not app.is_dir() or app==checkout or checkout in app.parents or app in checkout.parents:raise ValueError('Use canonical external desktop staging')
    for parent in (app,*app.parents):
        info=parent.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400:raise ValueError('Staging links/reparse points are refused')
    if not re.fullmatch('[a-f0-9]{40}',source):raise ValueError('Exact source commit required')
    for digest in (controller,worker):
        if not re.fullmatch('sha256:[a-f0-9]{64}',digest):raise ValueError('Immutable image ID required; tags are refused')
    for name in ('package.json','desktop/entry.cjs','desktop/main.js','containers/broker/support_entry.py','containers/worker-runner.py','helper/core.py'):
        target=app/name;info=target.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or target.resolve()!=target or getattr(info,'st_file_attributes',0)&0x400:raise ValueError('Incomplete or linked desktop staging')
    value={'version':1,'source':source,'controllerImage':controller,'workerImage':worker}
    # Exclusive creation prevents replacing a live or partially staged payload.
    # Failed writes remain visible and require a new build staging directory.
    file=app/'container-runtime.json'
    with file.open('x',encoding='utf-8',newline='\n') as output:
        output.write(json.dumps(value,separators=(',',':'))+'\n');output.flush();os.fsync(output.fileno())
    return file


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app',required=True);parser.add_argument('--source',required=True)
    parser.add_argument('--controller-image',required=True);parser.add_argument('--worker-image',required=True)
    options=parser.parse_args();stage(options.app,options.source,options.controller_image,options.worker_image)
    print('Exact container payload manifest staged; engine image availability is checked at launch.')


if __name__=='__main__':main()
