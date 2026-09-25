#!/bin/bash
#
# Interim, budget-tier deployment shape: nginx + Fastify in ONE container.
# See docs/nginx/sidecar-deployment.md for the full rationale and the
# procedure to switch to the real two-service (SOTA) topology once a paid
# Render Private Service plan is available.
#
# Fastify binds 127.0.0.1 only — never reachable except through this
# container's own nginx process. nginx binds the public $PORT and proxies
# to Fastify over loopback, reusing the exact same deploy/nginx/ templates
# and deploy/docker/nginx-entrypoint.sh the real two-service topology uses
# (FASTIFY_UPSTREAM is just set to 127.0.0.1:<port> instead of a private
# service DNS name) — so switching topologies later is a deploy-target
# change, not a config rewrite.

set -eu

sidecar_fastify_port="${SIDECAR_FASTIFY_PORT:-8081}"

fastify_pid=""
nginx_pid=""

shutdown() {
    trap - TERM INT
    [ -n "$nginx_pid" ] && kill -TERM "$nginx_pid" 2>/dev/null || true
    [ -n "$fastify_pid" ] && kill -TERM "$fastify_pid" 2>/dev/null || true
    wait 2>/dev/null || true
    exit 0
}
trap shutdown TERM INT

echo "[sidecar] starting Fastify on 127.0.0.1:${sidecar_fastify_port} (internal only)"
(
    cd /app/apps/api-gateway
    exec env HOST=127.0.0.1 PORT="$sidecar_fastify_port" NODE_ENV="${NODE_ENV:-production}" \
        node --import tsx src/server.ts
) &
fastify_pid=$!

echo "[sidecar] waiting for Fastify to become healthy..."
# 90s, not 30s: Render's free-tier hibernation wake-up alone can take 30s+
# before Fastify even logs its first plugin-init line (observed: a cold
# boot from hibernation took ~34s end to end, past the old 30s budget —
# not an application bug, just a slow container wake racing a tight
# timeout). This is a budget-tier constraint, not a health-check
# relaxation — /health itself still requires a real listening server.
health_check_budget_s="${SIDECAR_HEALTH_CHECK_BUDGET_S:-90}"
ready=0
for _ in $(seq 1 "$health_check_budget_s"); do
    if wget -qO- "http://127.0.0.1:${sidecar_fastify_port}/api/v2/internal/health" >/dev/null 2>&1; then
        ready=1
        break
    fi
    if ! kill -0 "$fastify_pid" 2>/dev/null; then
        echo "[sidecar] Fastify exited before becoming healthy" >&2
        exit 1
    fi
    sleep 1
done

if [ "$ready" != "1" ]; then
    echo "[sidecar] Fastify did not become healthy within ${health_check_budget_s}s" >&2
    kill -TERM "$fastify_pid" 2>/dev/null || true
    exit 1
fi

echo "[sidecar] Fastify healthy. Starting nginx (public edge)..."
export FASTIFY_UPSTREAM="127.0.0.1:${sidecar_fastify_port}"
/usr/local/bin/c1rcle-nginx-entrypoint &
nginx_pid=$!

# Exit (and let the container restart) if either process dies — the sidecar
# is only healthy with both running.
set +e
wait -n "$fastify_pid" "$nginx_pid"
exit_code=$?
set -e
echo "[sidecar] one process exited (code $exit_code), shutting down the other"
shutdown
