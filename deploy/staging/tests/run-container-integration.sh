#!/bin/sh

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
backend_image="${C1RCLE_BACKEND_IMAGE:-c1rcle-api-gateway:container-integration}"
nginx_image="${C1RCLE_NGINX_IMAGE:-c1rcle-nginx:container-integration}"
host_port="${STAGING_INTEGRATION_HOST_PORT:-18082}"
auth_mode="${STAGING_INTEGRATION_AUTH_MODE:-memory}"
network_name="c1rcle-integration-network-$$"
api_name="c1rcle-integration-fastify-$$"
nginx_name="c1rcle-integration-nginx-$$"
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/c1rcle-container-integration.XXXXXX")
api_started=0
nginx_started=0
network_created=0

cleanup() {
    set +e
    if [ "$nginx_started" = "1" ]; then docker rm -f "$nginx_name" >/dev/null 2>&1; fi
    if [ "$api_started" = "1" ]; then docker rm -f "$api_name" >/dev/null 2>&1; fi
    if [ "$network_created" = "1" ]; then docker network rm "$network_name" >/dev/null 2>&1; fi
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

require_value() {
    variable_name="$1"
    eval "variable_value=\${$variable_name:-}"
    if [ -z "$variable_value" ]; then
        echo "Required value is missing: $variable_name" >&2
        exit 64
    fi
}

require_command docker
require_command curl
require_command node
require_command pnpm
require_command rg

case "$host_port" in
    ''|*[!0-9]*) echo "STAGING_INTEGRATION_HOST_PORT must be numeric" >&2; exit 64 ;;
esac

case "$auth_mode" in
    memory|firestore) : ;;
    *) echo "STAGING_INTEGRATION_AUTH_MODE must be memory or firestore" >&2; exit 64 ;;
esac

if docker container inspect "$api_name" >/dev/null 2>&1 || docker container inspect "$nginx_name" >/dev/null 2>&1; then
    echo "An integration container name is already in use; choose another process or retry." >&2
    exit 1
fi
if docker network inspect "$network_name" >/dev/null 2>&1; then
    echo "An integration network name is already in use; retry." >&2
    exit 1
fi

echo "1. Building the deployable Fastify image..."
(
    cd "$repo_root"
    docker build --file Dockerfile --tag "$backend_image" .
)

echo "2. Building the Nginx image..."
(
    cd "$repo_root"
    docker build --file deploy/docker/Dockerfile.nginx --tag "$nginx_image" .
)

echo "3. Creating the private Docker network..."
docker network create "$network_name" >/dev/null
network_created=1

integration_url="http://localhost:$host_port"
integration_origin="$integration_url"
trusted_proxy_cidrs="172.16.0.0/12"

echo "4. Starting Fastify privately on the Docker network..."
if [ "$auth_mode" = "firestore" ]; then
    require_value STAGING_INTEGRATION_AUTH_CONFIRM
    if [ "$STAGING_INTEGRATION_AUTH_CONFIRM" != "YES" ]; then
        echo "Set STAGING_INTEGRATION_AUTH_CONFIRM=YES before running a Firestore auth flow." >&2
        exit 64
    fi
    for value_name in FIRESTORE_PROJECT_ID FIREBASE_STORAGE_BUCKET FIREBASE_CLIENT_EMAIL FIREBASE_PRIVATE_KEY BETTER_AUTH_SECRET; do
        require_value "$value_name"
    done
    api_id=$(docker run --detach \
        --name "$api_name" \
        --network "$network_name" \
        --network-alias fastify \
        --env NODE_ENV=test \
        --env STORAGE_DRIVER=firestore \
        --env HOST=0.0.0.0 \
        --env PORT=8080 \
        --env LOG_LEVEL=info \
        --env TRUSTED_PROXY_CIDRS="$trusted_proxy_cidrs" \
        --env PUBLIC_API_URL="$integration_url" \
        --env ALLOWED_ORIGINS="$integration_origin" \
        --env BETTER_AUTH_TRUSTED_ORIGINS="$integration_origin" \
        --env BETTER_AUTH_URL="$integration_url" \
        --env FIRESTORE_PROJECT_ID="$FIRESTORE_PROJECT_ID" \
        --env FIREBASE_STORAGE_BUCKET="$FIREBASE_STORAGE_BUCKET" \
        --env FIREBASE_CLIENT_EMAIL="$FIREBASE_CLIENT_EMAIL" \
        --env FIREBASE_PRIVATE_KEY="$FIREBASE_PRIVATE_KEY" \
        --env BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
        --env REDIS_URL="${REDIS_URL:-redis://redis:6379}" \
        --env APP_VERSION=0.1.0-integration \
        --env BUILD_SHA=container-integration \
        "$backend_image")
