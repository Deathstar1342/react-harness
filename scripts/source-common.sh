#!/usr/bin/env bash
# Shared by source setup/launch only. Never sourced from generated configuration.
# Keep the verified Linux x64 pin aligned with scripts/stage-runtime.mjs.
SOURCE_NODE_VERSION=24.16.0
SOURCE_NODE_SHA=d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9
SOURCE_NODE_HOME="$HOME/.local/share/abyssus-source-node/node-v$SOURCE_NODE_VERSION-linux-x64"

source_fail() { printf '\n%s\n' "$*" >&2; exit 1; }
source_confirm() {
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes ]]
}
source_select_node() {
  local candidate
  for candidate in "$(command -v node || true)" "$SOURCE_NODE_HOME/bin/node"; do
    if [[ -n "$candidate" && -x "$candidate" ]] && "$candidate" -e 'process.exit(process.platform === "linux" && Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
      SOURCE_NODE="$candidate"
      export PATH="$(dirname -- "$candidate"):$PATH"
      command -v npm >/dev/null && [[ "$(command -v npm)" != /mnt/* ]] && return 0
    fi
  done
  return 1
}
source_platform() {
  [[ "$(uname -s)" == Linux ]] || source_fail 'Run this in your Ubuntu/WSL terminal, not Windows PowerShell or Git Bash.'
  [[ "$EUID" != 0 ]] || source_fail 'Run as your normal Linux user, not root or sudo bash.'
  [[ "$PWD" != /mnt/* ]] || source_fail 'Clone the app into your Linux home (for example ~/apps/abyssus), not a Windows-mounted directory.'
}
source_sandbox_check() {
  [[ -x /usr/bin/bwrap && -x /usr/bin/socat && -x /usr/bin/bash ]] || source_fail 'Missing sandbox prerequisites: bubblewrap, socat or bash.'
  /usr/bin/bwrap --unshare-all --unshare-user --die-with-parent --new-session --disable-userns --ro-bind / / --proc /proc --dev /dev /bin/true ||
    source_fail 'Linux blocked the sandbox check. Ask your administrator to enable supported Bubblewrap/user namespaces. No kernel/AppArmor settings were changed and no host execution fallback is used.'
}
