#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
NO_START=0
INSTALL_PREREQS=0
IMPORT_PROJECT_ENV=1

usage() {
  cat <<'EOF'
Usage: ./setup.sh [options]

Options:
  --no-start               Provision only; do not launch the development stack.
  --install-prereqs        Install Linux/WSL native build prerequisites without prompting.
  --no-import-project-env  Do not bootstrap the active profile from this checkout's .env.
  -h, --help               Show this help.

Environment:
  HARNESS_HOME             Absolute app-profile directory.
                           Default: $HOME/.abyssus-harness-v1
EOF
}

die() {
  echo "setup.sh: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1"
}

while (($#)); do
  case "$1" in
    --no-start) NO_START=1 ;;
    --install-prereqs) INSTALL_PREREQS=1 ;;
    --no-import-project-env) IMPORT_PROJECT_ENV=0 ;;
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

PROFILE_DIR="$HARNESS_HOME/profile"
PROFILE_ENV="$PROFILE_DIR/config/.env"

if [[ -L "$HARNESS_HOME" ]]; then
  die "HARNESS_HOME must not be a symbolic link: $HARNESS_HOME"
fi

if [[ -e "$HARNESS_HOME" && ! -d "$HARNESS_HOME" ]]; then
  die "HARNESS_HOME exists but is not a directory: $HARNESS_HOME"
fi

mkdir -p "$HARNESS_HOME"
chmod 700 "$HARNESS_HOME"

HOME_OWNER="$(stat -c '%u' "$HARNESS_HOME")"
[[ "$HOME_OWNER" == "$(id -u)" ]] || die \
  "HARNESS_HOME must be owned by $(id -un): $HARNESS_HOME"

missing_prereqs=()
command -v python3 >/dev/null 2>&1 || missing_prereqs+=(python3)
command -v make >/dev/null 2>&1 || missing_prereqs+=(make)
command -v g++ >/dev/null 2>&1 || missing_prereqs+=(g++)

if ((${#missing_prereqs[@]})); then
  echo "Missing Linux/WSL native build prerequisites: ${missing_prereqs[*]}"

  if (( ! INSTALL_PREREQS )) && [[ -t 0 ]]; then
    read -r -p "Install python3, make, and build-essential with sudo apt? [y/N] " reply || true
    [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]] && INSTALL_PREREQS=1
  fi

  (( INSTALL_PREREQS )) || die \
    "Install the prerequisites manually, or rerun with --install-prereqs."

  require_command sudo
  require_command apt-get

  sudo apt-get update
  sudo apt-get install -y python3 make build-essential
fi

echo "Installing project dependencies..."
npm install --include=optional

# Newer npm versions may block dependency lifecycle scripts until explicitly approved.
if npm install-scripts --help >/dev/null 2>&1; then
  blocked_scripts="$(npm install-scripts ls 2>&1 || true)"
  if grep -q 'node-pty' <<<"$blocked_scripts"; then
    echo "Approving the reviewed node-pty native build script..."
    npm install-scripts approve node-pty
  fi
fi

echo "Building optional node-pty terminal support..."
npm rebuild node-pty

node -e "require('node-pty'); console.log('node-pty is available')"

if [[ ! -f "$PROFILE_ENV" ]]; then
  echo "Initializing a fresh Harness profile at: $HARNESS_HOME"
  npm run profile:init
fi

[[ -f "$PROFILE_ENV" ]] || die \
  "Profile initialization did not create: $PROFILE_ENV"

[[ ! -L "$PROFILE_ENV" ]] || die \
  "Active profile configuration must not be a symbolic link: $PROFILE_ENV"

chmod 600 "$PROFILE_ENV"

if (( IMPORT_PROJECT_ENV )); then
  SOURCE_ENV="$ROOT/.env"

  if [[ -L "$SOURCE_ENV" ]]; then
    echo "Skipping project .env bootstrap because .env is a symbolic link."
  elif [[ -f "$SOURCE_ENV" ]]; then
    echo "Bootstrapping missing provider settings into the active profile..."

    ROOT="$ROOT" PROFILE_ENV="$PROFILE_ENV" node --input-type=module <<'NODE'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';

const root = process.env.ROOT;
const targetFile = process.env.PROFILE_ENV;
const sourceFile = join(root, '.env');

const source = parse(readFileSync(sourceFile, 'utf8'));
const target = existsSync(targetFile)
  ? parse(readFileSync(targetFile, 'utf8'))
  : {};

const allowed = [
  'STARK_BASE_URL',
  'STARK_API_KEY',
  'ARCHITECT_MODEL',
  'CODER_MODEL',
  'CRITIC_MODEL',
  'MODEL_STREAMING',
  'ARCHITECT_INPUT_TOKEN_LIMIT',
  'CODER_INPUT_TOKEN_LIMIT',
  'CRITIC_INPUT_TOKEN_LIMIT',
  'MODEL_MAX_OUTPUT_TOKENS',
  'REQUESTS_PER_MINUTE',
  'TOKENS_PER_MINUTE',
  'TOKENS_PER_DAY',
  'HOST',
  'PORT',
  'APPROVAL_MODE',
];

const added = [];

for (const key of allowed) {
  const current = target[key]?.trim();
  const incoming = source[key]?.trim();

  // Re-runs are non-destructive: never replace an active profile value.
  if (!current && incoming) {
    target[key] = source[key];
    added.push(key);
  }
}

// STARK currently returns non-streaming JSON for this app integration.
if (!target.MODEL_STREAMING?.trim()) {
  target.MODEL_STREAMING = 'false';
  added.push('MODEL_STREAMING');
}

const output = Object.entries(target)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
  .join('\n') + '\n';

writeFileSync(targetFile, output, { mode: 0o600 });
chmodSync(targetFile, 0o600);

console.log(
  added.length
    ? `Provider bootstrap populated: ${added.join(', ')}`
    : 'Provider bootstrap found existing active settings; nothing was overwritten.'
);
NODE
  else
    echo "No repository .env found; configure provider settings in the app after startup."
  fi
fi

echo
echo "Setup complete."
echo "  HARNESS_HOME: $HARNESS_HOME"
echo "  Active config: $PROFILE_ENV"

if (( NO_START )); then
  exit 0
fi

exec "$ROOT/start.sh"