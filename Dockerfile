# syntax=docker/dockerfile:1

# ============================================================================
#  C1RCLE-BACKEND — one image, one process.
#
#  This repo is a modular monolith. The ONLY deployable is apps/api-gateway
#  (Fastify 5). @c1rcle/core and @c1rcle/contracts are workspace libraries that
#  load into the SAME Node process — they are not separate services and do not
#  get their own containers. Hence one Dockerfile, at the repo root.
#
#  Runtime uses the tsx loader rather than `node dist/server.js` because
#  @c1rcle/core is currently consumed as TypeScript source (its package.json
#  "exports" point at ./src/*.ts, no dist). Compiling the whole graph to JS is
#  a follow-up — see NOTE at the bottom of this file.
# ============================================================================

FROM node:26-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && pnpm config set store-dir /pnpm/store
WORKDIR /app

# ---- deps -----------------------------------------------------------------
# Copy only manifests + lockfile first so `pnpm install` is cached until a
# package.json or the lockfile actually changes.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api-gateway/package.json   apps/api-gateway/
COPY packages/core/package.json      packages/core/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build --------------------------------------------------------------
# Only @c1rcle/contracts needs a real build (it is imported from ./dist).
# The gateway + @c1rcle/core run straight from .ts via the tsx loader.
FROM deps AS build
COPY . .
RUN pnpm --filter @c1rcle/contracts build

# ---- runtime ---------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs --home-dir /app app
COPY --from=build --chown=app:nodejs /app /app
USER app

WORKDIR /app/apps/api-gateway
EXPOSE 8080

# Container-level liveness, independent of the platform's own probe. Render uses
# its `healthCheckPath` setting (see render.yaml); this makes the same guarantee
# hold anywhere else the image runs — docker compose, k8s, a CI smoke boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??8080)+'/api/v2/internal/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Cloud Run / k8s health probe: GET /api/v2/internal/health
# tsx (a devDependency of api-gateway) strips types across the whole workspace
# graph — including @c1rcle/core/src — at load time.
CMD ["node", "--import", "tsx", "src/server.ts"]

# ============================================================================
#  NOTE — moving to a compiled runtime later (smaller image, faster cold start)
#  1. In packages/core/package.json add  "default": "./dist/<file>.js"  to every
#     "exports" entry (the subpath ones too, e.g. ./infrastructure/memory), and
#     a top-level "main": "./dist/index.js".
#  2. build stage:  RUN pnpm build           (turbo: contracts -> core -> gateway)
#  3. CMD:          ["node", "dist/server.js"]
#  4. runtime deps can then drop to  pnpm deploy --filter api-gateway --prod .
#  Verify `pnpm --filter @c1rcle/core build` is green first — it has not been
#  exercised since the 2026-08-28 recovery.
#
#  If `pnpm install` fails building a native dep on -slim, swap the base image
#  to  node:24  (full) for the deps + build stages only.
# ============================================================================
