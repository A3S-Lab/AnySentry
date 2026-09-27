#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

mode="${1:-all}"
case "$mode" in
  all)
    "$SCRIPT_DIR/prepare.sh"
    dify_compose up -d --build
    ;;
  --mocks-only)
    "$SCRIPT_DIR/prepare.sh"
    dify_compose up -d --build llm-mock tool-mock
    ;;
  *)
    die "usage: up.sh [--mocks-only]"
    ;;
esac

printf 'Started project %s. Run %s/health.sh for readiness.\n' \
  "$DIFY_LAB_PROJECT_NAME" "$SCRIPT_DIR"
