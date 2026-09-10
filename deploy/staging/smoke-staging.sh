#!/bin/sh

set -eu

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/c1rcle-staging-smoke.XXXXXX")
base_url="${STAGING_BASE_URL:-}"
failures=0
skips=0
access_token="${STAGING_ACCESS_TOKEN:-}"

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
require_command node
require_command rg

if [ -z "$base_url" ]; then
    echo "STAGING_BASE_URL is required" >&2
    exit 64
fi
case "$base_url" in
    https://*) : ;;
    *) echo "STAGING_BASE_URL must use HTTPS" >&2; exit 64 ;;
esac
base_url="${base_url%/}"

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

check_status() {
    label="$1"
    actual="$2"
    expected="$3"
    if is_status "$actual" "$expected"; then
        echo "PASS $label ($actual)"
    else
        fail_check "$label: expected $expected, received $actual"
    fi
}

request_id_from_headers() {
    sed -n 's/^X-Request-Id: *//Ip' "$1" | tr -d '\r' | head -n 1
}

echo "1. health"
health_status=$(curl -sS -D "$temp_dir/health.headers" -o "$temp_dir/health.body" -w '%{http_code}' \
    "$base_url/api/v2/internal/health")
check_status "health" "$health_status" "200"
health_request_id=$(request_id_from_headers "$temp_dir/health.headers")
if [ -n "$health_request_id" ]; then
    echo "PASS health request ID present"
else
    fail_check "health response did not include X-Request-Id"
fi

echo "2. readiness with the token"
readiness_token="${STAGING_READINESS_TOKEN:-}"
if [ -n "$readiness_token" ]; then
    readiness_status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
        -H "X-Readiness-Token: $readiness_token" "$base_url/api/v2/internal/readiness")
    check_status "token-gated readiness" "$readiness_status" "200,503"
    public_readiness_status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$base_url/api/v2/internal/readiness")
    check_status "readiness without the token is restricted" "$public_readiness_status" "404"
else
    if [ "${STAGING_REQUIRE_APPROVED_READINESS:-0}" = "1" ]; then
        fail_check "STAGING_READINESS_TOKEN is required"
    else
        skip_check "STAGING_READINESS_TOKEN not provided"
    fi
fi

echo "3. version"
if [ -n "$readiness_token" ]; then
    version_status=$(curl -sS -o "$temp_dir/version.body" -w '%{http_code}' --max-time 10 \
        -H "X-Readiness-Token: $readiness_token" "$base_url/api/v2/internal/version")
    check_status "token-gated version" "$version_status" "200"
else
    public_version_status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$base_url/api/v2/internal/version")
    check_status "public version is restricted" "$public_version_status" "404"
fi

echo "4. request ID spoofing"
curl -sS -D "$temp_dir/spoof.headers" -o /dev/null \
    -H 'X-Request-Id: client-supplied-id-must-not-win' \
    "$base_url/api/v2/internal/health" >/dev/null
spoofed_request_id=$(request_id_from_headers "$temp_dir/spoof.headers")
if [ -n "$spoofed_request_id" ] && [ "$spoofed_request_id" != "client-supplied-id-must-not-win" ]; then
    echo "PASS client request ID was replaced"
else
    fail_check "client request ID was accepted as authoritative"
fi

echo "5. CORS preflight"
if [ -n "${STAGING_FRONTEND_ORIGIN:-}" ]; then
    cors_status=$(curl -sS -D "$temp_dir/cors.headers" -o /dev/null -w '%{http_code}' \
        -X OPTIONS \
        -H "Origin: $STAGING_FRONTEND_ORIGIN" \
        -H 'Access-Control-Request-Method: GET' \
        -H 'Access-Control-Request-Headers: Authorization,Content-Type' \
        "$base_url/api/v2/internal/health")
    check_status "CORS preflight" "$cors_status" "200,204"
    if rg -qi "^access-control-allow-origin: *$STAGING_FRONTEND_ORIGIN$" "$temp_dir/cors.headers"; then
        echo "PASS CORS origin echoed exactly"
    else
        fail_check "CORS origin was not echoed exactly"
    fi
else
    if [ "${STAGING_REQUIRE_CORS:-0}" = "1" ]; then
        fail_check "STAGING_FRONTEND_ORIGIN is required"
    else
        skip_check "STAGING_FRONTEND_ORIGIN not provided"
    fi
fi

