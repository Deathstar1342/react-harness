#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ $# == 0 && "$(uname -s)" == Linux && "$EUID" != 0 && -x /usr/bin/python3 ]] || { printf '%s\n' 'Run interactively as the source user on supported Linux with existing Python 3. No host provisioning is performed.' >&2; exit 1; }
exec env -i HOME="$HOME" PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -I -B "$ROOT/containers/broker/transfer_cli.py" "$ROOT"
