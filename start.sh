#!/usr/bin/env bash
set +x
set -euo pipefail
unset STARK_API_KEY OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY
unset STARK_BASE_URL ARCHITECT_MODEL CODER_MODEL CRITIC_MODEL
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$ROOT"
if [[ "${1:-}" == --container ]]; then shift; exec bash "$ROOT/scripts/container-source.sh" start "$@"; fi
source "$ROOT/scripts/source-common.sh"
source_platform
source_select_node || source_fail 'Linux Node 24+/npm is unavailable. Run bash setup.sh.'
selection="$ROOT/.source-setup/home"
[[ -f "$selection" && ! -L "$selection" && ! -L "$ROOT/.source-setup" ]] || source_fail 'Run bash setup.sh once to select your private profile.'
mapfile -t selected < "$selection"
[[ ${#selected[@]} == 1 && "${selected[0]}" == /* && "${selected[0]}" != /mnt/* ]] || source_fail 'Saved profile selection is invalid; rerun bash setup.sh.'
export HARNESS_HOME="${selected[0]}"
[[ -z "${HARNESS_DATA_DIR+x}" && -z "${HARNESS_LEGACY_ROOT+x}" && -z "${HARNESS_INIT+x}" && -z "${HARNESS_SELECT_DATA+x}" && -z "${HARNESS_MIGRATION_RETRY+x}" ]] || source_fail 'Remove explicit profile migration/data overrides before using this guided launcher.'
[[ -f "$ROOT/dist/client/index.html" && -d "$ROOT/node_modules" ]] || source_fail 'Build or dependencies are missing. Run bash setup.sh again.'
source_sandbox_check
printf 'Starting your saved profile. Default browser address: http://localhost:3000\nStop with Ctrl+C.\n'
exec npm start