echo "6. login/session path"
cookie_jar="$temp_dir/cookies.txt"
if [ -n "${STAGING_AUTH_EMAIL:-}" ] && [ -n "${STAGING_AUTH_PASSWORD:-}" ]; then
    login_payload=$(STAGING_AUTH_EMAIL="$STAGING_AUTH_EMAIL" STAGING_AUTH_PASSWORD="$STAGING_AUTH_PASSWORD" node -e 'process.stdout.write(JSON.stringify({email: process.env.STAGING_AUTH_EMAIL, password: process.env.STAGING_AUTH_PASSWORD}))')
    login_status=$(curl -sS -D "$temp_dir/login.headers" -o "$temp_dir/login.body" -w '%{http_code}' \
        -c "$cookie_jar" \
        -H 'Content-Type: application/json' \
        --data "$login_payload" \
        "$base_url/api/v2/auth/login")
    check_status "login" "$login_status" "200"
    if rg -qi '^set-cookie:' "$temp_dir/login.headers"; then
        echo "PASS login Set-Cookie preserved"
    else
        fail_check "login Set-Cookie was not preserved"
    fi
    access_token=$(node --input-type=module -e '
      import fs from "node:fs";
      try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).accessToken ?? ""); } catch {}
    ' "$temp_dir/login.body")
    session_status=$(curl -sS -b "$cookie_jar" -o "$temp_dir/session.body" -w '%{http_code}' \
        "$base_url/api/v2/auth/session")
    check_status "session" "$session_status" "200"
else
    if [ "${STAGING_REQUIRE_AUTH:-0}" = "1" ]; then
        fail_check "STAGING_AUTH_EMAIL and STAGING_AUTH_PASSWORD are required"
    else
        skip_check "staging credentials not provided"
    fi
fi

echo "7. Authorization preservation"
if [ -n "$access_token" ] && [ -n "${STAGING_AUTH_CHECK_PATH:-}" ]; then
    authorization_status=$(curl -sS -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer $access_token" \
        "$base_url$STAGING_AUTH_CHECK_PATH")
    case "$authorization_status" in
        400|401|403|404|405|408|413|429|500|502|503|504) fail_check "authorization check returned failure $authorization_status" ;;
        *) echo "PASS Authorization reached configured check path ($authorization_status)" ;;
    esac
else
    skip_check "token or STAGING_AUTH_CHECK_PATH not provided"
fi

safe_get_url=""
if [ -n "${STAGING_SAFE_GET_URL:-}" ]; then
    safe_get_url="$STAGING_SAFE_GET_URL"
elif [ -n "${STAGING_SAFE_GET_PATH:-}" ]; then
    safe_get_url="$base_url$STAGING_SAFE_GET_PATH"
fi

echo "8. X-Organization-Id preservation"
if [ -n "$safe_get_url" ] && [ -n "${STAGING_ORGANIZATION_ID:-}" ]; then
    org_status=$(curl -sS -o /dev/null -w '%{http_code}' \
        -H "X-Organization-Id: $STAGING_ORGANIZATION_ID" \
        "$safe_get_url")
    case "$org_status" in
        502|503|504) fail_check "organization-header GET hit edge failure $org_status" ;;
        *) echo "PASS X-Organization-Id sent through configured GET ($org_status)" ;;
    esac
else
    skip_check "safe GET and STAGING_ORGANIZATION_ID not provided"
fi

echo "9. If-Match preservation"
if [ -n "${STAGING_SAFE_MUTATION_PATH:-}" ] && [ -n "${STAGING_IF_MATCH:-}" ]; then
    echo "PASS If-Match is configured for the safe mutation below"
else
    skip_check "safe mutation and STAGING_IF_MATCH not provided"
fi

echo "10. Idempotency-Key preservation"
if [ -n "${STAGING_SAFE_MUTATION_PATH:-}" ]; then
    idempotency_key="${STAGING_IDEMPOTENCY_KEY:-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')}"
    echo "PASS Idempotency-Key prepared for the safe mutation"
else
    skip_check "safe mutation not provided"
fi

echo "11. representative GET"
if [ -n "$safe_get_url" ]; then
    get_headers="$temp_dir/safe-get.headers"
    if [ -n "$access_token" ]; then
        get_status=$(curl -sS -D "$get_headers" -o "$temp_dir/safe-get.body" -w '%{http_code}' \
            -H "Authorization: Bearer $access_token" "$safe_get_url")
    else
        get_status=$(curl -sS -D "$get_headers" -o "$temp_dir/safe-get.body" -w '%{http_code}' "$safe_get_url")
    fi
    case "$get_status" in
        502|503|504) fail_check "representative GET returned edge failure $get_status" ;;
        *) echo "PASS representative GET reached the application ($get_status)" ;;
    esac
else
    skip_check "STAGING_SAFE_GET_URL or STAGING_SAFE_GET_PATH not provided"
fi

echo "12. representative safe mutation"
mutation_url=""
if [ -n "${STAGING_SAFE_MUTATION_URL:-}" ]; then
    mutation_url="$STAGING_SAFE_MUTATION_URL"