else
    api_id=$(docker run --detach \
        --name "$api_name" \
        --network "$network_name" \
        --network-alias fastify \
        --env NODE_ENV=test \
        --env STORAGE_DRIVER=memory \
        --env HOST=0.0.0.0 \
        --env PORT=8080 \
        --env LOG_LEVEL=info \
        --env TRUSTED_PROXY_CIDRS="$trusted_proxy_cidrs" \
        --env PUBLIC_API_URL="$integration_url" \
        --env ALLOWED_ORIGINS="$integration_origin" \
        --env BETTER_AUTH_TRUSTED_ORIGINS="$integration_origin" \
        --env BETTER_AUTH_URL="$integration_url" \
        --env REDIS_URL="${REDIS_URL:-redis://redis:6379}" \
        --env APP_VERSION=0.1.0-integration \
        --env BUILD_SHA=container-integration \
        "$backend_image")
fi
api_started=1

echo "5. Verifying the backend image runtime contract..."
api_user=$(docker inspect --format '{{.Config.User}}' "$api_name")
api_workdir=$(docker inspect --format '{{.Config.WorkingDir}}' "$api_name")
api_command=$(docker inspect --format '{{json .Config.Cmd}}' "$api_name")
if [ "$api_user" != "app" ]; then
    echo "Expected the Fastify image to run as app, received: $api_user" >&2
    exit 1
fi
if [ "$api_workdir" != "/app/apps/api-gateway" ]; then
    echo "Unexpected Fastify working directory: $api_workdir" >&2
    exit 1
fi
case "$api_command" in
    *src/server.ts*) : ;;
    *) echo "Unexpected Fastify startup command: $api_command" >&2; exit 1 ;;
esac
docker exec "$api_name" test -f /app/apps/api-gateway/src/server.ts
docker exec "$api_name" test -f /app/packages/contracts/dist/index.js
docker exec "$api_name" test -f /app/packages/core/src/index.ts

api_port_binding=$(docker port "$api_name" 8080/tcp 2>/dev/null || true)
if [ -n "$api_port_binding" ]; then
    echo "Fastify port 8080 is publicly mapped: $api_port_binding" >&2
    exit 1
fi
echo "PASS Fastify has no host port mapping; only its Docker network alias is exposed."

echo "6. Validating Nginx against the Fastify service name..."
docker run --rm \
    --network "$network_name" \
    --env NGINX_PROFILE=staging \
    --env FASTIFY_UPSTREAM=fastify:8080 \
    --env NGINX_HTTP_PORT=8081 \
    --env NGINX_SERVER_NAME=localhost \
    --env 'NGINX_READINESS_ALLOWLIST_LINES=127.0.0.1/32 1;' \
    --env NGINX_VALIDATE_ONLY=1 \
    "$nginx_image"

echo "7. Starting Nginx as the only published service..."
nginx_id=$(docker run --detach \
    --name "$nginx_name" \
    --network "$network_name" \
    --network-alias edge \
    --publish "$host_port:8081" \
    --env NGINX_PROFILE=staging \
    --env FASTIFY_UPSTREAM=fastify:8080 \
    --env NGINX_HTTP_PORT=8081 \
    --env NGINX_SERVER_NAME=localhost \
    --env 'NGINX_READINESS_ALLOWLIST_LINES=127.0.0.1/32 1;' \
    "$nginx_image")
nginx_started=1

