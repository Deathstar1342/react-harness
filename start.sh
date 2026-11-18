#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  --help|-h) printf '%s\n' 'Usage: bash start.sh [--check]'; exit 0 ;;
  --check|"") ;;
  *) printf '%s\n' 'Usage: bash start.sh [--check]' >&2; exit 2 ;;
esac
if (( $# > 1 )); then
  printf '%s\n' 'Usage: bash start.sh [--check]' >&2
  exit 2
fi

cd -- "$(dirname -- "$0")"
command -v node >/dev/null && command -v npm >/dev/null || {
  printf '%s\n' 'Install Node.js 24 or newer with npm first.' >&2
  exit 1
}
node -e "if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Node.js 24 or newer is required.'); process.exit(1); }"
if [[ "${1:-}" == --check ]]; then
  node --import tsx -e "if (!require('node:fs').existsSync('dist/client/index.html')) { console.error('Run npm run build or setup first.'); process.exit(1); }"
  exit 0
fi

exec npm start
