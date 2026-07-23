#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: ./uos20-arm64/build.sh [options]

Build the current AnySentry, Observer, and Sentry HEAD revisions for the verified
Shuangyang UOS 20 ARM64 customer profile.

Options:
  --component NAME  all, sentry, node, app, clickhouse, observer, l3,
                    diagnostics, or assemble (default: all)
  --version VERSION Release version (default: AnySentry package version + uos date)
  --prepare-only    Validate and export the locked integration sources, then stop
  --help            Show this help
EOF
}

component=all
prepare_only=0
release_version=
while (($#)); do
  case "$1" in
    --component) [[ $# -ge 2 ]] || die '--component requires a value'; component=$2; shift 2 ;;
    --version) [[ $# -ge 2 ]] || die '--version requires a value'; release_version=$2; shift 2 ;;
    --prepare-only) prepare_only=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$component" in
  all|sentry|node|app|clickhouse|observer|l3|diagnostics|assemble) ;;
  *) die "unsupported component: $component" ;;
esac

for command_name in git tar sha256sum awk sed; do require_command "$command_name"; done

if [[ -z "$release_version" ]]; then
  base=$(node -p "require('$ANYSENTRY_REPO/package.json').version")
  release_version=${base}-uos$(date +%Y%m%d)
fi
RELEASE_VERSION=$release_version
export RELEASE_VERSION

note "Preparing isolated current-HEAD sources"
prepare_sources
if ((prepare_only)); then
  note "Prepared sources at $SOURCE_DIR"
  exit 0
fi

ensure_stage
export ANYSENTRY_BUILD_DIR=$BUILD_DIR ANYSENTRY_STAGE_DIR=$STAGE_DIR

run_component() {
  note "Building $1"
  if [[ $1 == assemble ]]; then
    "$SCRIPT_DIR/scripts/assemble-release.sh"
  else
    "$SCRIPT_DIR/scripts/build-$1.sh"
  fi
}

case "$component" in
  all)
    rm -rf "$STAGE_DIR"
    mkdir -p "$STAGE_DIR"
    run_component sentry
    run_component node
    run_component app
    run_component clickhouse
    run_component observer
    run_component l3
    run_component diagnostics
    run_component assemble
    ;;
  assemble) run_component assemble ;;
  *) run_component "$component" ;;
esac
