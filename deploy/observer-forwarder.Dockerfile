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
COPY scripts/observer-*.js /opt/
# The DaemonSet runs observer-supervisor.js as PID 1; it owns the collector/forwarder stream.
ENTRYPOINT ["/usr/local/bin/node", "/opt/observer-supervisor.js"]