url_status() {
    request_url="$1"
    curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --max-time 10 "$request_url" || true
}

is_status() {
    actual="$1"
    expected="$2"
    case ",$expected," in
        *,"$actual",*) return 0 ;;
        *) return 1 ;;
    esac
}

assert_status() {
    label="$1"
    actual="$2"
    expected="$3"
    if is_status "$actual" "$expected"; then
        echo "PASS $label ($actual)"
    else
        echo "FAIL $label: expected $expected, received $actual" >&2
        exit 1
    fi
}

echo "8. Waiting for health through Nginx..."
health_status=000
for _ in $(seq 1 60); do
    health_status=$(url_status "$integration_url/api/v2/internal/health")
    if [ "$health_status" = "200" ]; then break; fi
    sleep 1
done
assert_status "health through Nginx" "$health_status" "200"

nginx_port_binding=$(docker port "$nginx_name" 8081/tcp || true)
if [ -z "$nginx_port_binding" ]; then
    echo "Nginx does not have the expected public mapping." >&2
    exit 1
fi
echo "PASS Nginx is the only published API boundary ($nginx_port_binding)."

echo "9. Version and readiness boundary..."
version_status=$(url_status "$integration_url/api/v2/internal/version")
assert_status "public version is restricted" "$version_status" "404"
public_readiness_status=$(url_status "$integration_url/api/v2/internal/readiness")
assert_status "public readiness is restricted" "$public_readiness_status" "404"

approved_version=$(docker exec "$nginx_name" wget --header='Host: localhost' -qO- http://127.0.0.1:8081/api/v2/internal/version)
case "$approved_version" in
    *container-integration*|*0.1.0-integration*) echo "PASS approved version carries build metadata" ;;
    *) echo "Unexpected approved version response: $approved_version" >&2; exit 1 ;;
esac
approved_readiness=$(docker exec "$nginx_name" wget --header='Host: localhost' -qO- http://127.0.0.1:8081/api/v2/internal/readiness)
case "$approved_readiness" in
    *'"ok":true'*) echo "PASS approved readiness through Nginx" ;;
    *) echo "Unexpected approved readiness response: $approved_readiness" >&2; exit 1 ;;
esac

echo "10. Request IDs, forwarded-header boundary, and Host handling..."
curl --silent --show-error --dump-header "$temp_dir/request-id.headers" --output /dev/null \
    --max-time 10 \
    -H 'X-Request-Id: attacker-controlled-id' \
    -H 'X-Forwarded-For: 198.51.100.10' \
    -H 'X-Forwarded-Proto: https' \
    -H 'X-Forwarded-Host: attacker.invalid' \
    -H 'X-Real-IP: 198.51.100.11' \
    "$integration_url/api/v2/internal/health"
request_id=$(sed -n 's/^X-Request-Id: *//Ip' "$temp_dir/request-id.headers" | tr -d '\r' | head -n 1)
if [ -n "$request_id" ] && [ "$request_id" != "attacker-controlled-id" ]; then
    echo "PASS Nginx generated a fresh request ID"
else
    echo "Nginx accepted the client request ID" >&2
    exit 1
fi

nginx_config=$(docker exec "$nginx_name" nginx -T 2>&1)
for required_line in \
    'proxy_set_header X-Forwarded-For $remote_addr;' \
    'proxy_set_header X-Forwarded-Proto $c1rcle_forwarded_proto;' \
    'proxy_set_header X-Forwarded-Host $host;' \
    'proxy_set_header X-Real-IP $remote_addr;'; do
    case "$nginx_config" in
        *"$required_line"*) : ;;
        *) echo "Loaded Nginx config is missing: $required_line" >&2; exit 1 ;;
    esac
done
echo "PASS loaded Nginx config overwrites forwarded identity headers"

host_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
    -H 'Host: attacker.invalid' "$integration_url/api/v2/internal/health" || true)
assert_status "unknown Host rejected" "$host_status" "000,400,421,444"

