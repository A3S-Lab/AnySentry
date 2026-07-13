#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
STAGE_DIR=${ANYSENTRY_STAGE_DIR:-$ROOT_DIR/release/uos20-arm64}
SENTRY_ADDON=$STAGE_DIR/native/a3s-sentry.linux-arm64-gnu.node

if [[ ! -f "$SENTRY_ADDON" ]]; then
  echo "ARM64 sentry addon is missing; run build-sentry.sh first" >&2
  exit 1
fi

cd "$ROOT_DIR"
pnpm install --frozen-lockfile
pnpm build

rm -rf "$STAGE_DIR/app"
pnpm --filter @anysentry/api --prod deploy "$STAGE_DIR/app"

mkdir -p "$STAGE_DIR/app/web"
cp -a "$ROOT_DIR/apps/web/dist/." "$STAGE_DIR/app/web/"

sentry_dir=$STAGE_DIR/app/node_modules/@a3s-lab/sentry
if [[ ! -d "$sentry_dir" ]]; then
  echo "deployed @a3s-lab/sentry package not found: $sentry_dir" >&2
  exit 1
fi
rm -f "$sentry_dir"/*.node
install -m 0644 "$SENTRY_ADDON" "$sentry_dir/a3s-sentry.linux-arm64-gnu.node"

# L3 is staged separately with its verified ARM64 addon. Never ship the build host's optional
# x86_64 @a3s-lab/code native package in the API deployment.
rm -rf "$STAGE_DIR/app/node_modules/@a3s-lab/code" \
  "$STAGE_DIR/app/node_modules/@a3s-lab/code-linux-x64-gnu" \
  "$STAGE_DIR/app/node_modules/@a3s-lab/code-linux-x64-musl"

echo "AnySentry application staged at $STAGE_DIR/app"
