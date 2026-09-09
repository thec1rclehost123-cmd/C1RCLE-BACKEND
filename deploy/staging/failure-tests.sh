#!/bin/sh

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/c1rcle-staging-failure.XXXXXX")
image_name="${STAGING_NGINX_IMAGE:-c1rcle-nginx:staging-preflight}"
failures=0
skips=0

cleanup() {
    set +e
    rm -rf "$temp_dir"
}

trap cleanup EXIT

require_command() {
    command_name="$1"
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Required command not found: $command_name" >&2
        exit 127
    fi
}

require_command curl
require_command docker

skip_check() {
    skips=$((skips + 1))
    echo "SKIP $1"
}

fail_check() {
    failures=$((failures + 1))
    echo "FAIL $1"
}

is_status() {
    actual="$1"
    expected="$2"
    case ",$expected," in
        *,"$actual",*) return 0 ;;
        *) return 1 ;;
    esac
}

check_url_status() {
    label="$1"
    url="$2"
    expected="$3"
    timeout="$4"
    actual=$(curl -sS --max-time "$timeout" -o /dev/null -w '%{http_code}' "$url" || true)
    if is_status "$actual" "$expected"; then
        echo "PASS $label ($actual)"
    else
        fail_check "$label: expected $expected, received $actual"
    fi
}

if ! docker info >/dev/null 2>&1; then
    echo "Docker daemon is required for the isolated invalid-config test" >&2
    exit 1
fi

if ! docker image inspect "$image_name" >/dev/null 2>&1; then
    (
        cd "$repo_root"
        docker build --file deploy/docker/Dockerfile.nginx --tag "$image_name" .
    )
fi

echo "1. invalid Nginx config rejection"
printf '%s\n' 'this is not valid nginx syntax;' >"$temp_dir/invalid.conf"
if docker run --rm --entrypoint nginx \
    --volume "$temp_dir/invalid.conf:/etc/nginx/conf.d/c1rcle-api.conf:ro" \
    "$image_name" -t -c /etc/nginx/nginx.conf >/dev/null 2>&1; then
    fail_check "invalid Nginx config was accepted"
else
    echo "PASS invalid Nginx config rejected"
fi

if [ -z "${STAGING_BASE_URL:-}" ]; then
    echo "READY FOR STAGING: local invalid-config guard passed; remote failure probes require STAGING_BASE_URL and controlled URLs."
else
    echo "2. Fastify stopped"
    if [ -n "${STAGING_STOPPED_UPSTREAM_URL:-}" ] && [ "${STAGING_FAILURE_CONFIRM:-}" = "YES" ]; then
        check_url_status "Fastify stopped" "$STAGING_STOPPED_UPSTREAM_URL" "502,503,504" 10
    else
        skip_check "STAGING_STOPPED_UPSTREAM_URL and STAGING_FAILURE_CONFIRM=YES not provided"
    fi

    echo "3. Fastify restarting"
    if [ -n "${STAGING_RESTARTING_UPSTREAM_URL:-}" ] && [ "${STAGING_FAILURE_CONFIRM:-}" = "YES" ]; then
        check_url_status "Fastify restarting" "$STAGING_RESTARTING_UPSTREAM_URL" "502,503,504" 10
    else
        skip_check "STAGING_RESTARTING_UPSTREAM_URL and confirmation not provided"
    fi

    echo "4. readiness false"
    if [ -n "${STAGING_READINESS_FALSE_URL:-}" ] && [ "${STAGING_FAILURE_CONFIRM:-}" = "YES" ]; then
        check_url_status "readiness false" "$STAGING_READINESS_FALSE_URL" "503" 10
    else
        skip_check "STAGING_READINESS_FALSE_URL and confirmation not provided"
    fi

    echo "5. slow upstream/timeout"
    if [ -n "${STAGING_SLOW_UPSTREAM_URL:-}" ] && [ "${STAGING_FAILURE_CONFIRM:-}" = "YES" ]; then
        check_url_status "slow upstream" "$STAGING_SLOW_UPSTREAM_URL" "502,503,504" 40
    else
        skip_check "STAGING_SLOW_UPSTREAM_URL and confirmation not provided"
    fi

    echo "6. Nginx reload"
    if [ -n "${STAGING_NGINX_RELOAD_URL:-}" ] && [ "${STAGING_FAILURE_CONFIRM:-}" = "YES" ]; then
        check_url_status "health after Nginx reload" "$STAGING_NGINX_RELOAD_URL" "200" 10
    else
        skip_check "STAGING_NGINX_RELOAD_URL and confirmation not provided"
    fi

    echo "7. DNS failure"
    if [ -n "${STAGING_DNS_FAILURE_URL:-}" ] && [ "${STAGING_FAILURE_CONFIRM:-}" = "YES" ]; then
        check_url_status "controlled DNS failure" "$STAGING_DNS_FAILURE_URL" "000" 10
    else
        skip_check "STAGING_DNS_FAILURE_URL and confirmation not provided"
    fi

    echo "8. TLS failure"
    if [ -n "${STAGING_TLS_FAILURE_URL:-}" ] && [ "${STAGING_FAILURE_CONFIRM:-}" = "YES" ]; then
        check_url_status "controlled TLS failure" "$STAGING_TLS_FAILURE_URL" "000" 10
    else
        skip_check "STAGING_TLS_FAILURE_URL and confirmation not provided"
    fi

    echo "9. active request during Fastify shutdown"
    if [ -n "${STAGING_SHUTDOWN_REQUEST_URL:-}" ] && [ "${STAGING_FAILURE_CONFIRM:-}" = "YES" ]; then
        check_url_status "request during shutdown" "$STAGING_SHUTDOWN_REQUEST_URL" "200,502,503,504" 40
    else
        skip_check "STAGING_SHUTDOWN_REQUEST_URL and confirmation not provided"
    fi
fi

echo "Expected failure matrix: stopped/restarting/slow upstreams return bounded 502/503/504; readiness false returns 503; invalid config is rejected; reload preserves health; DNS/TLS failures fail closed; in-flight shutdown requests either complete or receive a bounded upstream error."
if [ "$failures" -gt 0 ]; then
    echo "Staging failure tests failed: $failures failure(s), $skips skipped." >&2
    exit 1
fi
echo "Staging failure checks passed: $skips external failure probe(s) skipped."
