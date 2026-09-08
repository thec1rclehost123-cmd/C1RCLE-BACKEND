#!/bin/bash
# Starts the Fastify gateway (internal, PORT=8081) and the nginx sidecar
# (public, :8080) in one container. Either process exiting brings the whole
# container down — a supervisor that stays up with a dead app process behind
# it would report healthy while serving nothing useful.
# `wait -n` is a bashism (dash's /bin/sh doesn't have it) — hence bash here.
set -eu

mkdir -p /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi

PORT=8081 node --import tsx src/server.ts &
NODE_PID=$!

nginx -c /app/nginx/nginx.conf -g 'daemon off;' &
NGINX_PID=$!

trap 'kill -TERM "$NODE_PID" "$NGINX_PID" 2>/dev/null' TERM INT

wait -n "$NODE_PID" "$NGINX_PID"
EXIT_CODE=$?
kill -TERM "$NODE_PID" "$NGINX_PID" 2>/dev/null || true
exit "$EXIT_CODE"
