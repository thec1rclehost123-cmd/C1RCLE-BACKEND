#!/bin/sh

set -eu

profile="${NGINX_PROFILE:-staging}"
# api-only = the classic single-host API edge (default, backward compatible).
# full-edge = API edge + guest/partner/admin BFF server blocks in one render.
topology="${NGINX_TOPOLOGY:-api-only}"

# Render Web Services inject PORT at runtime. Keep NGINX_HTTP_PORT available
# for provider-neutral deployments, but let the platform-owned listener win
# when the explicit Nginx name is omitted.
if [ -z "${NGINX_HTTP_PORT:-}" ] && [ -n "${PORT:-}" ]; then
    NGINX_HTTP_PORT="$PORT"
    export NGINX_HTTP_PORT
fi

validate_upstream() {
    variable_name="$1"
    eval "variable_value=\${$variable_name:-}"
    case "$variable_value" in
        *://*|*/*|*" "*|*\?*)
            echo "$variable_name must be a host:port value without a scheme, path, or spaces" >&2
            exit 64
            ;;
    esac
}

require_value() {
    variable_name="$1"
    eval "variable_value=\${$variable_name:-}"
    if [ -z "$variable_value" ]; then
        echo "Missing required Nginx environment variable: $variable_name" >&2
        exit 64
    fi
}

validate_port() {
    variable_name="$1"
    eval "variable_value=\${$variable_name:-}"
    case "$variable_value" in
        ''|*[!0-9]*) echo "$variable_name must be an integer from 1 to 65535" >&2; exit 64 ;;
    esac
    if [ "$variable_value" -lt 1 ] || [ "$variable_value" -gt 65535 ]; then
        echo "$variable_name must be an integer from 1 to 65535" >&2
        exit 64
    fi
}

case "$profile" in
    staging)
        require_value FASTIFY_UPSTREAM
        require_value NGINX_HTTP_PORT
        require_value NGINX_SERVER_NAME
        require_value NGINX_READINESS_TOKEN
        require_value NGINX_FORWARDED_PROTO
        ;;
    production)
        require_value FASTIFY_UPSTREAM
        require_value NGINX_SERVER_NAME
        require_value NGINX_HTTP_PORT
        require_value NGINX_HTTPS_PORT
        require_value NGINX_READINESS_TOKEN
        require_value NGINX_TLS_CERTIFICATE
        require_value NGINX_TLS_CERTIFICATE_KEY
        ;;
    *)
        echo "NGINX_PROFILE must be staging or production" >&2
        exit 64
        ;;
esac

case "$topology" in
    api-only)
        template_suffix=""
        ;;
    full-edge)
        template_suffix="-edge"
        require_value NGINX_GUEST_SERVER_NAME
        require_value NGINX_PARTNER_SERVER_NAME
        require_value NGINX_ADMIN_SERVER_NAME
        require_value BFF_GUEST_UPSTREAM
        require_value BFF_PARTNER_UPSTREAM
        require_value BFF_ADMIN_UPSTREAM
        ;;
    *)
        echo "NGINX_TOPOLOGY must be api-only or full-edge" >&2
        exit 64
        ;;
esac

# The API hostname defaults to the classic NGINX_SERVER_NAME so a full-edge
# deployment can name the API edge exactly as an api-only deployment did.
if [ -z "${NGINX_API_SERVER_NAME:-}" ]; then
    NGINX_API_SERVER_NAME="$NGINX_SERVER_NAME"
    export NGINX_API_SERVER_NAME
fi

