#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${ANYSENTRY_INSTALL_MODE:-${1:-docker}}"
NAMESPACE="${ANYSENTRY_NAMESPACE:-anysentry}"
CLICKHOUSE_USER="${CLICKHOUSE_USER:-anysentry}"
CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-change-me}"
OBSERVER_IMAGE="${ANYSENTRY_OBSERVER_IMAGE:-}"
ANYSENTRY_IMAGE="${ANYSENTRY_IMAGE:-ghcr.io/a3s-lab/anysentry:latest}"
FLINK_IMAGE="${ANYSENTRY_FLINK_IMAGE:-}"
APPLY_INGRESS="${ANYSENTRY_APPLY_INGRESS:-0}"
MANAGEMENT_TOKEN="${ANYSENTRY_MANAGEMENT_TOKEN:-}"
BOOTSTRAP_PORT="${ANYSENTRY_OBSERVER_BOOTSTRAP_PORT:-29654}"

usage() {
  cat <<'USAGE'
Install AnySentry as an integrated middleware stack.

Modes:
  docker       Build and run AnySentry + ClickHouse with docker compose.
  kubernetes   Install the complete AnySentry Kubernetes stack and observer DaemonSet.

Environment:
  ANYSENTRY_INSTALL_MODE=docker|kubernetes
  ANYSENTRY_NAMESPACE=anysentry
  CLICKHOUSE_USER=anysentry
  CLICKHOUSE_PASSWORD=change-me
  ANYSENTRY_IMAGE=ghcr.io/a3s-lab/anysentry:latest
  ANYSENTRY_FLINK_IMAGE=<registry>/anysentry-flink-streaming:<version>  (required for Kubernetes)
  ANYSENTRY_OBSERVER_IMAGE=<registry>/anysentry-observer:latest
  ANYSENTRY_MANAGEMENT_TOKEN=<random high-entropy token>  (generated when omitted in Kubernetes)
  ANYSENTRY_OBSERVER_BOOTSTRAP_PORT=29654
  ANYSENTRY_APPLY_INGRESS=1

Examples:
  deploy/install.sh docker
  ANYSENTRY_INSTALL_MODE=kubernetes CLICKHOUSE_PASSWORD="$(openssl rand -hex 16)" deploy/install.sh
USAGE
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

install_docker() {
  need docker
  echo "Installing AnySentry + ClickHouse with docker compose..."
  (cd "$ROOT_DIR" && docker compose up -d --build)
  cat <<'DONE'

AnySentry is starting at:
  http://localhost:29653

This image already bundles @a3s-lab/sentry. To attach a local a3s-observer collector:
  A3S_OBSERVER_JSON=1 sudo -E a3s-observer-collector \
    | FORWARD_FILTER_MODE=shadow FORWARD_RETAIN_UNKNOWN=true FORWARD_RETAIN_NON_AGENT=false FORWARD_NOISE_POLICY=balanced ANYSENTRY_INGEST_URL=http://localhost:29653/security-center/ingest node scripts/observer-forward.js

For a fully integrated node/fleet install with a3s-observer, use:
  ANYSENTRY_INSTALL_MODE=kubernetes deploy/install.sh
DONE
}

install_kubernetes() {
  need kubectl
  need node
  need openssl
  if [[ -z "$FLINK_IMAGE" ]]; then
    echo "ANYSENTRY_FLINK_IMAGE is required: build streaming/flink/Dockerfile and publish the image first" >&2
    exit 1
  fi
  echo "Installing the complete AnySentry stack in namespace ${NAMESPACE}..."

  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n "$NAMESPACE" create secret generic anysentry-clickhouse \
    --from-literal=CLICKHOUSE_USER="$CLICKHOUSE_USER" \
    --from-literal=CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" \
    --dry-run=client -o yaml | kubectl apply -f -
  if [[ -z "$MANAGEMENT_TOKEN" ]]; then
    MANAGEMENT_TOKEN="$(openssl rand -hex 32)"
  fi
  kubectl -n "$NAMESPACE" create secret generic anysentry-control-auth \
    --from-literal=management-token="$MANAGEMENT_TOKEN" \
    --dry-run=client -o yaml | kubectl apply -f -

  render_core_manifest() {
    sed \
      -e "s/namespace: anysentry/namespace: ${NAMESPACE}/g" \
      -e "s#ghcr.io/a3s-lab/anysentry:latest#${ANYSENTRY_IMAGE}#g" \
      "$1"
  }

  render_streaming_manifest() {
    sed \
      -e "s/namespace: anysentry/namespace: ${NAMESPACE}/g" \
      -e "s#ghcr.io/a3s-lab/anysentry-flink-streaming:latest#${FLINK_IMAGE}#g" \
      -e "s#ghcr.io/a3s-lab/anysentry:latest#${ANYSENTRY_IMAGE}#g" \
      "$1"
  }

  render_core_manifest "$ROOT_DIR/deploy/anysentry.yaml" | kubectl -n "$NAMESPACE" apply -f -
  # Migrate the legacy minute-loop Deployment and rerun the idempotent one-shot Job on every
  # install/upgrade. Kafka topic creation is durable and safe to repeat with --if-not-exists.
  kubectl -n "$NAMESPACE" delete deployment kafka-topic-manager --ignore-not-found --wait=true
  kubectl -n "$NAMESPACE" delete job kafka-topic-manager --ignore-not-found --wait=true
  render_streaming_manifest "$ROOT_DIR/deploy/streaming.yaml" | kubectl -n "$NAMESPACE" apply -f -
  # Environment-backed Secret values are read only at process start. This also makes an explicit
  # token rotation deterministic on reinstall before the bootstrap client authenticates.
  kubectl -n "$NAMESPACE" rollout restart deployment/anysentry

  # Source credentials must exist before the DaemonSet starts. Bootstrap one exact managed Source
  # per node through the authenticated API, then publish only the resulting mapping as a Kubernetes
  # Secret. No token is rendered into a repository manifest or printed to stdout.
  kubectl -n "$NAMESPACE" rollout status deploy/clickhouse --timeout=300s
  kubectl -n "$NAMESPACE" rollout status statefulset/redis --timeout=300s
  kubectl -n "$NAMESPACE" rollout status deploy/anysentry --timeout=300s
  observer_auth_dir="$(mktemp -d)"
  observer_port_forward_pid=""
  cleanup_observer_bootstrap() {
    if [[ -n "$observer_port_forward_pid" ]]; then
      kill "$observer_port_forward_pid" >/dev/null 2>&1 || true
      wait "$observer_port_forward_pid" >/dev/null 2>&1 || true
    fi
    if [[ -n "$observer_auth_dir" && -d "$observer_auth_dir" ]]; then
      rm -rf -- "$observer_auth_dir"
    fi
  }
  trap cleanup_observer_bootstrap EXIT
  kubectl -n "$NAMESPACE" port-forward service/anysentry "${BOOTSTRAP_PORT}:29653" \
    >"$observer_auth_dir/port-forward.log" 2>&1 &
  observer_port_forward_pid="$!"
  observer_collectors="$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')"
  ANYSENTRY_API_BASE="http://127.0.0.1:${BOOTSTRAP_PORT}/security-center" \
  ANYSENTRY_MANAGEMENT_TOKEN="$MANAGEMENT_TOKEN" \
  ANYSENTRY_OBSERVER_COLLECTOR_IDS="$observer_collectors" \
  ANYSENTRY_OBSERVER_AUTH_OUTPUT="$observer_auth_dir/observer-sources.json" \
  ANYSENTRY_OBSERVER_AUTH_FORMAT=json \
    node "$ROOT_DIR/scripts/bootstrap-observer-sources.mjs"
  kubectl -n "$NAMESPACE" create secret generic anysentry-observer-auth \
    --from-file=observer-sources.json="$observer_auth_dir/observer-sources.json" \
    --dry-run=client -o yaml | kubectl apply -f -
  cleanup_observer_bootstrap
  observer_auth_dir=""
  observer_port_forward_pid=""
  trap - EXIT

  if [[ -n "$OBSERVER_IMAGE" ]]; then
    sed \
      -e "s/namespace: anysentry/namespace: ${NAMESPACE}/g" \
      -e "s#ghcr.io/a3s-lab/anysentry-observer:latest#${OBSERVER_IMAGE}#g" \
      "$ROOT_DIR/deploy/observer.yaml" | kubectl -n "$NAMESPACE" apply -f -
  else
    sed "s/namespace: anysentry/namespace: ${NAMESPACE}/g" \
      "$ROOT_DIR/deploy/observer.yaml" | kubectl -n "$NAMESPACE" apply -f -
  fi
  # Projected Secrets update in place, while the Forwarder intentionally reads its credential once
  # at process start. Restart after every create/rotate so no pod keeps the now-revoked token.
  kubectl -n "$NAMESPACE" rollout restart daemonset/a3s-observer

  if [[ "$APPLY_INGRESS" == "1" ]]; then
    sed "s/namespace: anysentry/namespace: ${NAMESPACE}/g" \
      "$ROOT_DIR/deploy/ingress.yaml" | kubectl -n "$NAMESPACE" apply -f -
  fi

  kubectl -n "$NAMESPACE" rollout status statefulset/kafka --timeout=600s
  kubectl -n "$NAMESPACE" wait --for=condition=complete job/kafka-topic-manager --timeout=600s
  kubectl -n "$NAMESPACE" rollout status deploy/flink-jobmanager --timeout=600s
  kubectl -n "$NAMESPACE" rollout status deploy/flink-taskmanager --timeout=600s
  kubectl -n "$NAMESPACE" rollout status deploy/flink-job-submit --timeout=600s
  kubectl -n "$NAMESPACE" rollout status deploy/fast-judge --timeout=300s
  kubectl -n "$NAMESPACE" rollout status deploy/l3-worker --timeout=300s
  kubectl -n "$NAMESPACE" rollout status deploy/stream-worker --timeout=300s
  kubectl -n "$NAMESPACE" rollout status deploy/composite-judge --timeout=300s
  kubectl -n "$NAMESPACE" rollout status deploy/supply-chain-assessment --timeout=300s
  kubectl -n "$NAMESPACE" rollout status daemonset/a3s-observer --timeout=300s

  cat <<DONE

AnySentry is installed with:
  - AnySentry API/dashboard
  - ClickHouse and Redis durable state
  - Fast Judge and L3 asynchronous workers
  - Kafka, Flink, Stream Worker, and Composite Judge
  - OSV supply-chain assessment worker
  - a3s-observer observe-only DaemonSet + AnySentry forwarder

Open a local tunnel:
  kubectl -n ${NAMESPACE} port-forward svc/anysentry 29653:29653
DONE
}

case "$MODE" in
  docker)
    install_docker
    ;;
  kubernetes|k8s)
    install_kubernetes
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "unknown install mode: $MODE" >&2
    usage
    exit 1
    ;;
esac
