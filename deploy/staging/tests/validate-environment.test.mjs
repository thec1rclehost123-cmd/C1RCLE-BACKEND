import test from 'node:test';
import assert from 'node:assert/strict';

import { renderStagingNginx } from '../render-nginx.mjs';
import { validateStagingEnvironment } from '../validate-environment.mjs';

function validEnvironment(overrides = {}) {
  return {
    NGINX_PROFILE: 'staging',
    NGINX_TLS_MODE: 'external',
    NGINX_SERVER_NAME: 'api.staging.c1rcle.com',
    FASTIFY_UPSTREAM: 'fastify.internal:8080',
    PORT: '8080',
    NGINX_HTTP_PORT: '8081',
    NGINX_READINESS_ALLOWLIST_CIDRS: '10.20.0.0/16,2001:db8:1::/64',
    NGINX_EDGE_TRUSTED_CIDRS: '10.30.0.0/16',
    TRUSTED_PROXY_CIDRS: '10.30.0.0/16,2001:db8:2::/64',
    PUBLIC_API_URL: 'https://api.staging.c1rcle.com',
    ALLOWED_ORIGINS: 'https://partner.staging.c1rcle.com',
    BETTER_AUTH_TRUSTED_ORIGINS: 'https://partner.staging.c1rcle.com',
    BETTER_AUTH_URL: 'https://api.staging.c1rcle.com',
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    STORAGE_DRIVER: 'firestore',
    FIRESTORE_PROJECT_ID: 'c1rcle-real-staging',
    FIREBASE_STORAGE_BUCKET: 'c1rcle-real-staging.firebasestorage.app',
    FIREBASE_CLIENT_EMAIL: 'staging-sa@c1rcle-real-staging.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nstaging-key\n-----END PRIVATE KEY-----',
    REDIS_URL: 'rediss://redis.staging.internal:6380',
    BETTER_AUTH_SECRET: 'a'.repeat(64),
    APP_VERSION: '1.2.3',
    BUILD_SHA: 'a'.repeat(40),
    LOG_LEVEL: 'info',
    ...overrides,
  };
}

test('accepts external TLS without certificate variables or HTTPS listener', () => {
  const result = validateStagingEnvironment(validEnvironment());
  assert.equal(result.ok, true, result.issues.join('\n'));
});

test('renders external TLS with a trusted outer proto boundary', () => {
  const rendered = renderStagingNginx(validEnvironment());
  assert.match(rendered.templateName, /staging/);
  assert.match(rendered.content, /server fastify\.internal:8080;/);
  assert.match(rendered.content, /10\.30\.0\.0\/16 1;/);
  assert.doesNotMatch(rendered.content, /\$\{/);
  assert.match(rendered.content, /listen 8081;/);
});

test('accepts bracketed IPv6 Fastify upstreams', () => {
  const result = validateStagingEnvironment(
    validEnvironment({ FASTIFY_UPSTREAM: '[2001:db8::10]:8080' }),
  );
  assert.equal(result.ok, true, result.issues.join('\n'));
});

test('requires Nginx-owned TLS material only in Nginx TLS mode', () => {
  const result = validateStagingEnvironment(
    validEnvironment({
      NGINX_TLS_MODE: 'nginx',
      NGINX_HTTPS_PORT: '8443',
      NGINX_TLS_CERTIFICATE: '/run/secrets/staging.crt',
      NGINX_TLS_CERTIFICATE_KEY: '/run/secrets/staging.key',
      NGINX_EDGE_TRUSTED_CIDRS: undefined,
    }),
  );
  assert.equal(result.ok, true, result.issues.join('\n'));
  const rendered = renderStagingNginx({
    ...validEnvironment(),
    NGINX_TLS_MODE: 'nginx',
    NGINX_HTTPS_PORT: '8443',
    NGINX_TLS_CERTIFICATE: '/run/secrets/staging.crt',
    NGINX_TLS_CERTIFICATE_KEY: '/run/secrets/staging.key',
  });
  assert.match(rendered.templateName, /production/);
  assert.match(rendered.content, /listen 8443 ssl;/);
  assert.match(rendered.content, /ssl_certificate \/run\/secrets\/staging\.crt;/);
});

test('reports missing values and malformed infrastructure inputs together', () => {
  const result = validateStagingEnvironment({
    ...validEnvironment(),
    FASTIFY_UPSTREAM: '',
    NGINX_SERVER_NAME: 'https://not-a-host',
    NGINX_READINESS_ALLOWLIST_CIDRS: '0.0.0.0/0',
    TRUSTED_PROXY_CIDRS: 'not-a-cidr',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    BETTER_AUTH_TRUSTED_ORIGINS: '',
    REDIS_URL: 'redis://localhost:6379',
  });
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /FASTIFY_UPSTREAM/);
  assert.match(result.issues.join('\n'), /NGINX_READINESS_ALLOWLIST_CIDRS/);
  assert.match(result.issues.join('\n'), /TRUSTED_PROXY_CIDRS/);
  assert.match(result.issues.join('\n'), /ALLOWED_ORIGINS/);
  assert.match(result.issues.join('\n'), /BETTER_AUTH_TRUSTED_ORIGINS/);
  assert.match(result.issues.join('\n'), /REDIS_URL/);
});