echo "11. Body limits and edge rate limiting..."
head -c 1100000 /dev/zero >"$temp_dir/oversized-body"
oversized_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --max-time 15 -X POST --data-binary "@$temp_dir/oversized-body" \
    "$integration_url/api/v2/edge-validation")
assert_status "oversized body rejected" "$oversized_status" "413"

rate_limited=0
for _ in $(seq 1 40); do
    status=$(url_status "$integration_url/api/v2/container-integration-route")
    if [ "$status" = "429" ]; then rate_limited=1; break; fi
done
if [ "$rate_limited" = "1" ]; then
    echo "PASS edge rate limiter returned 429"
else
    echo "Expected edge rate limiter to return 429" >&2
    exit 1
fi
# The rate probe intentionally uses the same client address as the business
# flow below. Allow the token bucket to refill before asserting API behavior.
sleep 2

organization_id=""
if [ "$auth_mode" = "memory" ]; then
    echo "12. Organization flow through Nginx (memory-driver topology)..."
    list_status=$(curl --silent --show-error --output "$temp_dir/org-list.body" --write-out '%{http_code}' \
        --max-time 10 "$integration_url/api/v2/organizations")
    assert_status "organization listing" "$list_status" "200"
    organization_slug="container-integration-$(date +%s)-$$"
    organization_body=$(node -e 'process.stdout.write(JSON.stringify({name:"Container Integration",slug:process.argv[1]}))' "$organization_slug")
    create_status=$(curl --silent --show-error --output "$temp_dir/org-create.body" --write-out '%{http_code}' \
        --max-time 10 -H 'Content-Type: application/json' \
        -H "Idempotency-Key: container-integration-$$_create" \
        --data "$organization_body" "$integration_url/api/v2/organizations")
    assert_status "organization creation without an org header" "$create_status" "201"
    organization_id=$(node --input-type=module -e '
      import fs from "node:fs";
      const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(body.id ?? body.organization?.id ?? "");
    ' "$temp_dir/org-create.body")
    if [ -z "$organization_id" ]; then
        echo "Could not extract the created organization ID" >&2
        exit 1
    fi
    matching_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --max-time 10 -H "X-Organization-Id: $organization_id" \
        "$integration_url/api/v2/organizations/$organization_id")
    assert_status "matching X-Organization-Id" "$matching_status" "200"
    invalid_scope_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --max-time 10 -H "X-Organization-Id: $organization_id" \
        "$integration_url/api/v2/organizations/container-integration-other")
    assert_status "invalid organization scope" "$invalid_scope_status" "403"
