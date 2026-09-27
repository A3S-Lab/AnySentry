#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

case "${1:-}" in
  '')
    dify_compose down --remove-orphans
    ;;
  --volumes)
    dify_compose down --remove-orphans --volumes
    printf 'Removed containers, networks, and volumes owned by Compose project %s.\n' \
      "$DIFY_LAB_PROJECT_NAME"
    ;;
  *)
    die "usage: down.sh [--volumes]"
    ;;
esac

printf 'Generated files remain in %s and are ignored by git.\n' "$DIFY_LAB_RUNTIME"
