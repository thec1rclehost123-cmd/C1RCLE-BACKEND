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

case "$profile" in
    staging)
        require_value FASTIFY_UPSTREAM
        require_value NGINX_HTTP_PORT
        require_value NGINX_SERVER_NAME
        require_value NGINX_READINESS_ALLOWLIST_LINES
        template_path=/etc/nginx/c1rcle-templates/staging.conf.template
        ;;
    production)
        require_value FASTIFY_UPSTREAM
        require_value NGINX_SERVER_NAME
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

envsubst '${FASTIFY_UPSTREAM} ${NGINX_HTTP_PORT} ${NGINX_SERVER_NAME} ${NGINX_READINESS_ALLOWLIST_LINES} ${NGINX_TLS_CERTIFICATE} ${NGINX_TLS_CERTIFICATE_KEY}' \
    < "$template_path" \
    > /etc/nginx/conf.d/c1rcle-api.conf

if [ "${NGINX_VALIDATE_ONLY:-0}" = "1" ]; then
    exec nginx -t -c /etc/nginx/nginx.conf
fi

exec nginx -g 'daemon off;'
