#!/bin/sh

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
script_dir="$repo_root/deploy/staging"
offline="${STAGING_PREFLIGHT_OFFLINE:-0}"
image_name="${STAGING_NGINX_IMAGE:-c1rcle-nginx:staging-preflight}"
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/c1rcle-staging-preflight.XXXXXX")

cleanup() {
    set +e
    rm -rf "$temp_dir"
}

trap cleanup EXIT

if [ "${1:-}" = "--offline" ]; then
    offline=1
fi

require_command() {
    command_name="$1"
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Required command not found: $command_name" >&2
        exit 127
    fi
}

require_command node
require_command rg
require_command docker

if [ "${1:-}" = "--render-dry-run" ]; then
    echo "Rendering the non-routable Render staging dry-run fixture..."
    (
        cd "$repo_root"
        node "$script_dir/render-preflight-dry-run.mjs" --output "$temp_dir/c1rcle-api.conf"
    )
    if rg -n '\$\{' "$temp_dir/c1rcle-api.conf"; then
        echo "Unresolved Nginx placeholder found in the Render dry-run profile" >&2
        exit 1
    fi
    if ! docker info >/dev/null 2>&1; then
        echo "Docker daemon is required for Nginx config validation" >&2
        exit 1
    fi
    if ! docker image inspect "$image_name" >/dev/null 2>&1; then
        echo "Building the Nginx validation image..."
        (
            cd "$repo_root"
            docker build --file deploy/docker/Dockerfile.nginx --tag "$image_name" .
        )
    fi
    docker run --rm \
        --entrypoint nginx \
        --add-host circle-v2-backend-staging.internal:127.0.0.1 \
        --volume "$temp_dir/c1rcle-api.conf:/etc/nginx/conf.d/c1rcle-api.conf:ro" \
        "$image_name" \
        -t -c /etc/nginx/nginx.conf
    echo "UNMEASURED: Render DNS, private reachability, health, auth, and proxy source CIDRs require created staging services."
    echo "Render staging preflight dry-run passed."
    exit 0
fi

echo "Validating the strict staging environment contract..."
(
    cd "$repo_root"
    node "$script_dir/validate-environment.mjs"
)

echo "Rendering the staging Nginx profile..."
(
    cd "$repo_root"
    node "$script_dir/render-nginx.mjs" --output "$temp_dir/c1rcle-api.conf"
)

if rg -n '\$\{' "$temp_dir/c1rcle-api.conf"; then
    echo "Unresolved Nginx placeholder found in the rendered profile" >&2
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "Docker daemon is required for Nginx config validation" >&2
    exit 1
fi

if ! docker image inspect "$image_name" >/dev/null 2>&1; then
    echo "Building the Nginx validation image..."
    (
        cd "$repo_root"
        docker build --file deploy/docker/Dockerfile.nginx --tag "$image_name" .
    )
fi

if [ "$NGINX_TLS_MODE" = "nginx" ]; then
    if [ ! -f "$NGINX_TLS_CERTIFICATE" ] || [ ! -f "$NGINX_TLS_CERTIFICATE_KEY" ]; then
        echo "NGINX TLS mode is nginx, but certificate files are not present for preflight" >&2
        exit 1
    fi
fi

echo "Running nginx -t against the rendered profile..."
if [ "$NGINX_TLS_MODE" = "nginx" ]; then
    docker run --rm \
        --entrypoint nginx \
        --volume "$temp_dir/c1rcle-api.conf:/etc/nginx/conf.d/c1rcle-api.conf:ro" \
        --volume "$NGINX_TLS_CERTIFICATE:$NGINX_TLS_CERTIFICATE:ro" \
        --volume "$NGINX_TLS_CERTIFICATE_KEY:$NGINX_TLS_CERTIFICATE_KEY:ro" \
        "$image_name" \
        -t -c /etc/nginx/nginx.conf
else
    docker run --rm \
        --entrypoint nginx \
        --volume "$temp_dir/c1rcle-api.conf:/etc/nginx/conf.d/c1rcle-api.conf:ro" \
        "$image_name" \
        -t -c /etc/nginx/nginx.conf
fi

if [ "$offline" = "1" ]; then
    echo "UNMEASURED: network, public health, readiness, version, and DNS checks were skipped (--offline)."
    echo "Staging preflight passed for environment, rendering, and Nginx syntax."
    exit 0
fi

require_command curl

upstream_host=$(FASTIFY_UPSTREAM="$FASTIFY_UPSTREAM" node --input-type=module -e '
  const value = process.env.FASTIFY_UPSTREAM;
  const host = value.startsWith("[") ? value.slice(1, value.indexOf("]")) : value.slice(0, value.lastIndexOf(":"));
  process.stdout.write(host);
')

echo "Resolving Fastify upstream host..."
FASTIFY_UPSTREAM_HOST="$upstream_host" node --input-type=module -e '
  import dns from "node:dns/promises";
  await dns.lookup(process.env.FASTIFY_UPSTREAM_HOST);
'

echo "Checking Fastify directly where the preflight runner can reach it..."
curl --fail --silent --show-error --max-time 5 \
    "http://${FASTIFY_UPSTREAM}/api/v2/internal/health" >/dev/null

if [ -z "${STAGING_BASE_URL:-}" ]; then
    echo "STAGING_BASE_URL is required for network preflight" >&2
    exit 64
fi

case "$STAGING_BASE_URL" in
    https://*) : ;;
    *)
        echo "STAGING_BASE_URL must use HTTPS" >&2
        exit 64
        ;;
esac

echo "Checking public health through the intended edge..."
health_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --max-time 10 "$STAGING_BASE_URL/api/v2/internal/health")
case "$health_status" in
    200) : ;;
    *)
        echo "Expected public health status 200, received $health_status" >&2
        exit 1
        ;;
esac

echo "Checking that readiness and version are not broadly public..."
readiness_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --max-time 10 "$STAGING_BASE_URL/api/v2/internal/readiness")
version_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --max-time 10 "$STAGING_BASE_URL/api/v2/internal/version")
if [ "$readiness_status" != "404" ] || [ "$version_status" != "404" ]; then
    echo "Expected public readiness/version to be 404; received readiness=$readiness_status version=$version_status" >&2
    exit 1
fi

if [ -n "${STAGING_APPROVED_READINESS_URL:-}" ]; then
    approved_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --max-time 10 "$STAGING_APPROVED_READINESS_URL")
    case "$approved_status" in
        200|503) : ;;
        *)
            echo "Approved readiness source returned unexpected status $approved_status" >&2
            exit 1
            ;;
    esac
else
    echo "UNMEASURED: STAGING_APPROVED_READINESS_URL was not provided; approved-source readiness was not tested."
fi

echo "Staging preflight passed."
