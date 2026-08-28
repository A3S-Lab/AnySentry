FROM python:3.13-slim-bookworm

ARG LAB_VERSION=0.1.0

LABEL org.opencontainers.image.title="AnySentry LangChain TLS Observability Lab" \
      org.opencontainers.image.description="Deterministic LangChain tool-calling Agent over HTTPS" \
      org.opencontainers.image.version="${LAB_VERSION}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/langchain-tls-lab

# Test-only dependencies. Production AnySentry/Observer packages do not depend on LangChain.
RUN pip install --no-cache-dir \
    langchain==1.3.17 \
    langchain-openai==1.6.0

COPY app ./app

ENTRYPOINT ["python", "/opt/langchain-tls-lab/app/run_langchain_agent.py"]
