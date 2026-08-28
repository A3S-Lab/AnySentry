#!/usr/bin/env bash

set -euo pipefail

DIFY_LAB_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck disable=SC1091
source "$DIFY_LAB_ROOT/versions.env"

DIFY_LAB_RUNTIME="${DIFY_LAB_RUNTIME:-$DIFY_LAB_ROOT/.runtime}"
DIFY_LAB_DOCKER_DIR="$DIFY_LAB_RUNTIME/upstream/dify-$DIFY_VERSION/docker"
DIFY_LAB_PROJECT_NAME="${DIFY_LAB_PROJECT_NAME:-anysentry-dify-observation}"
DIFY_LAB_UID="${DIFY_LAB_UID:-$(id -u)}"
DIFY_LAB_GID="${DIFY_LAB_GID:-$(id -g)}"
DIFY_LAB_CONSOLE_URL="${DIFY_LAB_CONSOLE_URL:-http://127.0.0.1:18080}"
# Upstream publishes the optional plugin debugging listener on 5003. That common development port
# is frequently occupied; keep this isolated lab on its own overridable loopback port.
EXPOSE_PLUGIN_DEBUGGING_PORT="${DIFY_LAB_PLUGIN_DEBUGGING_PORT:-15003}"

export DIFY_LAB_ROOT
export DIFY_LAB_RUNTIME
export DIFY_LAB_UID
export DIFY_LAB_GID
export DIFY_LAB_MODEL
export EXPOSE_PLUGIN_DEBUGGING_PORT

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_prepared() {
  [[ -f "$DIFY_LAB_DOCKER_DIR/docker-compose.yaml" ]] ||
    die "lab is not prepared; run $DIFY_LAB_ROOT/scripts/prepare.sh"
  [[ -f "$DIFY_LAB_DOCKER_DIR/.env" ]] ||
    die "Dify runtime environment is missing; run prepare.sh"
}

dify_compose() {
  require_prepared
  docker compose \
    --project-name "$DIFY_LAB_PROJECT_NAME" \
    --project-directory "$DIFY_LAB_DOCKER_DIR" \
    --env-file "$DIFY_LAB_DOCKER_DIR/.env" \
    --file "$DIFY_LAB_DOCKER_DIR/docker-compose.yaml" \
    --file "$DIFY_LAB_ROOT/compose.observation.yml" \
    "$@"
}

read_secret_file() {
  local path="$1"
  [[ -f "$path" ]] || die "secret file not found: $path"
  tr -d '\r\n' <"$path"
}

create_private_file() {
  local path="$1"
  install -d -m 0700 "$(dirname -- "$path")"
  : >"$path"
  chmod 0600 "$path"
}
