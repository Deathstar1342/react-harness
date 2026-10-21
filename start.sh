#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
MODE="dev"

usage() {
  cat <<'EOF'
Usage: ./start.sh [options]

Options:
  --dev           Start the backend and Vite development server. Default.
  --production    Build the frontend, then run the backend static-server mode.
  -h, --help      Show this help.

Environment:
  HARNESS_HOME    Absolute app-profile directory.
                  Default: $HOME/.abyssus-harness-v1
EOF
}

die() {
  echo "start.sh: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1"
}

while (($#)); do
  case "$1" in
    --dev) MODE="dev" ;;
    --production) MODE="production" ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

cd "$ROOT"

[[ -f package.json ]] || die "Run this script from a valid Abyssus source checkout."
require_command node
require_command npm

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || die "Could not determine Node.js version."
(( NODE_MAJOR >= 24 )) || die "Node.js 24 or newer is required; found $(node --version)."

: "${HOME:?HOME must be set}"

# Standard per-user application state. Coworkers should not need to configure this.
HARNESS_HOME="$HOME/.abyssus-harness-v1"
export HARNESS_HOME

PROFILE_ENV="$HARNESS_HOME/profile/config/.env"

[[ -d "$HARNESS_HOME" ]] || die \
  "No Harness home exists at $HARNESS_HOME. Run ./setup.sh first."

[[ ! -L "$HARNESS_HOME" ]] || die \
  "HARNESS_HOME must not be a symbolic link: $HARNESS_HOME"

[[ "$(stat -c '%u' "$HARNESS_HOME")" == "$(id -u)" ]] || die \
  "HARNESS_HOME must be owned by $(id -un): $HARNESS_HOME"

[[ "$(stat -c '%a' "$HARNESS_HOME")" == "700" ]] || die \
  "HARNESS_HOME must have mode 0700. Run ./setup.sh first."

[[ -f "$PROFILE_ENV" ]] || die \
  "Active provider configuration is missing: $PROFILE_ENV. Run ./setup.sh first."

[[ ! -L "$PROFILE_ENV" ]] || die \
  "Active provider configuration must not be a symbolic link: $PROFILE_ENV"

[[ "$(stat -c '%a' "$PROFILE_ENV")" == "600" ]] || die \
  "Active provider configuration must have mode 0600. Run ./setup.sh first."

if ! node -e "require('node-pty')" >/dev/null 2>&1; then
  die "node-pty is unavailable. Run ./setup.sh --no-start to install/build it."
fi

echo "Starting Abyssus with HARNESS_HOME=$HARNESS_HOME"

if [[ "$MODE" == "production" ]]; then
  npm run build
  exec npm start
fi

exec npm run dev