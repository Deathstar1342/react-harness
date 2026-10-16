"""Interactive source authorization. This command never accepts paths from the controller."""
import os
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from transfer_service import select, authorize, private_json
from transfers import root_handle
from protocol import require


def main():
    require(len(sys.argv)==2 and sys.stdin.isatty() and sys.stdout.isatty(),'INTERACTIVE_HOST_REQUIRED')
    source=Path(sys.argv[1])
    selection=source/'.container-source/selection'
    with root_handle(selection.parent) as parent:
        fd=os.open(selection.name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
        with os.fdopen(fd) as stream:
            info=os.fstat(stream.fileno())
            require(info.st_nlink==1 and info.st_uid==os.getuid() and info.st_mode&0o077==0 and info.st_size<8192,'UNSAFE_SELECTION')
            selected=stream.read().splitlines()
    require(len(selected)==2,'INVALID_SELECTION')
    storage,storage_id=selected
    print('One-time project copy. Originals are never modified. No synchronization or write-back.')
    kind=input('Import or export? [import/export]: ').strip()
    project=input('Managed folder identity shown by Export in the app: ').strip() if kind=='export' else None
    path=input('Absolute source folder: ' if kind=='import' else 'Absolute NEW destination folder (must not exist): ').strip()
    print('Dependencies/build caches and sensitive configs are excluded. App/provider credentials are always forbidden.')
    included=input('Exact ordinary sensitive relative files to include, separated by commas (blank for none): ').strip()
    print('Git history is opt-in: objects/index may retain deleted secrets despite working-file exclusions. Hooks/config/logs are omitted. No source Git command is run.')
    history=input('Type INCLUDE HISTORY to retain safe local Git history, or Enter for a fresh repository: ')=='INCLUDE HISTORY'
    token,ticket=select(storage,storage_id,str(source),kind,path,project,[v.strip() for v in included.split(',') if v.strip()],history)
    manifest=ticket['manifest']
    print(f"Prepared {len(manifest['entries'])} entries, {manifest['bytes']} bytes; {len(manifest['excluded'])} exclusions.")
    for entry in manifest['excluded'][:100]: print(f"Excluded {entry['path']!r}: {entry['reason']}")
    if len(manifest['excluded'])>100: print('Only first 100 exclusions displayed; full manifest retained in private host ticket.')
    print('Source:',ticket['source']);print('Destination:',ticket['destination'])
    print('Included ordinary sensitive files become part of the managed/exported copy. Reads may update source access times. Copy strips special permission bits.')
    require(input('Type AUTHORIZE COPY to issue a single-use code valid for 15 minutes: ')=='AUTHORIZE COPY','CANCELLED')
    authorize(storage,token,ticket)
    print('Transfer code (paste into the app): '+token)

if __name__=='__main__':
    try: main()
    except Exception as error:
        print('Transfer was not authorized: '+type(error).__name__+'. Existing projects and sources are preserved.',file=sys.stderr)
        sys.exit(1)
