#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

require_command docker
tmp=$(mktemp -d "$BUILD_DIR/kafka.XXXXXX")
container=anysentry-kafka-extract-$$
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
docker image inspect "$KAFKA_IMAGE" >/dev/null 2>&1 ||
  docker pull --platform linux/arm64 "$KAFKA_IMAGE"
docker create --platform linux/arm64 --name "$container" --entrypoint /bin/true \
  "$KAFKA_IMAGE" >/dev/null
docker cp "$container:/opt/kafka/." "$tmp/"
docker rm "$container" >/dev/null
root=$tmp
[[ -x $root/bin/kafka-server-start.sh ]] || die 'Kafka archive is incomplete'
[[ -f $root/libs/kafka_2.13-${KAFKA_VERSION}.jar ]] || die 'Kafka image version is incorrect'
rm -rf "$STAGE_DIR/kafka"
install -d -m 0755 "$STAGE_DIR/kafka"
cp -a "$root/bin" "$root/libs" "$root/licenses" "$root/site-docs" "$STAGE_DIR/kafka/"
printf '%s\n' "$KAFKA_VERSION" >"$STAGE_DIR/kafka/VERSION"
printf '%s\n' "$KAFKA_IMAGE" >"$STAGE_DIR/kafka/IMAGE"
