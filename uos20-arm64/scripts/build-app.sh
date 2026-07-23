#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

[[ -f "$STAGE_DIR/native/a3s-sentry.linux-arm64-gnu.node" ]] || die 'run the sentry component first'
app_source=$SOURCE_DIR/anysentry
cd "$app_source"
pnpm install --frozen-lockfile
pnpm build
rm -rf "$STAGE_DIR/app"
pnpm --filter @anysentry/api --prod deploy "$STAGE_DIR/app"
install -d -m 0755 "$STAGE_DIR/app/web"
cp -a "$app_source/apps/web/dist/." "$STAGE_DIR/app/web/"

sentry_dir=$STAGE_DIR/app/node_modules/@a3s-lab/sentry
[[ -d "$sentry_dir" ]] || die "deployed Sentry module missing: $sentry_dir"
rm -f "$sentry_dir"/*.node
install -m 0644 "$STAGE_DIR/native/a3s-sentry.linux-arm64-gnu.node" "$sentry_dir/a3s-sentry.linux-arm64-gnu.node"
code_dir=$STAGE_DIR/app/node_modules/@a3s-lab/code
[[ -d "$code_dir" ]] || die "deployed a3s-code module missing: $code_dir"
find "$code_dir" -maxdepth 1 -name '*.node' -delete
rm -rf "$STAGE_DIR/app/node_modules/@a3s-lab/code-linux-x64-gnu" "$STAGE_DIR/app/node_modules/@a3s-lab/code-linux-x64-musl"
find "$STAGE_DIR/app/node_modules/.pnpm" -maxdepth 1 -type d \
  \( -name '@a3s-lab+code-linux-x64-gnu*' -o -name '@a3s-lab+code-linux-x64-musl*' \) \
  -exec rm -rf {} + 2>/dev/null || true
# pnpm deploy resolves optional native dependencies for the x86_64 build host.
# msgpackr has a JavaScript fallback, so the host-only accelerator must not enter
# the ARM64 release.
rm -rf "$STAGE_DIR/app/node_modules/@msgpackr-extract/msgpackr-extract-linux-x64"
find "$STAGE_DIR/app/node_modules/.pnpm" -maxdepth 1 -type d \
  -name '@msgpackr-extract+msgpackr-extract-linux-x64@*' \
  -exec rm -rf {} + 2>/dev/null || true
rm -f "$STAGE_DIR/app/node_modules/.pnpm/node_modules/@anysentry/api"
find "$STAGE_DIR/app" -xtype l -delete
