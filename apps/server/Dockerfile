# syntax=docker/dockerfile:1.7
# Build context: repository root (pnpm workspace). See compose.yaml.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
# Prisma's schema engine (migrations) needs OpenSSL.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@10.34.4 --activate
WORKDIR /repo

# All server dependencies (dev included) for building and migrating.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter server

FROM deps AS build
COPY apps/server/ apps/server/
WORKDIR /repo/apps/server
RUN pnpm run build

# One-shot job: applies committed migrations (`prisma migrate deploy`).
FROM build AS migration
ENV NODE_ENV=production
USER node
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter server --prod

# Minimal runtime: production dependencies, compiled code, migration list (for readiness).
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /repo/apps/server
COPY --from=prod-deps /repo /repo
COPY --from=build /repo/apps/server/dist ./dist
COPY apps/server/prisma/migrations ./prisma/migrations
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
