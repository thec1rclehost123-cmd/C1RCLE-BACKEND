#!/bin/sh

set -eu

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/c1rcle-staging-security.XXXXXX")
base_url="${STAGING_BASE_URL:-}"
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
require_command head
require_command tr
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

echo "1. X-Request-Id spoofing"
curl -sS -D "$temp_dir/request-id.headers" -o /dev/null \
    -H 'X-Request-Id: attacker-controlled-request-id' \
    "$base_url/api/v2/internal/health" >/dev/null
request_id=$(sed -n 's/^X-Request-Id: *//Ip' "$temp_dir/request-id.headers" | tr -d '\r' | head -n 1)
if [ -n "$request_id" ] && [ "$request_id" != "attacker-controlled-request-id" ]; then
    echo "PASS client request ID was replaced"
else
    fail_check "client request ID was accepted"
fi

echo "2. Host header behavior"
host_status=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H 'Host: attacker.invalid' \
    "$base_url/api/v2/internal/health" || true)
check_status "unknown Host rejected" "$host_status" "000,400,421,444"

echo "3. oversized headers"
oversized_header=$(head -c 32768 /dev/zero | tr '\000' a)
header_status=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "X-Oversized: $oversized_header" \
    "$base_url/api/v2/internal/health" || true)
check_status "oversized header rejected" "$header_status" "000,400,414,431"

echo "4. oversized body"
head -c 1100000 /dev/zero >"$temp_dir/oversized-body"
body_status=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST --data-binary "@$temp_dir/oversized-body" \
    "$base_url/api/v2/edge-validation")
check_status "oversized body rejected" "$body_status" "413"

echo "5. unauthorized readiness"
readiness_status=$(curl -sS -o /dev/null -w '%{http_code}' \
    "$base_url/api/v2/internal/readiness")
check_status "public readiness rejected" "$readiness_status" "404"

echo "6. unauthorized version"
version_status=$(curl -sS -o /dev/null -w '%{http_code}' \
    "$base_url/api/v2/internal/version")
check_status "public version rejected" "$version_status" "404"

echo "7. rate-limit bypass attempts"
rate_limited=0
for index in $(seq 1 40); do
    status=$(curl -sS -o /dev/null -w '%{http_code}' \
        -H "X-Forwarded-For: 198.51.100.$index" \
        "$base_url/api/v2/security-validation")
    if [ "$status" = "429" ]; then
        rate_limited=1
        break
    fi
done
if [ "$rate_limited" = "1" ]; then
    echo "PASS spoofed X-Forwarded-For did not bypass rate limiting"
else
    fail_check "spoofed X-Forwarded-For bypassed or did not reach the limiter"
fi

echo "8. forwarded-header spoofing"
if [ -n "${STAGING_PROXY_ASSERTION_URL:-}" ]; then
    assertion_body=$(curl -sS \
        -H 'X-Forwarded-For: 198.51.100.7' \
        -H 'X-Forwarded-Proto: ftp' \
        -H 'X-Real-IP: 198.51.100.8' \
        -H 'X-Forwarded-Host: attacker.invalid' \
        "$STAGING_PROXY_ASSERTION_URL")
    case "$assertion_body" in
        *198.51.100.7*|*198.51.100.8*|*attacker.invalid*|*ftp*)
            fail_check "proxy assertion endpoint observed a spoofed forwarded value"
            ;;
        *) echo "PASS forwarded-header spoof values were not observed by Fastify" ;;
    esac
else
    if [ "${STAGING_REQUIRE_PROXY_ASSERTION:-0}" = "1" ]; then
        fail_check "STAGING_PROXY_ASSERTION_URL is required"
    else
        skip_check "no safe Fastify-observed proxy assertion endpoint provided"
    fi
fi

echo "9. sensitive log leakage"
if [ -n "${STAGING_NGINX_LOG_FILE:-}" ]; then
    sentinel="secret-log-sentinel-$(date +%s)"
    curl -sS -o /dev/null \
        -H "Authorization: Bearer $sentinel" \
        -H "Cookie: session=$sentinel" \
        "$base_url/api/v2/internal/health"
    if rg -n "$sentinel" "$STAGING_NGINX_LOG_FILE"; then
        fail_check "sensitive request sentinel appeared in the configured Nginx log"
    else
        echo "PASS authorization/cookie sentinel absent from Nginx log"
    fi
else
    skip_check "STAGING_NGINX_LOG_FILE not provided for leakage inspection"
fi

echo "10. TLS downgrade"
if [ "${STAGING_TLS_MODE:-}" = "nginx" ] && [ -n "${STAGING_HTTP_BASE_URL:-}" ]; then
    downgrade_status=$(curl -sS -I -o "$temp_dir/downgrade.headers" -w '%{http_code}' \
        "$STAGING_HTTP_BASE_URL" || true)
    check_status "HTTP downgrade redirects" "$downgrade_status" "308"
    if rg -qi '^location: *https://' "$temp_dir/downgrade.headers"; then
        echo "PASS downgrade target is HTTPS"
    else
        fail_check "downgrade response did not point to HTTPS"
    fi
else
    skip_check "TLS downgrade requires NGINX_TLS_MODE=nginx and STAGING_HTTP_BASE_URL"
fi

echo "11. direct Fastify access"
if [ -n "${STAGING_DIRECT_FASTIFY_URL:-}" ]; then
    direct_status=$(curl -sS --connect-timeout 2 --max-time 4 -o /dev/null -w '%{http_code}' \
        "$STAGING_DIRECT_FASTIFY_URL" || true)
    if [ "$direct_status" = "000" ]; then
        echo "PASS direct Fastify endpoint is unreachable"
    else
        fail_check "direct Fastify endpoint is reachable ($direct_status)"
    fi
else
    skip_check "STAGING_DIRECT_FASTIFY_URL not provided"
fi

echo "READY FOR STAGING: security checks are prepared; skipped checks require the external values documented in the staging contract."
if [ "$failures" -gt 0 ]; then
    echo "Staging security tests failed: $failures failure(s), $skips skipped." >&2
    exit 1
fi
echo "Staging security checks passed: $skips check(s) skipped."
