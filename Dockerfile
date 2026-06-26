# syntax=docker/dockerfile:1
# AnySentry — single OCI service. The api serves both the dashboard API and the built web app, so
# prod is one container, same-origin (no proxy).
#
# Built with pnpm (the workspace's package manager). npm ci hits a known "Exit handler never called!"
# crash on this dependency set that silently skips bin-linking (→ "rsbuild: not found"); pnpm doesn't.
# Runtime is ubuntu:24.04 because @a3s-lab/sentry's linux-x64-gnu .node needs GLIBC_2.39 (bookworm's
# 2.36 is too old); the glibc node binary from the build stage runs on it. linux/amd64 only —
# @a3s-lab/sentry ships no linux-arm64 binary.

FROM node:20-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
# Manifests + lockfile first so the dependency layer caches independently of source churn.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json apps/api/.npmrc ./apps/api/
RUN corepack prepare pnpm@9.0.0 --activate && pnpm install --frozen-lockfile
# Source + build both apps, then emit a self-contained prod bundle for the api (real node_modules,
# no symlinks into pnpm's store) that the runtime stage can copy verbatim.
COPY . .
# Serve the dashboard under a sub-path when behind a gateway that does NOT strip a prefix
# (e.g. --build-arg PUBLIC_BASE_PATH=/apps/anysentry). Default "" = served at root.
ARG PUBLIC_BASE_PATH=""
ENV PUBLIC_BASE_PATH=${PUBLIC_BASE_PATH}
RUN pnpm --filter @anysentry/web build \
 && pnpm --filter @anysentry/api build \
 && pnpm --filter @anysentry/api --prod deploy /out

FROM ubuntu:24.04 AS runtime
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
ENV NODE_ENV=production PORT=29653 ANYSENTRY_WEB_DIR=/app/web
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /src/apps/web/dist ./web
EXPOSE 29653
CMD ["node", "dist/main.js"]
