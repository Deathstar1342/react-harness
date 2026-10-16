#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
fail() { printf '%s\n' "$*" >&2; exit 1; }
action="${1:-}"; shift
option=''; requested=''
while (( $# )); do
  case "$1" in --help) printf 'Usage: bash setup.sh [--check | --no-start] [--runtime-root /external/folder]\nbash start.sh [--check]\nNative desktop with a preexisting local Linux Docker engine; no host provisioning.\n'; exit 0;;
    --check|--no-start) [[ -z "$option" ]] || fail 'Duplicate option'; option="$1";;
    --runtime-root) [[ "$action" == setup && $# -gt 1 && -z "$requested" ]] || fail 'Invalid runtime root'; requested="$2"; shift;;
    --container) ;; # Former explicit container spelling now selects the same native default.
    *) fail 'Unsupported argument. Use --help.';; esac
  shift
done
[[ "$action" == setup || "$action" == start ]] || fail 'Invalid action'
[[ "$action" != start || "$option" != --no-start ]] || fail 'Unsupported start option'
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 && "$EUID" != 0 ]] || fail 'Use a non-root Linux x64 desktop (Ubuntu 22.04/24.04), or setup.ps1 on Windows.'
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONFIG DOCKER_API_VERSION; do [[ -z "${!name:-}" ]] || fail "Remove inherited $name before setup/start."; done
for command in docker git tar realpath stat sha256sum timeout; do command -v "$command" >/dev/null || fail "Missing $command. Nothing was installed; use your approved administrator."; done
docker_cli="$(command -v docker)"
d() { env -i HOME="$HOME" PATH="$PATH" TMPDIR="${runtime:-/tmp}" timeout --foreground 1800 "$docker_cli" "$@"; }
context="$(d context show)"
[[ "$context" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] || fail 'Invalid local context'
endpoint="$(d context inspect "$context" --format '{{.Endpoints.docker.Host}}')"
[[ "$endpoint" == unix:///* && -S "${endpoint#unix://}" ]] || fail 'Only a local Unix-socket engine is supported; remote/TCP/SSH contexts are refused.'
engine="$(d --context "$context" info --format '{{.ID}}|{{.OSType}}|{{.Architecture}}|{{.DockerRootDir}}|{{json .SecurityOptions}}')"
[[ "$engine" == *'|linux|x86_64|'* || "$engine" == *'|linux|amd64|'* ]] || fail 'A Linux x64 engine is required'
[[ "$engine" != *rootless* && "$engine" != *userns* ]] || fail 'Rootless/remapped engines are unsupported; no settings changed.'
builder="$(d --context "$context" buildx inspect "$context")"
driver="$(sed -n 's/^Driver:[[:blank:]]*//p' <<< "$builder")"
build_endpoint="$(sed -n 's/^Endpoint:[[:blank:]]*//p' <<< "$builder")"
builder="$driver|$build_endpoint"
[[ "$builder" == "docker|$context" || "$builder" == "docker|$endpoint" ]] || fail 'Use the local context Docker build driver; remote/custom builders are refused.'
printf 'Local engine ready. Engine data root: %s\n' "$(cut -d '|' -f4 <<< "$engine")"
printf 'Docker images/build cache remain in that separate engine storage. A VM backing drive is not proven by this path and is never moved by setup.\n'
[[ "$action" != setup || "$option" != --check ]] || exit 0
selection="$ROOT/.container-desktop-source/selection"
private_dir() { [[ -d "$1" && ! -L "$1" && "$(realpath -e -- "$1")" == "$1" && "$(stat -c %u -- "$1")" == "$UID" && "$(stat -c %a -- "$1")" == 700 ]] || fail 'Selected runtime must exist, be canonical, private (0700), and owned by you.'; }
regular() { [[ -f "$1" && ! -L "$1" && "$(stat -c %h -- "$1")" == 1 && "$(stat -c %u -- "$1")" == "$UID" ]] || fail 'Missing, linked or unowned source runtime file; restore the selection.'; }
verify() {
  private_dir "$runtime"; regular "$runtime/receipt"; regular "$runtime/payload/SHA256SUMS"
  mapfile -t receipt < "$runtime/receipt"
  [[ ${#receipt[@]} == 6 && "${receipt[0]}" == linux && "${receipt[1]}" =~ ^[a-f0-9]{40}$ && "${receipt[2]}" == "$context" && "${receipt[3]}" == "$endpoint" && "${receipt[4]}" == "$engine" && "${receipt[5]}" =~ ^[a-f0-9]{64}$ ]] || fail 'Runtime/engine identity changed or setup is incomplete; nothing replayed.'
  [[ "$(sha256sum "$runtime/payload/SHA256SUMS" | cut -d ' ' -f1)" == "${receipt[5]}" ]] || fail 'Runtime inventory changed'
  [[ -z "$(find "$runtime/payload" -type l -o -type f -links +1 -o ! -type f ! -type d)" ]] || fail 'Runtime links/special files refused'
  [[ "$(find "$runtime/payload" -type f | wc -l)" == "$(( $(wc -l < "$runtime/payload/SHA256SUMS") + 1 ))" ]] || fail 'Extra or missing runtime files'
  (cd "$runtime/payload" && sha256sum --check --status SHA256SUMS) || fail 'Runtime integrity failed; files preserved'
  for directory in desktop-data logs crashes temp; do private_dir "$runtime/$directory"; done
  for image in controller worker; do
    regular "$runtime/$image.iid"; iid="$(cat "$runtime/$image.iid")"
    [[ "$iid" =~ ^sha256:[a-f0-9]{64}$ && "$(d --context "$context" image inspect "$iid" --format '{{.Id}}')" == "$iid" ]] || fail 'Exact runtime image missing; start never pulls or builds'
  done
}
if [[ -e "$selection" || -L "$selection" ]]; then
  private_dir "$ROOT/.container-desktop-source"; regular "$selection"; mapfile -t saved < "$selection"
  [[ ${#saved[@]} == 1 ]] || fail 'Invalid saved source runtime selection'
  runtime="${saved[0]}"; [[ -z "$requested" || "$requested" == "$runtime" ]] || fail 'Existing selection cannot be silently relocated'
  verify
else
  [[ "$action" == setup ]] || fail 'Run setup.sh once to select the source runtime location.'
  [[ ! -e "$ROOT/.container-desktop-source" ]] || fail 'Interrupted selection exists; preserve it for recovery'
  runtime="$requested"
  if [[ -z "$runtime" ]]; then [[ -t 0 ]] || fail 'Choose --runtime-root explicitly in a noninteractive setup'; read -r -p 'Absolute new external runtime/build/cache directory: ' runtime; fi
  [[ "$runtime" == /* && "$runtime" != *','* && ! "$runtime" =~ [[:cntrl:]] && "$(realpath -m -- "$runtime")" == "$runtime" ]] || fail 'Use a canonical absolute path without links/control characters/commas'
  [[ "$runtime" != / && "$runtime" != "$HOME" && "$runtime" != "$ROOT" && "$runtime" != "$ROOT/"* && "$ROOT" != "$runtime/"* ]] || fail 'Choose a separate external runtime directory'
  [[ ! -e "$runtime" ]] || fail 'New setup requires an absent runtime directory; existing contents are preserved'
  [[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] || fail 'Commit or preserve tracked edits before building an exact source snapshot'
  source="$(git -C "$ROOT" rev-parse HEAD)"; [[ "$source" =~ ^[a-f0-9]{40}$ ]] || fail 'Exact Git source commit required'
  mkdir -- "$runtime"; private_dir "$runtime"
  mkdir -- "$ROOT/.container-desktop-source"; printf '%s\n' "$runtime" > "$selection"
  printf '%s\n' "$source" > "$runtime/build-intent"
  mkdir "$runtime/snapshot" "$runtime/desktop-data" "$runtime/logs" "$runtime/crashes" "$runtime/temp"
  # Exact tracked allowlist. No working-tree/untracked files enter any build context.
  git -C "$ROOT" archive --format=tar --output="$runtime/source.tar" "$source" .dockerignore package.json package-lock.json tsconfig.json vite.config.ts index.html client server shared desktop containers helper/core.py helper/apt_adapter.py helper/apt.conf scripts/desktop-build.mjs scripts/stage-support-runtime.py scripts/stage-container-runtime.py scripts/source-payload.py LICENSE
  tar -xf "$runtime/source.tar" -C "$runtime/snapshot"
  [[ -z "$(find "$runtime/snapshot" -type l -o ! -type f ! -type d)" ]] || fail 'Source snapshot contains unsupported links/special files'
  for image in controller worker; do
    dockerfile=containers/Dockerfile; [[ "$image" != worker ]] || dockerfile=containers/Worker.Dockerfile
    printf '%s\n' "build-$image" >> "$runtime/build-intent"
    d --context "$context" buildx build --builder "$context" --load --iidfile "$runtime/$image.iid" -f "$runtime/snapshot/$dockerfile" "$runtime/snapshot" > "$runtime/logs/$image-build.log" 2>&1 || fail "Image build failed; inspect $runtime/logs/$image-build.log. Interrupted setup is retained."
  done
  printf 'build-export-payload\n' >> "$runtime/build-intent"
  d --context "$context" buildx build --builder "$context" --build-arg TARGET_OS=linux --build-arg "SOURCE_COMMIT=$source" --build-arg "CONTROLLER_IMAGE=$(cat "$runtime/controller.iid")" --build-arg "WORKER_IMAGE=$(cat "$runtime/worker.iid")" --output "type=local,dest=$runtime/payload" -f "$runtime/snapshot/containers/Source.Dockerfile" "$runtime/snapshot" > "$runtime/logs/payload-build.log" 2>&1 || fail "Payload build failed; inspect $runtime/logs/payload-build.log. Nothing replayed or deleted."
  printf '%s\n' linux "$source" "$context" "$endpoint" "$engine" "$(sha256sum "$runtime/payload/SHA256SUMS" | cut -d ' ' -f1)" > "$runtime/receipt"
  verify
fi
[[ "$option" != --check && "$option" != --no-start ]] || { printf 'Source runtime inventory and exact engine images verified. App storage/provider setup remains in the native desktop.\n'; exit 0; }
# No automatic initialization, provider input, build, update or effect replay here.
launch_env=(HOME="$HOME" PATH="$PATH" TMPDIR="$runtime/temp" XDG_CACHE_HOME="$runtime/desktop-data")
for name in DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS LANG; do [[ -z "${!name:-}" ]] || launch_env+=("$name=${!name}"); done
cd "$runtime"
exec env -i "${launch_env[@]}" "$runtime/payload/electron/electron" "$runtime/payload/app/desktop/source-entry.cjs"
