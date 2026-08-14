# Extend the public a3s-observer image with the AnySentry forwarder (node, apt-free).
# Build from the repo root and push to YOUR registry:
#   docker build -f deploy/observer-forwarder.Dockerfile -t <your-registry>/anysentry-observer:latest .
#   docker push <your-registry>/anysentry-observer:latest
# The node binary comes from the bookworm image (glibc-built) and runs on the observer's
# ubuntu:24.04 base (glibc 2.39).
ARG OBSERVER_IMAGE=ghcr.io/a3s-lab/observer:latest
ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE} AS nodebin
FROM ${OBSERVER_IMAGE}
COPY --from=nodebin /usr/local/bin/node /usr/local/bin/node
COPY scripts/observer-forward.js /opt/observer-forward.js
COPY scripts/observer-agent-attribution.js /opt/observer-agent-attribution.js
COPY scripts/observer-attribution-merge.js /opt/observer-attribution-merge.js
COPY scripts/observer-agent-runtime-signatures.js /opt/observer-agent-runtime-signatures.js
COPY scripts/observer-agent-templates.js /opt/observer-agent-templates.js
COPY scripts/observer-docker-discovery.js /opt/observer-docker-discovery.js
COPY scripts/observer-behavior-discovery.js /opt/observer-behavior-discovery.js
COPY scripts/observer-priority-queue.js /opt/observer-priority-queue.js
COPY scripts/observer-event-dedup.js /opt/observer-event-dedup.js
COPY scripts/observer-workload-filter.js /opt/observer-workload-filter.js
COPY scripts/observer-infrastructure-roots.js /opt/observer-infrastructure-roots.js
COPY scripts/observer-e2e-witness.js /opt/observer-e2e-witness.js
# The DaemonSet supplies the command: a3s-observer-collector | node /opt/observer-forward.js
