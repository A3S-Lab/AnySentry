#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

require_command docker

flink_source=$SOURCE_DIR/anysentry/streaming/flink
m2=$BUILD_DIR/maven-cache
mkdir -p "$m2"
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/maven-home \
  -v "$flink_source:/src" -v "$m2:/tmp/maven-home/.m2" \
  -w /src "$MAVEN_BUILDER_IMAGE" mvn -B package
job_jar=$flink_source/target/anysentry-flink-streaming.jar
[[ -f $job_jar ]] || die "Flink job build output is missing: $job_jar"

tmp=$(mktemp -d "$BUILD_DIR/flink.XXXXXX")
container=anysentry-flink-extract-$$
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
docker image inspect "$FLINK_IMAGE" >/dev/null 2>&1 ||
  docker pull --platform linux/arm64 "$FLINK_IMAGE"
docker create --platform linux/arm64 --name "$container" --entrypoint /bin/true \
  "$FLINK_IMAGE" >/dev/null
docker cp "$container:/opt/flink/." "$tmp/"
docker rm "$container" >/dev/null
root=$tmp
[[ -x $root/bin/jobmanager.sh && -x $root/bin/taskmanager.sh ]] || die 'Flink archive is incomplete'
[[ -f $root/lib/flink-dist-${FLINK_VERSION}.jar ]] || die 'Flink image version is incorrect'
rm -rf "$STAGE_DIR/flink"
install -d -m 0755 "$STAGE_DIR/flink/usrlib"
cp -a "$root/bin" "$root/conf" "$root/lib" "$root/licenses" "$STAGE_DIR/flink/"
install -m 0644 "$job_jar" "$STAGE_DIR/flink/usrlib/anysentry-flink-streaming.jar"
printf '%s\n' "$FLINK_VERSION" >"$STAGE_DIR/flink/VERSION"
printf '%s\n' "$FLINK_KAFKA_CONNECTOR_VERSION" >"$STAGE_DIR/flink/KAFKA_CONNECTOR_VERSION"
printf '%s\n' "$MAVEN_BUILDER_IMAGE" >"$STAGE_DIR/flink/MAVEN_BUILDER_IMAGE"
printf '%s\n' "$FLINK_IMAGE" >"$STAGE_DIR/flink/IMAGE"
