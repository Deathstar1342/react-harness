#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  --help|-h) printf '%s\n' 'Usage: bash setup.sh [--check | --no-start]'; exit 0 ;;
  --check|--no-start|"") ;;
  *) printf '%s\n' 'Usage: bash setup.sh [--check | --no-start]' >&2; exit 2 ;;
esac
if (( $# > 1 )); then
  printf '%s\n' 'Usage: bash setup.sh [--check | --no-start]' >&2
  exit 2
fi

cd -- "$(dirname -- "$0")"
command -v node >/dev/null && command -v npm >/dev/null || {
  printf '%s\n' 'Install Node.js 24 or newer with npm first.' >&2
  exit 1
}
node -e "if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Node.js 24 or newer is required.'); process.exit(1); }"
if [[ "${1:-}" == --check ]]; then exit 0; fi

npm ci
printf '%s\n' 'Ready. Run npm start from this checkout.'
