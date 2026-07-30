FROM node:24-bookworm-slim

ARG LAB_VERSION=0.1.0

LABEL org.opencontainers.image.title="AnySentry Agent Runtime Lab" \
      org.opencontainers.image.description="A3S Code and Pi coding-agent test runtimes" \
      org.opencontainers.image.version="${LAB_VERSION}"

ENV NODE_ENV=production \
    AGENT_WORKSPACE=/workspace \
    AGENT_INTERVAL_SECONDS=20 \
    PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    PI_CODING_AGENT_SESSION_DIR=/home/node/.pi/agent/sessions \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git procps ripgrep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/agent-lab

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY app ./app
COPY config ./config
COPY entrypoint.sh ./

RUN chmod 0755 /opt/agent-lab/entrypoint.sh \
    && mkdir -p /workspace /home/node/.pi/agent/sessions \
    && chown -R node:node /workspace /home/node/.pi

USER node
WORKDIR /workspace

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD test -f /tmp/agent-ready || exit 1

ENTRYPOINT ["/opt/agent-lab/entrypoint.sh"]
