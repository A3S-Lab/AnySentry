#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

CACHE=$BUILD_DIR/cache
archive=$CACHE/kafka_${KAFKA_SCALA_VERSION}-${KAFKA_VERSION}.tgz
mkdir -p "$CACHE"
if [[ ! -f $archive ]]; then
  curl --fail --location --retry 3 -o "$archive" \
    "https://archive.apache.org/dist/kafka/${KAFKA_VERSION}/kafka_${KAFKA_SCALA_VERSION}-${KAFKA_VERSION}.tgz"
fi
echo "$KAFKA_SHA512  $archive" | sha512sum --check

tmp=$(mktemp -d "$BUILD_DIR/kafka.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$archive" -C "$tmp"
root=$tmp/kafka_${KAFKA_SCALA_VERSION}-${KAFKA_VERSION}
[[ -x $root/bin/kafka-server-start.sh ]] || die 'Kafka archive is incomplete'
rm -rf "$STAGE_DIR/kafka"
install -d -m 0755 "$STAGE_DIR/kafka"
cp -a "$root/bin" "$root/libs" "$root/licenses" "$root/site-docs" "$STAGE_DIR/kafka/"
printf '%s\n' "$KAFKA_VERSION" >"$STAGE_DIR/kafka/VERSION"

