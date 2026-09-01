#!/bin/sh

set -eu

profile="${NGINX_PROFILE:-staging}"

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
        require_value NGINX_EDGE_TRUSTED_CIDR_LINES
        template_path=/etc/nginx/c1rcle-templates/staging.conf.template
        ;;
    production)
        require_value FASTIFY_UPSTREAM
        require_value NGINX_SERVER_NAME
        require_value NGINX_HTTP_PORT
        require_value NGINX_HTTPS_PORT
        require_value NGINX_READINESS_ALLOWLIST_LINES
        require_value NGINX_TLS_CERTIFICATE
        require_value NGINX_TLS_CERTIFICATE_KEY
        template_path=/etc/nginx/c1rcle-templates/production.conf.template
        ;;
    *)
        echo "NGINX_PROFILE must be staging or production" >&2
        exit 64
        ;;
esac

validate_port NGINX_HTTP_PORT
if [ "$profile" = "production" ]; then
    validate_port NGINX_HTTPS_PORT
    if [ "$NGINX_HTTP_PORT" = "$NGINX_HTTPS_PORT" ]; then
        echo "NGINX_HTTP_PORT and NGINX_HTTPS_PORT must differ" >&2
        exit 64
    fi
fi

case "${FASTIFY_UPSTREAM:-}" in
    *://*|*/*|*" "*|*\?*)
        echo "FASTIFY_UPSTREAM must be a host:port value without a scheme, path, or spaces" >&2
        exit 64
        ;;
esac

envsubst '${FASTIFY_UPSTREAM} ${NGINX_HTTP_PORT} ${NGINX_HTTPS_PORT} ${NGINX_SERVER_NAME} ${NGINX_READINESS_ALLOWLIST_LINES} ${NGINX_EDGE_TRUSTED_CIDR_LINES} ${NGINX_TLS_CERTIFICATE} ${NGINX_TLS_CERTIFICATE_KEY}' \
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
