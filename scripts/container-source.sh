#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() { printf '%s\n' 'Container source: setup.sh --container [--check | --no-start]' 'start.sh --container [--check | --stop]' 'Explicit setup selects an empty local Linux ext4/xfs/btrfs directory. Existing storage is never reset.'; }
[[ $# -le 2 ]] || fail 'Unexpected arguments.'
action="${1:-}"; option="${2:-}"
[[ "$action" == setup || "$action" == start ]] || fail 'Expected setup or start.'
[[ -z "$option" || "$option" == --check || "$action" == setup && "$option" == --no-start || "$action" == start && "$option" == --stop ]] || fail 'Unsupported option.'
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 && "$EUID" != 0 ]] || fail 'Container source currently supports non-root Linux x64. Windows D: storage/entrypoints require later Windows validation; nothing was provisioned.'
for command in docker stat realpath flock curl; do command -v "$command" >/dev/null || fail "Missing $command. Install prerequisites through your approved administrator; this script never provisions the host."; done
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION DOCKER_CONFIG; do [[ -z "${!name:-}" ]] || fail "Unset $name; select a supported local Docker context explicitly before running."; done
# Only host connection configuration reaches Docker. Provider keys and inherited .env values do not.
d() { env -i HOME="$HOME" PATH="$PATH" docker "$@"; }
context="$(d context show)"
endpoint="$(d context inspect "$context" --format '{{.Endpoints.docker.Host}}')"
[[ "$endpoint" == unix:///* && -S "${endpoint#unix://}" ]] || fail 'Only a reachable local Unix-socket Docker engine is supported. Remote/TCP/SSH endpoints are refused.'
engine="$(d --context "$context" info --format '{{.OSType}}|{{.Architecture}}|{{json .SecurityOptions}}')" || fail 'Local Docker engine is unavailable or permission denied.'
[[ "$engine" == linux\|x86_64\|* || "$engine" == linux\|amd64\|* ]] || fail 'A local Linux x64 engine is required.'
[[ "$engine" != *rootless* && "$engine" != *userns* ]] || fail 'Rootless/userns-remapped engines need a separately validated UID/storage mapping; this launcher does not change engine settings.'
version="$(d compose version --short)"; version="${version#v}"
[[ "$version" =~ ^([0-9]+)\.([0-9]+)\. ]] || fail 'Cannot determine Docker Compose version.'
(( BASH_REMATCH[1] > 2 || BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 24 )) || fail 'Docker Compose 2.24+ is required.'
printf 'Local Linux engine and Compose capability checks passed. No host settings changed.\n'
[[ "$option" != --check ]] || exit 0
selection="$ROOT/.container-source/selection"
private_dir() {
  [[ -d "$1" && ! -L "$1" && "$(realpath -e -- "$1")" == "$1" && "$(stat -c %u -- "$1")" == "$UID" && "$(stat -c %a -- "$1")" == 700 ]] || fail 'Storage/selection directories must exist, be canonical, private (0700) and owned by this user.'
}
private_file() { [[ -f "$1" && ! -L "$1" && "$(stat -c %h -- "$1")" == 1 && "$(stat -c %u -- "$1")" == "$UID" && "$(stat -c %a -- "$1")" == 600 ]] || fail 'Storage selection/identity must be a private regular single-link file.'; }
check_root() {
  private_dir "$ABYSSUS_STORAGE_ROOT"
  [[ "$ABYSSUS_STORAGE_ROOT" != "$HOME" && "$ABYSSUS_STORAGE_ROOT" != / && "$ABYSSUS_STORAGE_ROOT" != "$ROOT" && "$ABYSSUS_STORAGE_ROOT" != "$ROOT/"* && "$ROOT" != "$ABYSSUS_STORAGE_ROOT/"* ]] || fail 'Choose a separate app storage folder, outside the source/install directory.'
  case "$(stat -f -c %T -- "$ABYSSUS_STORAGE_ROOT")" in ext2/ext3|xfs|btrfs) ;; *) fail 'Only local Linux ext4/xfs/btrfs storage is supported. Network, Windows and engine-volume alternatives are not implicitly selected.';; esac
}
check_storage() {
  check_root
  private_file "$ABYSSUS_STORAGE_ROOT/.storage-id"
  [[ "$(cat -- "$ABYSSUS_STORAGE_ROOT/.storage-id")" == "$ABYSSUS_STORAGE_ID" ]] || fail 'Selected storage identity changed; startup stopped.'
  for name in state config workspace runtime; do private_dir "$ABYSSUS_STORAGE_ROOT/$name"; done
  for name in state config workspace; do
    private_file "$ABYSSUS_STORAGE_ROOT/$name/.storage-id"
    [[ "$(cat -- "$ABYSSUS_STORAGE_ROOT/$name/.storage-id")" == "$ABYSSUS_STORAGE_ID" ]] || fail 'A storage mount was replaced; restore the selected storage.'
  done
  for name in state/container-storage.json state/migration.json state/profile/profile.json state/profile/state/state.sqlite config/.env; do private_file "$ABYSSUS_STORAGE_ROOT/$name"; done
}
ABYSSUS_UID="$UID"; ABYSSUS_GID="$(id -g)"
c() { env -i HOME="$HOME" PATH="$PATH" ABYSSUS_STORAGE_ROOT="$ABYSSUS_STORAGE_ROOT" ABYSSUS_STORAGE_ID="$ABYSSUS_STORAGE_ID" ABYSSUS_UID="$ABYSSUS_UID" ABYSSUS_GID="$ABYSSUS_GID" docker --context "$context" compose --env-file /dev/null -f "$ROOT/containers/compose.yaml" "$@"; }
if [[ -e "$selection" || -L "$selection" ]]; then
  private_dir "$ROOT/.container-source"; private_file "$selection"
  mapfile -t selected < "$selection"
  [[ ${#selected[@]} == 2 ]] || fail 'Invalid saved selection.'
  ABYSSUS_STORAGE_ROOT="${selected[0]}"; ABYSSUS_STORAGE_ID="${selected[1]}"
  [[ "$ABYSSUS_STORAGE_ID" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || fail 'Invalid storage identity.'
  check_storage
else
  [[ "$action" == setup && -t 0 && -t 1 ]] || fail 'Run interactive setup.sh --container to explicitly initialize new storage.'
  [[ ! -e "$ROOT/.container-source" && ! -L "$ROOT/.container-source" ]] || fail 'Incomplete saved selection exists; preserve and inspect it before initialization.'
  printf 'Choose durable local Linux storage. Docker images/cache live separately in the engine data root; this script does not move that disk. Windows D: binds/volumes are not accepted yet.\n'
  read -r -p 'Absolute new/empty app storage directory: ' ABYSSUS_STORAGE_ROOT
  [[ "$ABYSSUS_STORAGE_ROOT" == /* && "$ABYSSUS_STORAGE_ROOT" != *','* && ! "$ABYSSUS_STORAGE_ROOT" =~ [[:cntrl:]] ]] || fail 'Use a single-line absolute Linux path without commas.'
  [[ "$(realpath -m -- "$ABYSSUS_STORAGE_ROOT")" == "$ABYSSUS_STORAGE_ROOT" ]] || fail 'Use a canonical directory without links or dot segments.'
  read -r -p 'Initialize this empty directory for abysSUS? Type INITIALIZE: ' consent
  [[ "$consent" == INITIALIZE ]] || fail 'Nothing initialized.'
  [[ -e "$ABYSSUS_STORAGE_ROOT" ]] || mkdir -- "$ABYSSUS_STORAGE_ROOT"
  check_root
  [[ -z "$(find "$ABYSSUS_STORAGE_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail 'Initialization requires an empty directory; existing files are preserved.'
  ABYSSUS_STORAGE_ID="$(cat /proc/sys/kernel/random/uuid)"
  # Reserve selection first. Interrupted initialization is never mistaken for a fresh setup.
  mkdir -- "$ROOT/.container-source"
  printf '%s\n%s\n' "$ABYSSUS_STORAGE_ROOT" "$ABYSSUS_STORAGE_ID" > "$selection"
  c build controller
  d --context "$context" run --rm --read-only --cap-drop ALL --security-opt no-new-privileges --network none --pids-limit 128 --memory 2g --cpus 2 --user "$ABYSSUS_UID:$ABYSSUS_GID" --tmpfs /tmp:size=128m,mode=1777 --mount "type=bind,source=$ABYSSUS_STORAGE_ROOT,target=/initialize" --env "HARNESS_STORAGE_ID=$ABYSSUS_STORAGE_ID" abyssus-controller:m28 node --import tsx containers/initialize.ts
  check_storage
fi
exec 9>"$ABYSSUS_STORAGE_ROOT/runtime/supervisor.lock"
flock -n 9 || fail 'Another source supervisor owns this storage.'
if [[ "$action" == setup ]]; then
  [[ -t 0 && -t 1 ]] || fail 'Provider setup requires an interactive terminal.'
  c build controller
  c run --rm --no-deps controller node --import tsx containers/configure.ts
  [[ "$option" != --no-start ]] || exit 0
fi
if [[ "$option" == --stop ]]; then c stop controller; exit 0; fi
# Never build, initialize, recreate volumes or pull implicitly on start.
check_storage
c up -d --no-build --pull never --wait --wait-timeout 90 controller
request="$(c exec -T controller node --import tsx containers/probe.ts request)"
response="$(env -i PATH="$PATH" curl --noproxy '*' --silent --show-error --fail --max-time 5 --header 'Content-Type: application/json' --data-binary @- http://127.0.0.1:3000/api/backend/readiness <<< "$request")"
printf '%s\n%s\n' "$request" "$response" | c exec -T controller node --import tsx containers/probe.ts verify
printf 'Authenticated readiness passed. Open http://127.0.0.1:3000 and pair with the single-use code below. Stop with bash start.sh --container --stop.\n'
c logs --tail 4 controller