# Extra hostnames this edge accepts in addition to NGINX_SERVER_NAME (the
# canonical name, which must keep matching PUBLIC_API_URL). Lets one service
# answer on a new custom domain while the old one still works, so a hostname
# migration is two safe steps instead of one cutover. Every other Host header
# is still refused (444), which is what `$c1rcle_host_allowed` exists for.
#
# These values are written into nginx config, so they are validated strictly:
# plain hostnames only (letters, digits, dots, hyphens), no wildcards, no
# spaces or quotes that could end a directive. Anything else fails closed.
NGINX_SERVER_NAMES="$NGINX_SERVER_NAME"
NGINX_HOST_MAP_ENTRIES="    ${NGINX_SERVER_NAME} 1;"
if [ -n "${NGINX_ADDITIONAL_SERVER_NAMES:-}" ]; then
    if [ "$topology" != "api-only" ]; then
        echo "NGINX_ADDITIONAL_SERVER_NAMES is only supported with NGINX_TOPOLOGY=api-only" >&2
        exit 64
    fi
    additional_names=$(printf '%s' "$NGINX_ADDITIONAL_SERVER_NAMES" | tr ',' ' ' | tr '[:upper:]' '[:lower:]')
    for extra_name in $additional_names; do
        case "$extra_name" in
            ''|*[!a-z0-9.-]*|.*|*.|-*|*-|*..*)
                echo "NGINX_ADDITIONAL_SERVER_NAMES contains an invalid hostname: $extra_name" >&2
                exit 64
                ;;
        esac
        if [ "${#extra_name}" -gt 253 ]; then
            echo "NGINX_ADDITIONAL_SERVER_NAMES contains a hostname longer than 253 characters" >&2
            exit 64
        fi
        case " $NGINX_SERVER_NAMES " in
            *" $extra_name "*)
                echo "NGINX_ADDITIONAL_SERVER_NAMES repeats a hostname: $extra_name" >&2
                exit 64
                ;;
        esac
        NGINX_SERVER_NAMES="$NGINX_SERVER_NAMES $extra_name"
        NGINX_HOST_MAP_ENTRIES="$NGINX_HOST_MAP_ENTRIES
    $extra_name 1;"
    done
fi
export NGINX_SERVER_NAMES NGINX_HOST_MAP_ENTRIES

# Origin verification (see templates/client-ip.conf.template). Both values are
# written into nginx config, so both are validated strictly and fail closed.
#   NGINX_ORIGIN_VERIFY_SECRET        shared secret Cloudflare stamps on requests
#   NGINX_ORIGIN_LOCKED_SERVER_NAMES  hostnames that are refused without it
# Unset, nothing changes: the client IP stays the socket peer.
NGINX_ORIGIN_VERIFY_MAP_ENTRIES=""
NGINX_ORIGIN_LOCKED_MAP_ENTRIES=""
if [ -n "${NGINX_ORIGIN_VERIFY_SECRET:-}" ]; then
    case "$NGINX_ORIGIN_VERIFY_SECRET" in
        *[!A-Za-z0-9._~-]*)
            echo "NGINX_ORIGIN_VERIFY_SECRET may contain only letters, digits and . _ ~ -" >&2
            exit 64
            ;;
    esac
    if [ "${#NGINX_ORIGIN_VERIFY_SECRET}" -lt 32 ] || [ "${#NGINX_ORIGIN_VERIFY_SECRET}" -gt 256 ]; then
        echo "NGINX_ORIGIN_VERIFY_SECRET must be 32 to 256 characters" >&2
        exit 64
    fi
    NGINX_ORIGIN_VERIFY_MAP_ENTRIES="    \"${NGINX_ORIGIN_VERIFY_SECRET}\" 1;"
