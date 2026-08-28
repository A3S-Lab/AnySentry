FROM node:24-bookworm-slim

ARG LAB_VERSION=0.1.0

LABEL org.opencontainers.image.title="AnySentry Pi TLS Observability Lab" \
      org.opencontainers.image.description="Deterministic Pi and OpenAI-compatible TLS/HTTP fixture" \
      org.opencontainers.image.version="${LAB_VERSION}"

ENV NODE_ENV=production \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    PI_OFFLINE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash binutils ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/pi-tls-lab

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY app ./app
COPY scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh

RUN chmod 0755 ./scripts/container-entrypoint.sh \
    && mkdir -p /workspace /results /tls /pi-state \
    && chown -R node:node /workspace /results /pi-state

ENTRYPOINT ["/opt/pi-tls-lab/scripts/container-entrypoint.sh"]
CMD ["pi"]
