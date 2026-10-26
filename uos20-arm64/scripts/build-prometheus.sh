#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

CACHE=$BUILD_DIR/cache
mkdir -p "$CACHE"
prom_archive=$CACHE/prometheus-${PROMETHEUS_VERSION}.linux-arm64.tar.gz
node_archive=$CACHE/node_exporter-${NODE_EXPORTER_VERSION}.linux-arm64.tar.gz
[[ -f "$prom_archive" ]] || curl --fail --location --retry 3 -o "$prom_archive" \
  "https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.linux-arm64.tar.gz"
echo "$PROMETHEUS_ARM64_SHA256  $prom_archive" | sha256sum --check
[[ -f "$node_archive" ]] || curl --fail --location --retry 3 -o "$node_archive" \
  "https://github.com/prometheus/node_exporter/releases/download/v${NODE_EXPORTER_VERSION}/node_exporter-${NODE_EXPORTER_VERSION}.linux-arm64.tar.gz"
echo "$NODE_EXPORTER_ARM64_SHA256  $node_archive" | sha256sum --check

prom_tmp=$(mktemp -d "$BUILD_DIR/prom.XXXXXX")
node_tmp=$(mktemp -d "$BUILD_DIR/nodeexp.XXXXXX")
trap 'rm -rf "$prom_tmp" "$node_tmp"' EXIT
tar -xzf "$prom_archive" -C "$prom_tmp"
tar -xzf "$node_archive" -C "$node_tmp"
prom_root=$(find "$prom_tmp" -mindepth 1 -maxdepth 1 -type d -print -quit)
node_root=$(find "$node_tmp" -mindepth 1 -maxdepth 1 -type d -print -quit)
[[ -x "$prom_root/prometheus" && -x "$prom_root/promtool" ]] || die "Prometheus archive incomplete"
[[ -x "$node_root/node_exporter" ]] || die "node_exporter archive incomplete"

rm -rf "$STAGE_DIR/prometheus"
install -d -m 0755 "$STAGE_DIR/prometheus/bin" "$STAGE_DIR/prometheus/conf"
install -m 0755 "$prom_root/prometheus" "$prom_root/promtool" "$STAGE_DIR/prometheus/bin/"
install -m 0755 "$node_root/node_exporter" "$STAGE_DIR/prometheus/bin/"
install -m 0644 "$CHANNEL_DIR/package/config/prometheus.yml" "$STAGE_DIR/prometheus/conf/prometheus.yml"
printf '%s\n' "$PROMETHEUS_VERSION" >"$STAGE_DIR/prometheus/PROMETHEUS_VERSION"
printf '%s\n' "$NODE_EXPORTER_VERSION" >"$STAGE_DIR/prometheus/NODE_EXPORTER_VERSION"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/prometheus/bin/prometheus"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/prometheus/bin/node_exporter"