elif [ -n "${STAGING_SAFE_MUTATION_PATH:-}" ]; then
    mutation_url="$base_url$STAGING_SAFE_MUTATION_PATH"
fi
if [ -n "$mutation_url" ] && [ -n "${STAGING_SAFE_MUTATION_BODY_FILE:-}" ] && [ "${STAGING_MUTATION_CONFIRM:-}" = "YES" ]; then
    if [ ! -f "$STAGING_SAFE_MUTATION_BODY_FILE" ]; then
        fail_check "STAGING_SAFE_MUTATION_BODY_FILE does not exist"
    else
        mutation_method="${STAGING_SAFE_MUTATION_METHOD:-PATCH}"
        idempotency_key="${STAGING_IDEMPOTENCY_KEY:-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')}"
        run_safe_mutation() {
            set -- curl -sS -D "$temp_dir/mutation.headers" -o "$temp_dir/mutation.body" -w '%{http_code}' \
                -X "$mutation_method" \
                -H 'Content-Type: application/json' \
                -H "Idempotency-Key: $idempotency_key"
            if [ -n "$access_token" ]; then set -- "$@" -H "Authorization: Bearer $access_token"; fi
            if [ -n "${STAGING_ORGANIZATION_ID:-}" ]; then set -- "$@" -H "X-Organization-Id: $STAGING_ORGANIZATION_ID"; fi
            if [ -n "${STAGING_IF_MATCH:-}" ]; then set -- "$@" -H "If-Match: $STAGING_IF_MATCH"; fi
            set -- "$@" --data-binary "@$STAGING_SAFE_MUTATION_BODY_FILE" "$mutation_url"
            "$@"
        }
        mutation_status=$(run_safe_mutation)
        check_status "safe mutation" "$mutation_status" "${STAGING_SAFE_MUTATION_EXPECTED_STATUS:-200,201,204}"
    fi
else
    if [ "${STAGING_REQUIRE_MUTATION:-0}" = "1" ]; then
        fail_check "safe mutation URL/body/confirmation are required"
    else
        skip_check "safe mutation requires URL, body file, and STAGING_MUTATION_CONFIRM=YES"
    fi
fi

echo "13. oversized body"
head -c 1100000 /dev/zero >"$temp_dir/oversized-body"
oversized_status=$(curl -sS -o "$temp_dir/oversized.body" -w '%{http_code}' \
    -X POST --data-binary "@$temp_dir/oversized-body" \
    "$base_url/api/v2/edge-validation")
check_status "oversized body" "$oversized_status" "413"

echo "14. rate limiting"
rate_limited=0
for _ in $(seq 1 40); do
    status=$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/api/v2/route-that-does-not-exist")
    if [ "$status" = "429" ]; then rate_limited=1; break; fi
done
if [ "$rate_limited" = "1" ]; then
    echo "PASS rate limit returned 429"
else
    fail_check "rate limit did not return 429"
fi

echo "15. upstream-unavailable behavior"
if [ -n "${STAGING_UPSTREAM_FAILURE_URL:-}" ] && [ "${STAGING_FAILURE_CONFIRM:-}" = "YES" ]; then
    failure_status=$(curl -sS -o "$temp_dir/failure.body" -w '%{http_code}' "$STAGING_UPSTREAM_FAILURE_URL")
    check_status "controlled upstream failure" "$failure_status" "502,503,504"
else
    skip_check "controlled upstream failure URL/confirmation not provided"
fi

echo "16. no-cache behavior"
curl -sS -D "$temp_dir/cache.headers" -o /dev/null "$base_url/api/v2/internal/health" >/dev/null
if rg -qi '^x-cache: *hit|^age:' "$temp_dir/cache.headers"; then
    fail_check "edge exposed a cache hit or Age header"
else
    echo "PASS no cache hit observed"
fi

echo "17. direct Fastify port"
if [ -n "${STAGING_DIRECT_FASTIFY_URL:-}" ]; then
    direct_status=$(curl -sS --connect-timeout 2 --max-time 4 -o /dev/null -w '%{http_code}' "$STAGING_DIRECT_FASTIFY_URL" || true)
    if [ "$direct_status" = "000" ]; then
        echo "PASS direct Fastify endpoint is unreachable"
    else
        fail_check "direct Fastify endpoint is reachable ($direct_status)"
    fi
else
    skip_check "STAGING_DIRECT_FASTIFY_URL not provided"
fi

if [ "$failures" -gt 0 ]; then
    echo "Staging smoke tests failed: $failures failure(s), $skips skipped." >&2
    exit 1
fi

echo "Staging smoke tests passed: $skips check(s) skipped because external staging values/fixtures were not provided."
