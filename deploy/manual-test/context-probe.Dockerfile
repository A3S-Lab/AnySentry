ARG BASE_IMAGE=127.0.0.1:5000/anysentry:local
FROM ${BASE_IMAGE}
COPY scripts/service-context-probe.mjs /opt/anysentry/service-context-probe.mjs
ENTRYPOINT ["node", "/opt/anysentry/service-context-probe.mjs"]
