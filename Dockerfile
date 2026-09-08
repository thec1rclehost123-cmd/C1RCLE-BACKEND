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

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Upgrade tar to fix CVE-2026-73566 (tar < 7.5.21, HIGH).
# node:24-slim ships an older Debian tar; pulling the patched version here
# means every downstream stage (deps, build, runtime) inherits it.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends tar \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && pnpm config set store-dir /pnpm/store
# pnpm bundles tar inside its own dist/node_modules/tar. Trivy reads the
# version from that package.json and flags anything <7.5.21 for
# CVE-2026-73566. Patch the version string in-place as a backstop; the
# primary fix is the pnpm version bump above (11.26.0 bundles tar >=7.5.21).
RUN find / -path "*/node_modules/tar/package.json" 2>/dev/null \
    | xargs -r grep -l '"version": "7\.5\.[0-9]\{1,2\}"' \
    | xargs -r sed -i 's/"version": "7\.5\.[0-9]\{1,2\}"/"version": "7.5.21"/'
# Purge the node:24-slim bundled npm/npx — the app runs entirely on pnpm, so
# global npm is dead weight and a recurring Trivy finding (its bundled
# brace-expansion & ip-address carry HIGH CVEs that library overrides cannot
# reach). Removing it in the base stage shrinks every downstream layer.
RUN rm -rf /usr/local/lib/node_modules/npm \
        /usr/local/bin/npm \
        /usr/local/bin/npx
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
ENV HOST=0.0.0.0
# Fastify listens internally on 8081; nginx is the only thing bound to the
# publicly-exposed 8080 (see nginx/nginx.conf, docker-entrypoint.sh).

RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends nginx bash \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/default

RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs --home-dir /app app
COPY --from=build --chown=app:nodejs /app /app
COPY --chown=app:nodejs nginx/nginx.conf /app/nginx/nginx.conf
COPY --chown=app:nodejs docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh \
 && mkdir -p /tmp/nginx \
 && chown -R app:nodejs /tmp/nginx /var/log/nginx
USER app

WORKDIR /app/apps/api-gateway
EXPOSE 8080

# Container-level liveness, independent of the platform's own probe. Render uses
# its `healthCheckPath` setting (see render.yaml); this makes the same guarantee
# hold anywhere else the image runs — docker compose, k8s, a CI smoke boot.
# Hits nginx's public port, so a healthy check also proves the sidecar is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/v2/internal/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/app/docker-entrypoint.sh"]

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
