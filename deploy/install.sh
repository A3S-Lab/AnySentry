#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${ANYSENTRY_INSTALL_MODE:-${1:-docker}}"
NAMESPACE="${ANYSENTRY_NAMESPACE:-anysentry}"
CLICKHOUSE_USER="${CLICKHOUSE_USER:-anysentry}"
CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-change-me}"
OBSERVER_IMAGE="${ANYSENTRY_OBSERVER_IMAGE:-}"
APPLY_INGRESS="${ANYSENTRY_APPLY_INGRESS:-0}"

usage() {
  cat <<'USAGE'
Install AnySentry as an integrated middleware stack.

Modes:
  docker       Build and run AnySentry + ClickHouse with docker compose.
  kubernetes   Install AnySentry + ClickHouse + a3s-observer DaemonSet.

Environment:
  ANYSENTRY_INSTALL_MODE=docker|kubernetes
  ANYSENTRY_NAMESPACE=anysentry
  CLICKHOUSE_USER=anysentry
  CLICKHOUSE_PASSWORD=change-me
  ANYSENTRY_OBSERVER_IMAGE=<registry>/anysentry-observer:latest
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
    | ANYSENTRY_INGEST_URL=http://localhost:29653/security-center/ingest node scripts/observer-forward.js

For a fully integrated node/fleet install with a3s-observer, use:
  ANYSENTRY_INSTALL_MODE=kubernetes deploy/install.sh
DONE
}

install_kubernetes() {
  need kubectl
  echo "Installing AnySentry + ClickHouse + a3s-observer in namespace ${NAMESPACE}..."

  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n "$NAMESPACE" create secret generic anysentry-clickhouse \
    --from-literal=CLICKHOUSE_USER="$CLICKHOUSE_USER" \
    --from-literal=CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" \
    --dry-run=client -o yaml | kubectl apply -f -

  kubectl -n "$NAMESPACE" apply -f "$ROOT_DIR/deploy/anysentry.yaml"

  if [[ -n "$OBSERVER_IMAGE" ]]; then
    sed "s#ghcr.io/a3s-lab/anysentry-observer:latest#${OBSERVER_IMAGE}#g" "$ROOT_DIR/deploy/observer.yaml" | kubectl -n "$NAMESPACE" apply -f -
  else
    kubectl -n "$NAMESPACE" apply -f "$ROOT_DIR/deploy/observer.yaml"
  fi

  if [[ "$APPLY_INGRESS" == "1" ]]; then
    kubectl -n "$NAMESPACE" apply -f "$ROOT_DIR/deploy/ingress.yaml"
  fi

  kubectl -n "$NAMESPACE" rollout status deploy/clickhouse
  kubectl -n "$NAMESPACE" rollout status deploy/anysentry
  kubectl -n "$NAMESPACE" rollout status daemonset/a3s-observer

  cat <<DONE

AnySentry is installed with:
  - AnySentry API/dashboard
  - @a3s-lab/sentry judge bundled in the AnySentry image
  - ClickHouse storage
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