fi
if [ -n "${NGINX_ORIGIN_LOCKED_SERVER_NAMES:-}" ]; then
    if [ -z "${NGINX_ORIGIN_VERIFY_SECRET:-}" ]; then
        echo "NGINX_ORIGIN_LOCKED_SERVER_NAMES requires NGINX_ORIGIN_VERIFY_SECRET (it would lock every request out)" >&2
        exit 64
    fi
    if [ "$topology" != "api-only" ]; then
        echo "NGINX_ORIGIN_LOCKED_SERVER_NAMES is only supported with NGINX_TOPOLOGY=api-only" >&2
        exit 64
    fi
    locked_names=$(printf '%s' "$NGINX_ORIGIN_LOCKED_SERVER_NAMES" | tr ',' ' ' | tr '[:upper:]' '[:lower:]')
    for locked_name in $locked_names; do
        case " $NGINX_SERVER_NAMES " in
            *" $locked_name "*) : ;;
            *)
                echo "NGINX_ORIGIN_LOCKED_SERVER_NAMES must name a served host, not: $locked_name" >&2
                exit 64
                ;;
        esac
        NGINX_ORIGIN_LOCKED_MAP_ENTRIES="${NGINX_ORIGIN_LOCKED_MAP_ENTRIES:+$NGINX_ORIGIN_LOCKED_MAP_ENTRIES
}    $locked_name 1;"
    done
fi
export NGINX_ORIGIN_VERIFY_MAP_ENTRIES NGINX_ORIGIN_LOCKED_MAP_ENTRIES

template_path="/etc/nginx/c1rcle-templates/${profile}${template_suffix}.conf.template"

validate_port NGINX_HTTP_PORT
case "${NGINX_FORWARDED_PROTO:-}" in
    http|https|'') : ;;
    *) echo "NGINX_FORWARDED_PROTO must be http or https" >&2; exit 64 ;;
esac
if [ "$profile" = "production" ]; then
    validate_port NGINX_HTTPS_PORT
    if [ "$NGINX_HTTP_PORT" = "$NGINX_HTTPS_PORT" ]; then
        echo "NGINX_HTTP_PORT and NGINX_HTTPS_PORT must differ" >&2
        exit 64
    fi
fi

validate_upstream FASTIFY_UPSTREAM
if [ "$topology" = "full-edge" ]; then
    validate_upstream BFF_GUEST_UPSTREAM
    validate_upstream BFF_PARTNER_UPSTREAM
    validate_upstream BFF_ADMIN_UPSTREAM
fi

envsubst '${FASTIFY_UPSTREAM} ${BFF_GUEST_UPSTREAM} ${BFF_PARTNER_UPSTREAM} ${BFF_ADMIN_UPSTREAM} ${NGINX_HTTP_PORT} ${NGINX_HTTPS_PORT} ${NGINX_SERVER_NAME} ${NGINX_SERVER_NAMES} ${NGINX_HOST_MAP_ENTRIES} ${NGINX_API_SERVER_NAME} ${NGINX_GUEST_SERVER_NAME} ${NGINX_PARTNER_SERVER_NAME} ${NGINX_ADMIN_SERVER_NAME} ${NGINX_READINESS_TOKEN} ${NGINX_FORWARDED_PROTO} ${NGINX_TLS_CERTIFICATE} ${NGINX_TLS_CERTIFICATE_KEY}' \
    < "$template_path" \
    > /etc/nginx/conf.d/c1rcle-api.conf

if grep -Fq '${' /etc/nginx/conf.d/c1rcle-api.conf; then
    echo "Rendered Nginx config contains unresolved placeholders" >&2
    exit 64
fi

# Client IP + origin verification: rendered for every profile and topology (a
# no-op unless NGINX_ORIGIN_VERIFY_SECRET is set).
envsubst '${NGINX_ORIGIN_VERIFY_MAP_ENTRIES} ${NGINX_ORIGIN_LOCKED_MAP_ENTRIES}' \
    < /etc/nginx/c1rcle-templates/client-ip.conf.template \
    > /etc/nginx/conf.d/c1rcle-client-ip.conf
if grep -Fq '${' /etc/nginx/conf.d/c1rcle-client-ip.conf; then
    echo "Rendered client-IP Nginx config contains unresolved placeholders" >&2
    exit 64
fi

if [ "${NGINX_VALIDATE_ONLY:-0}" = "1" ]; then
    exec nginx -t -c /etc/nginx/nginx.conf
fi

exec nginx -g 'daemon off;'
