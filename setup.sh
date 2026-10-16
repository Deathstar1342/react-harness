#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
# Do not hand provider credentials to apt, downloads, npm hooks or build tools.
unset STARK_API_KEY OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY
unset STARK_BASE_URL ARCHITECT_MODEL CODER_MODEL CRITIC_MODEL
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$ROOT"
if [[ "${1:-}" == --container ]]; then shift; exec bash "$ROOT/scripts/container-source.sh" setup "$@"; fi
source "$ROOT/scripts/source-common.sh"
if [[ "${1:-}" == --help ]]; then
  printf 'Usage: bash setup.sh [--check | --no-start]\nGuided Linux/WSL source setup. --check is read-only; --no-start skips the final launch.\n'
  exit 0
fi
[[ $# == 0 || $# == 1 && ( "${1:-}" == --check || "${1:-}" == --no-start ) ]] || source_fail 'Use bash setup.sh --help.'
source_platform
if [[ "${1:-}" != --check ]]; then
  [[ -t 0 && -t 1 ]] || source_fail 'Guided setup needs an interactive terminal. Use --check for noninteractive prerequisite checks.'
fi

missing=()
for cmd in git make g++ python3 curl tar xz sha256sum bwrap socat; do
  command -v "$cmd" >/dev/null || missing+=("$cmd")
done
if command -v python3 >/dev/null && ! python3 -c 'import venv, ensurepip' 2>/dev/null; then missing+=(python3-venv); fi
if [[ ${#missing[@]} != 0 ]]; then
  printf 'Missing prerequisites: %s\n' "${missing[*]}"
  [[ "${1:-}" != --check ]] || exit 1
  command -v apt-get >/dev/null || source_fail 'Install the listed prerequisites through your Linux administrator/package manager, then rerun setup.'
  source_confirm 'Install the Ubuntu/Debian prerequisites using sudo apt-get?' || source_fail 'Nothing installed. Rerun when the prerequisites are available.'
  sudo apt-get update
  sudo apt-get install -y git build-essential python3 python3-venv curl xz-utils bubblewrap socat
fi

if ! source_select_node; then
  [[ "${1:-}" != --check ]] || source_fail 'Linux Node.js 24+ with npm is missing.'
  [[ "$(uname -m)" == x86_64 ]] || source_fail 'Install Linux Node.js 24+ and npm for your architecture, then rerun setup.'
  source_confirm "Install verified Node $SOURCE_NODE_VERSION privately for this user (no sudo)?" || source_fail 'Install Linux Node.js 24+ with npm using your approved method, then rerun.'
  [[ ! -e "$SOURCE_NODE_HOME" && ! -L "$SOURCE_NODE_HOME" ]] || source_fail 'The local Node destination already exists but is unusable. Preserve it and inspect it before retrying.'
  runtime_parent="$(dirname -- "$SOURCE_NODE_HOME")"
  mkdir -p -- "$runtime_parent"
  [[ ! -L "$runtime_parent" && -O "$runtime_parent" ]] || source_fail 'The private Node directory must be owned by this user and must not be a link.'
  staging="$(mktemp -d "$runtime_parent/.install.XXXXXXXX")"
  archive="node-v$SOURCE_NODE_VERSION-linux-x64.tar.xz"
  printf 'Downloading pinned Node from nodejs.org; no shell installer or redirects.\n'
  curl --proto '=https' --fail --silent --show-error --connect-timeout 20 --max-time 180 --max-filesize 104857600 \
    "https://nodejs.org/dist/v$SOURCE_NODE_VERSION/$archive" --output "$staging/$archive"
  printf '%s  %s\n' "$SOURCE_NODE_SHA" "$staging/$archive" | sha256sum --check --status || source_fail 'Node checksum mismatch; nothing was installed. Preserve the private staging directory for inspection.'
  tar -xJf "$staging/$archive" -C "$staging"
  mv -T -- "$staging/node-v$SOURCE_NODE_VERSION-linux-x64" "$SOURCE_NODE_HOME"
  rm -- "$staging/$archive"
  rmdir -- "$staging"
  source_select_node || source_fail 'The installed Linux Node runtime did not pass its version/platform check.'
fi
source_sandbox_check
printf 'Linux Node, npm and sandbox prerequisites passed.\n'
[[ "${1:-}" != --check ]] || exit 0

printf '\nInstalling locked application dependencies...\n'
# Browser source launch needs no Electron executable download.
# node-gyp's generated include paths cannot quote a header cache under a HOME
# containing spaces. Use a private, space-free transient cache, not global config.
native_headers="$(mktemp -d "/tmp/abyssus-native-build-$UID.XXXXXXXX")"
cleanup_headers() {
  if [[ "$native_headers" == /tmp/abyssus-native-build-"$UID".* && -d "$native_headers" && ! -L "$native_headers" && -O "$native_headers" ]]; then rm -rf -- "$native_headers"; fi
}
trap cleanup_headers EXIT
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_package_config_node_gyp_devdir="$native_headers" npm ci --foreground-scripts
cleanup_headers
trap - EXIT
node -e 'require("node:sqlite"); require("node-pty"); console.log("SQLite and Linux PTY loaded.")'
node --import tsx scripts/source-setup.ts
npm run build
printf '\nSetup complete. Later, run: bash start.sh\n'
if [[ "${1:-}" != --no-start ]] && source_confirm 'Start abysSUS now?'; then exec bash "$ROOT/start.sh"; fi