else
    echo "12. Auth/session-only actor flow through Nginx (Firestore mode)..."
    auth_email="${STAGING_INTEGRATION_AUTH_EMAIL:-}"
    if [ -z "$auth_email" ]; then
        auth_email="container-integration-$(date +%s)-$$@example.invalid"
    fi
    auth_password="${STAGING_INTEGRATION_AUTH_PASSWORD:-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("base64url"))')}"
    auth_payload=$(AUTH_EMAIL="$auth_email" AUTH_PASSWORD="$auth_password" AUTH_NAME='C1RCLE Container Integration' node -e \
        'process.stdout.write(JSON.stringify({email:process.env.AUTH_EMAIL,password:process.env.AUTH_PASSWORD,displayName:process.env.AUTH_NAME}))')
    signup_status=$(curl --silent --show-error --dump-header "$temp_dir/signup.headers" --output "$temp_dir/signup.body" \
        --cookie-jar "$temp_dir/auth.cookies" --write-out '%{http_code}' --max-time 20 \
        -H 'Content-Type: application/json' --data "$auth_payload" \
        "$integration_url/api/v2/auth/signup")
    assert_status "signup through Nginx" "$signup_status" "201"
    login_status=$(curl --silent --show-error --output "$temp_dir/login.body" --write-out '%{http_code}' --max-time 20 \
        --cookie-jar "$temp_dir/auth.cookies" --cookie "$temp_dir/auth.cookies" \
        -H 'Content-Type: application/json' --data "$auth_payload" \
        "$integration_url/api/v2/auth/login")
    assert_status "login after signup" "$login_status" "200"
    if ! rg -qi '^set-cookie:' "$temp_dir/signup.headers"; then
        echo "Signup did not preserve Set-Cookie through Nginx" >&2
        exit 1
    fi
    session_status=$(curl --silent --show-error --output "$temp_dir/session.body" --write-out '%{http_code}' \
        --cookie "$temp_dir/auth.cookies" --max-time 10 \
        "$integration_url/api/v2/auth/session")
    assert_status "session through Nginx" "$session_status" "200"
    list_status=$(curl --silent --show-error --output "$temp_dir/org-list.body" --write-out '%{http_code}' \
        --cookie "$temp_dir/auth.cookies" --max-time 10 "$integration_url/api/v2/organizations")
    assert_status "authenticated no-organization listing" "$list_status" "200"
    organization_slug="container-integration-$(date +%s)-$$"
    organization_body=$(node -e 'process.stdout.write(JSON.stringify({name:"Container Integration",slug:process.argv[1]}))' "$organization_slug")
    create_status=$(curl --silent --show-error --output "$temp_dir/org-create.body" --write-out '%{http_code}' \
        --cookie "$temp_dir/auth.cookies" --max-time 15 \
        -H 'Content-Type: application/json' \
        -H "Idempotency-Key: container-integration-$$_create" \
        --data "$organization_body" "$integration_url/api/v2/organizations")
    assert_status "authenticated organization creation without an org header" "$create_status" "201"
    organization_id=$(node --input-type=module -e '
      import fs from "node:fs";
      const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(body.id ?? body.organization?.id ?? "");
    ' "$temp_dir/org-create.body")
    if [ -z "$organization_id" ]; then
        echo "Could not extract the authenticated organization ID" >&2
        exit 1
    fi
    matching_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --cookie "$temp_dir/auth.cookies" --max-time 10 \
        -H "X-Organization-Id: $organization_id" \
        "$integration_url/api/v2/organizations/$organization_id")
    assert_status "authenticated matching X-Organization-Id" "$matching_status" "200"
    invalid_scope_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --cookie "$temp_dir/auth.cookies" --max-time 10 \
        -H "X-Organization-Id: $organization_id" \
        "$integration_url/api/v2/organizations/container-integration-other")
    assert_status "authenticated invalid organization scope" "$invalid_scope_status" "403"
fi

echo "13. Fastify shutdown, edge failure, and restart..."
active_request_status="$temp_dir/active-request.status"
(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 15 \
    "$integration_url/api/v2/internal/health" >"$active_request_status" 2>/dev/null || true) &
active_request_pid=$!
docker stop --time 10 "$api_name" >/dev/null
wait "$active_request_pid" >/dev/null 2>&1 || true
api_exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$api_name")
api_logs=$(docker logs "$api_name" 2>&1)
if [ "$api_exit_code" = "0" ] && printf '%s' "$api_logs" | rg -q 'shutdown complete'; then
    echo "PASS Fastify handled SIGTERM and exited cleanly"
else
    echo "Fastify shutdown proof failed (exit=$api_exit_code)" >&2
    printf '%s\n' "$api_logs" >&2
    exit 1
fi
stopped_status=$(url_status "$integration_url/api/v2/internal/health")
assert_status "bounded Nginx response while Fastify is stopped" "$stopped_status" "502,503,504"

docker start "$api_name" >/dev/null
restarted_status=000
for _ in $(seq 1 60); do
    restarted_status=$(url_status "$integration_url/api/v2/internal/health")
    if [ "$restarted_status" = "200" ]; then break; fi
    sleep 1
done
assert_status "health after Fastify container restart" "$restarted_status" "200"

if [ "$auth_mode" = "memory" ]; then
    echo "UNMEASURED auth/session-only actor over Nginx: memory mode intentionally does not register Better Auth routes; run with STAGING_INTEGRATION_AUTH_MODE=firestore and explicit credentials to execute that flow."
fi

echo "Container integration passed: Fastify is private, Nginx resolves fastify:8080, edge routing/limits/IDs/org flow work, and shutdown/restart behavior is bounded."
