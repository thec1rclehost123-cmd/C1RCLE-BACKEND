#!/bin/sh

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
image_name="${C1RCLE_NGINX_IMAGE:-c1rcle-nginx:local}"
container_name="c1rcle-nginx-validation-$$"
api_pid=""
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/c1rcle-nginx-validation.XXXXXX")

cleanup() {
    set +e
    docker rm -f "$container_name" >/dev/null 2>&1
    if [ -n "$api_pid" ]; then
        kill "$api_pid" >/dev/null 2>&1
        wait "$api_pid" >/dev/null 2>&1
    fi
    rm -rf "$temp_dir"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

require_command() {
    command_name="$1"
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Required command not found: $command_name" >&2
        exit 127
    fi
}

require_command docker
require_command curl
require_command openssl
require_command pnpm

echo "Building the Fastify gateway..."
(
    cd "$repo_root"
    pnpm --filter api-gateway build
)

echo "Starting the Fastify source entrypoint on 127.0.0.1:8080..."
(
    cd "$repo_root"
    exec env \
        NODE_ENV=test \
        STORAGE_DRIVER=memory \
        HOST=0.0.0.0 \
        PORT=8080 \
        TRUSTED_PROXY_CIDRS=127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1 \
        BUILD_SHA=nginx-validation \
        "$repo_root/apps/api-gateway/node_modules/.bin/tsx" apps/api-gateway/src/server.ts >"$temp_dir/api.log" 2>&1
) &
api_pid=$!

api_ready=0
for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:8080/api/v2/internal/health >/dev/null 2>&1; then
        api_ready=1
        break
    fi
    sleep 1
done

if [ "$api_ready" != "1" ]; then
    echo "Fastify did not become healthy. Logs:" >&2
    sed -n '1,160p' "$temp_dir/api.log" >&2
    exit 1
fi

echo "Building the Nginx validation image..."
(
    cd "$repo_root"
    docker build --file deploy/docker/Dockerfile.nginx --tag "$image_name" .
)

echo "Checking the rendered staging profile..."
docker run --rm \
    --env NGINX_PROFILE=staging \
    --env FASTIFY_UPSTREAM=host.docker.internal:8080 \
    --env NGINX_HTTP_PORT=8081 \
    --env NGINX_SERVER_NAME=localhost \
    --env 'NGINX_READINESS_ALLOWLIST_LINES=127.0.0.1/32 1;' \
    --env NGINX_VALIDATE_ONLY=1 \
    --add-host host.docker.internal:host-gateway \
    "$image_name"

echo "Checking the rendered production profile with an ephemeral test certificate..."
openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$temp_dir/test.key" \
    -out "$temp_dir/test.crt" \
    -subj '/CN=localhost.test' \
    -days 1 >/dev/null 2>&1
docker run --rm \
    --env NGINX_PROFILE=production \
    --env FASTIFY_UPSTREAM=host.docker.internal:8080 \
    --env NGINX_SERVER_NAME=localhost.test \
    --env 'NGINX_READINESS_ALLOWLIST_LINES=127.0.0.1/32 1;' \
    --env NGINX_TLS_CERTIFICATE=/tmp/c1rcle-test.crt \
    --env NGINX_TLS_CERTIFICATE_KEY=/tmp/c1rcle-test.key \
    --env NGINX_VALIDATE_ONLY=1 \
    --volume "$temp_dir/test.crt:/tmp/c1rcle-test.crt:ro" \
    --volume "$temp_dir/test.key:/tmp/c1rcle-test.key:ro" \
    --add-host host.docker.internal:host-gateway \
    "$image_name"

echo "Starting Nginx in front of Fastify..."
docker run --detach --rm \
    --name "$container_name" \
    --add-host host.docker.internal:host-gateway \
    --publish 18081:8081 \
    --env NGINX_PROFILE=staging \
    --env FASTIFY_UPSTREAM=host.docker.internal:8080 \
    --env NGINX_HTTP_PORT=8081 \
    --env NGINX_SERVER_NAME=localhost \
    --env 'NGINX_READINESS_ALLOWLIST_LINES=127.0.0.1/32 1;' \
    "$image_name" >/dev/null

nginx_ready=0
for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:18081/api/v2/internal/health >/dev/null 2>&1; then
        nginx_ready=1
        break
    fi
    sleep 1
done

if [ "$nginx_ready" != "1" ]; then
    echo "Nginx did not become healthy. Container logs:" >&2
    docker logs "$container_name" >&2
    exit 1
fi

echo "Checking health proxying and request-id response..."
health_response=$(curl -fsS -D "$temp_dir/health.headers" http://127.0.0.1:18081/api/v2/internal/health)
request_id=$(sed -n 's/^X-Request-Id: *//Ip' "$temp_dir/health.headers" | tr -d '\r' | head -n 1)

if [ -z "$request_id" ]; then
    echo "Expected Nginx to return X-Request-Id" >&2
    exit 1
fi

case "$health_response" in
    *"healthy"*|*"ok"*|*"status"*) : ;;
    *)
        echo "Unexpected health response: $health_response" >&2
        exit 1
        ;;
esac

echo "Checking request-id correlation through Fastify..."
error_headers="$temp_dir/error.headers"
error_body=$(curl -sS -D "$error_headers" -H 'X-Request-Id: client-supplied-id-must-be-replaced' \
    http://127.0.0.1:18081/api/v2/route-that-does-not-exist)
edge_request_id=$(sed -n 's/^X-Request-Id: *//Ip' "$error_headers" | tr -d '\r' | head -n 1)

if [ -z "$edge_request_id" ] || [ "$edge_request_id" = "client-supplied-id-must-be-replaced" ]; then
    echo "Expected Nginx to issue a fresh request id" >&2
    exit 1
fi

case "$error_body" in
    *"$edge_request_id"*) : ;;
    *)
        echo "Fastify response did not preserve the edge request id: $error_body" >&2
        exit 1
        ;;
esac

echo "Checking edge body-size protection..."
head -c 1100000 /dev/zero >"$temp_dir/oversized-body"
oversized_status=$(curl -sS -o "$temp_dir/oversized-response" -w '%{http_code}' \
    -X POST --data-binary "@$temp_dir/oversized-body" \
    http://127.0.0.1:18081/api/v2/edge-validation)

if [ "$oversized_status" != "413" ]; then
    echo "Expected 413 for an oversized request, received $oversized_status" >&2
    exit 1
fi

echo "Checking edge rate protection..."
rate_limited=0
for _ in $(seq 1 40); do
    status=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18081/api/v2/route-that-does-not-exist)
    if [ "$status" = "429" ]; then
        rate_limited=1
        break
    fi
done

if [ "$rate_limited" != "1" ]; then
    echo "Expected the edge rate limiter to return 429" >&2
    exit 1
fi

echo "Checking upstream-unavailable JSON behavior..."
kill "$api_pid"
wait "$api_pid" >/dev/null 2>&1
api_pid=""

upstream_status=$(curl -sS -o "$temp_dir/upstream-response" -w '%{http_code}' \
    http://127.0.0.1:18081/api/v2/internal/health)

case "$upstream_status" in
    502|503|504) : ;;
    *)
        echo "Expected an upstream failure status, received $upstream_status" >&2
        exit 1
        ;;
esac

case "$(sed 's/[[:space:]]//g' "$temp_dir/upstream-response")" in
    *edge_upstream_unavailable*|*edge_upstream_timeout*) : ;;
    *)
        echo "Expected a structured upstream failure response" >&2
        cat "$temp_dir/upstream-response" >&2
        exit 1
        ;;
esac

echo "Nginx local validation passed."
