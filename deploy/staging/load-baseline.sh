#!/bin/sh

set -eu

if [ "${STAGING_LOAD_CONFIRM:-}" != "YES" ]; then
    echo "Set STAGING_LOAD_CONFIRM=YES to run the staging load baseline" >&2
    exit 64
fi

if [ -z "${STAGING_BASE_URL:-}" ]; then
    echo "STAGING_BASE_URL is required" >&2
    exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node_script="$script_dir/load-baseline.mjs"
baselines_dir="$script_dir/baselines"

run_scenario() {
    name="$1"
    shift
    echo "--- $name"
    env "$@" node "$node_script"
}

run_scenario "health" \
    STAGING_LOAD_PATH=/api/v2/internal/health \
    STAGING_LOAD_METHOD=GET \
    STAGING_LOAD_REQUESTS="${STAGING_LOAD_HEALTH_REQUESTS:-100}" \
    STAGING_LOAD_CONCURRENCY="${STAGING_LOAD_HEALTH_CONCURRENCY:-4}"

if [ -n "${STAGING_ACCESS_TOKEN:-}" ] && [ -n "${STAGING_LOAD_AUTH_GET_PATH:-}" ]; then
    run_scenario "authenticated GET" \
        STAGING_LOAD_PATH="$STAGING_LOAD_AUTH_GET_PATH" \
        STAGING_LOAD_METHOD=GET \
        STAGING_LOAD_REQUESTS="${STAGING_LOAD_AUTH_REQUESTS:-100}" \
        STAGING_LOAD_CONCURRENCY="${STAGING_LOAD_AUTH_CONCURRENCY:-4}" \
        STAGING_ACCESS_TOKEN="$STAGING_ACCESS_TOKEN"
else
    echo "SKIP authenticated GET: token or STAGING_LOAD_AUTH_GET_PATH not provided"
fi

if [ -n "${STAGING_LOAD_GET_PATH:-}" ]; then
    run_scenario "representative GET" \
        STAGING_LOAD_PATH="$STAGING_LOAD_GET_PATH" \
        STAGING_LOAD_METHOD=GET \
        STAGING_LOAD_REQUESTS="${STAGING_LOAD_GET_REQUESTS:-100}" \
        STAGING_LOAD_CONCURRENCY="${STAGING_LOAD_GET_CONCURRENCY:-4}"
else
    echo "SKIP representative GET: STAGING_LOAD_GET_PATH not provided"
fi

# Mutation bodies: the wrapper (not the Node runtime) reads the fixture, so
# load-baseline.mjs has no file-access surface. The fixture must be a plain
# filename inside deploy/staging/baselines/ (no traversal), a regular file,
# and 256 KiB or smaller; its contents are handed to Node as STAGING_LOAD_BODY.
if [ -n "${STAGING_LOAD_MUTATION_PATH:-}" ] && [ -n "${STAGING_LOAD_MUTATION_BODY_FILE:-}" ]; then
    fixture_name="$STAGING_LOAD_MUTATION_BODY_FILE"
    case "$fixture_name" in
        */*|*".."*)
            echo "STAGING_LOAD_MUTATION_BODY_FILE must be a plain filename in deploy/staging/baselines/" >&2
            exit 64
            ;;
    esac
    fixture_path="$baselines_dir/$fixture_name"
    if [ ! -f "$fixture_path" ]; then
        echo "STAGING_LOAD_MUTATION_BODY_FILE is not a regular file in deploy/staging/baselines/" >&2
        exit 64
    fi
    fixture_bytes=$(wc -c <"$fixture_path")
    if [ "$fixture_bytes" -gt 262144 ]; then
        echo "STAGING_LOAD_MUTATION_BODY_FILE exceeds 262144 bytes" >&2
        exit 64
    fi
    mutation_body=$(cat "$fixture_path")
    run_scenario "safe mutation" \
        STAGING_LOAD_PATH="$STAGING_LOAD_MUTATION_PATH" \
        STAGING_LOAD_METHOD="${STAGING_LOAD_MUTATION_METHOD:-PATCH}" \
        STAGING_LOAD_BODY="$mutation_body" \
        STAGING_LOAD_ALLOW_MUTATION=YES \
        STAGING_LOAD_IDEMPOTENCY_KEY="${STAGING_LOAD_IDEMPOTENCY_KEY:-}" \
        STAGING_LOAD_REQUESTS="${STAGING_LOAD_MUTATION_REQUESTS:-10}" \
        STAGING_LOAD_CONCURRENCY="${STAGING_LOAD_MUTATION_CONCURRENCY:-2}" \
        STAGING_ACCESS_TOKEN="${STAGING_ACCESS_TOKEN:-}"
else
    echo "SKIP safe mutation: path/body fixture not provided"
fi

run_scenario "burst traffic" \
    STAGING_LOAD_PATH=/api/v2/internal/health \
    STAGING_LOAD_METHOD=GET \
    STAGING_LOAD_REQUESTS="${STAGING_LOAD_BURST_REQUESTS:-100}" \
    STAGING_LOAD_CONCURRENCY="${STAGING_LOAD_BURST_CONCURRENCY:-20}"

run_scenario "rate-limit behavior" \
    STAGING_LOAD_PATH=/api/v2/load-validation-route \
    STAGING_LOAD_METHOD=GET \
    STAGING_LOAD_REQUESTS="${STAGING_LOAD_RATE_LIMIT_REQUESTS:-40}" \
    STAGING_LOAD_CONCURRENCY="${STAGING_LOAD_RATE_LIMIT_CONCURRENCY:-40}" \
    STAGING_LOAD_EXPECT_429=YES

run_scenario "keepalive" \
    STAGING_LOAD_PATH=/api/v2/internal/health \
    STAGING_LOAD_METHOD=GET \
    STAGING_LOAD_REQUESTS="${STAGING_LOAD_KEEPALIVE_REQUESTS:-50}" \
    STAGING_LOAD_CONCURRENCY=1

echo "Load baseline complete. Preserve the JSON reports with the deployment record; this is not production capacity certification."
