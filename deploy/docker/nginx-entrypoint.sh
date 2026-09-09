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
        require_value NGINX_READINESS_ALLOWLIST_LINES
        require_value NGINX_FORWARDED_PROTO
        ;;
    production)
        require_value FASTIFY_UPSTREAM
        require_value NGINX_SERVER_NAME
        require_value NGINX_HTTP_PORT
        require_value NGINX_HTTPS_PORT
        require_value NGINX_READINESS_ALLOWLIST_LINES
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

envsubst '${FASTIFY_UPSTREAM} ${BFF_GUEST_UPSTREAM} ${BFF_PARTNER_UPSTREAM} ${BFF_ADMIN_UPSTREAM} ${NGINX_HTTP_PORT} ${NGINX_HTTPS_PORT} ${NGINX_SERVER_NAME} ${NGINX_API_SERVER_NAME} ${NGINX_GUEST_SERVER_NAME} ${NGINX_PARTNER_SERVER_NAME} ${NGINX_ADMIN_SERVER_NAME} ${NGINX_READINESS_ALLOWLIST_LINES} ${NGINX_FORWARDED_PROTO} ${NGINX_TLS_CERTIFICATE} ${NGINX_TLS_CERTIFICATE_KEY}' \
    < "$template_path" \
    > /etc/nginx/conf.d/c1rcle-api.conf

if grep -Fq '${' /etc/nginx/conf.d/c1rcle-api.conf; then
    echo "Rendered Nginx config contains unresolved placeholders" >&2
    exit 64
fi

if [ "${NGINX_VALIDATE_ONLY:-0}" = "1" ]; then
    exec nginx -t -c /etc/nginx/nginx.conf
fi

exec nginx -g 'daemon off;'
