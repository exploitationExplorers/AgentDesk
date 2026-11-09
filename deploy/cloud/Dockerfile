# syntax=docker/dockerfile:1.7
FROM scratch AS codex-download
FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c AS codex
RUN apt-get update && apt-get install -y --no-install-recommends musl && rm -rf /var/lib/apt/lists/*
COPY deploy/cloud/install-codex.mjs /install-codex.mjs
RUN --mount=type=bind,from=codex-download,target=/codex-download node /install-codex.mjs /opt/codex /codex-download/codex.tgz

FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
WORKDIR /source
COPY . .
RUN --mount=type=cache,id=agentdesk-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @agentdesk/sidecar... --filter @agentdesk/cloud-gateway... --filter @agentdesk/desktop... \
    --store-dir /pnpm/store --network-concurrency=8
RUN pnpm --filter @agentdesk/sidecar build:cloud \
    && pnpm --filter @agentdesk/desktop build:cloud \
    && pnpm --filter @agentdesk/cloud-gateway build \
    && pnpm --filter @agentdesk/cloud-gateway exec tsx scripts/package-runtime.ts /release/gateway

FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c AS gateway
RUN groupadd -g 10000 agentdesk && useradd -u 10001 -g 10000 --no-create-home gateway
WORKDIR /app
COPY --from=build /release/gateway/node_modules ./node_modules
COPY --from=build /source/apps/cloud-gateway/dist ./dist
COPY deploy/cloud/health.mjs ./health.mjs
ENV NODE_ENV=production GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=3000
USER 10001:10000
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s CMD ["node", "health.mjs", "gateway"]
CMD ["node", "dist/server.mjs"]

FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c AS runner
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates git openssh-client python3 musl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10000 agentdesk && useradd -u 10002 -g 10000 --home-dir /home/agentdesk --no-create-home agentdesk
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
WORKDIR /app
COPY --from=build /source/apps/sidecar/dist-cloud ./
COPY --from=build /source/apps/sidecar/skills ./skills
COPY deploy/cloud/health.mjs ./health.mjs
COPY --from=codex /opt/codex /opt/codex
ENV NODE_ENV=production HOME=/home/agentdesk AGENTDESK_SKILLS_DIR=/app/skills AGENTDESK_CODEX_BIN=/opt/codex/bin/codex PATH=/opt/codex/bin:$PATH
USER 10002:10000
EXPOSE 17893
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s CMD ["node", "health.mjs", "runner"]
CMD ["node", "cloud.mjs"]
