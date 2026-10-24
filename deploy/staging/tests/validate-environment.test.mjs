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
    FASTIFY_PORT: '8080',
    PORT: '18080',
    NGINX_READINESS_TOKEN: 'test-fixture-readiness-token-value',
    NGINX_FORWARDED_PROTO: 'https',
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

test('rejects contradictory external TLS values', () => {
  const result = validateStagingEnvironment(
    validEnvironment({
      NGINX_HTTPS_PORT: '8443',
      NGINX_TLS_CERTIFICATE: '/run/secrets/unexpected.crt',
      NGINX_TLS_CERTIFICATE_KEY: '/run/secrets/unexpected.key',
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /NGINX_HTTPS_PORT/);
  assert.match(result.issues.join('\n'), /NGINX_TLS_CERTIFICATE/);
  assert.match(result.issues.join('\n'), /NGINX_TLS_CERTIFICATE_KEY/);
});

test('renders external TLS on the Render-provided public port without trusting a header', () => {
  const rendered = renderStagingNginx(validEnvironment());
  assert.match(rendered.templateName, /staging/);
  assert.match(rendered.content, /server fastify\.internal:8080;/);
  assert.match(rendered.content, /default https;/);
  assert.doesNotMatch(rendered.content, /\$\{/);
  assert.match(rendered.content, /listen 18080;/);
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
      NGINX_FORWARDED_PROTO: undefined,
    }),
  );
  assert.equal(result.ok, true, result.issues.join('\n'));
  const rendered = renderStagingNginx({
    ...validEnvironment(),
    NGINX_TLS_MODE: 'nginx',
    NGINX_HTTP_PORT: '8081',
    NGINX_HTTPS_PORT: '8443',
    NGINX_FORWARDED_PROTO: undefined,
    NGINX_TLS_CERTIFICATE: '/run/secrets/staging.crt',
    NGINX_TLS_CERTIFICATE_KEY: '/run/secrets/staging.key',
  });
  assert.match(rendered.templateName, /production/);
  assert.match(rendered.content, /listen 8443 ssl;/);
  assert.match(rendered.content, /ssl_certificate \/run\/secrets\/staging\.crt;/);
});

test('rejects a TLS listener collision and fixed forwarded proto in Nginx TLS mode', () => {
  const result = validateStagingEnvironment(
    validEnvironment({
      NGINX_TLS_MODE: 'nginx',
      NGINX_HTTP_PORT: '8443',
      NGINX_HTTPS_PORT: '8443',
      NGINX_TLS_CERTIFICATE: '/run/secrets/staging.crt',
      NGINX_TLS_CERTIFICATE_KEY: '/run/secrets/staging.key',
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /must differ/);
  assert.match(result.issues.join('\n'), /NGINX_FORWARDED_PROTO/);
});

test('accepts omitted Redis and Render-provided build metadata', () => {
  const result = validateStagingEnvironment(
    validEnvironment({
      REDIS_URL: undefined,
      BUILD_SHA: undefined,
      RENDER_GIT_COMMIT: 'b'.repeat(40),
    }),
  );
  assert.equal(result.ok, true, result.issues.join('\n'));
  assert.equal(result.values.redisUrl, '');
  assert.equal(result.values.buildSha, 'b'.repeat(40));
});

test('rejects non-routable dry-run hosts outside explicit dry-run mode', () => {
  const result = validateStagingEnvironment(
    validEnvironment({
      NGINX_SERVER_NAME: 'edge.invalid',
      PUBLIC_API_URL: 'https://edge.invalid',
      BETTER_AUTH_URL: 'https://edge.invalid',
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /must not use a dry-run \.invalid value/);
});

test('rejects unspecified Fastify upstream addresses', () => {
  const result = validateStagingEnvironment(validEnvironment({ FASTIFY_UPSTREAM: '0.0.0.0:8080' }));
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /unspecified address/);
});

test('reports missing values and malformed infrastructure inputs together', () => {
  const result = validateStagingEnvironment({
    ...validEnvironment(),
    FASTIFY_UPSTREAM: '',
    NGINX_SERVER_NAME: 'https://not-a-host',
    NGINX_READINESS_TOKEN: 'too-short',
    TRUSTED_PROXY_CIDRS: 'not-a-cidr',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    BETTER_AUTH_TRUSTED_ORIGINS: '',
    REDIS_URL: 'redis://localhost:6379',
  });
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /FASTIFY_UPSTREAM/);
  assert.match(result.issues.join('\n'), /NGINX_READINESS_TOKEN/);
  assert.match(result.issues.join('\n'), /TRUSTED_PROXY_CIDRS/);
  assert.match(result.issues.join('\n'), /ALLOWED_ORIGINS/);
  assert.match(result.issues.join('\n'), /BETTER_AUTH_TRUSTED_ORIGINS/);
  assert.match(result.issues.join('\n'), /REDIS_URL/);
});

test('accepts additional server names and renders every one into the host allow-list', () => {
  const env = validEnvironment({
    NGINX_ADDITIONAL_SERVER_NAMES: 'api-staging.c1rcle.com, Legacy.Staging.C1RCLE.com',
  });
  const result = validateStagingEnvironment(env);
  assert.equal(result.ok, true, result.issues.join('\n'));
  assert.deepEqual(result.values.additionalServerNames, [
    'api-staging.c1rcle.com',
    'legacy.staging.c1rcle.com',
  ]);

  const { content } = renderStagingNginx(env);
  assert.match(
    content,
    /server_name api\.staging\.c1rcle\.com api-staging\.c1rcle\.com legacy\.staging\.c1rcle\.com;/,
  );
  for (const name of [
    'api.staging.c1rcle.com',
    'api-staging.c1rcle.com',
    'legacy.staging.c1rcle.com',
  ]) {
    assert.match(content, new RegExp(`^\\s+${name.replaceAll('.', '\\.')} 1;$`, 'm'));
  }
});

test('an environment without additional server names renders exactly one allowed host', () => {
  const result = validateStagingEnvironment(validEnvironment());
  assert.equal(result.ok, true, result.issues.join('\n'));
  assert.deepEqual(result.values.additionalServerNames, []);
  const { content } = renderStagingNginx(validEnvironment());
  assert.match(content, /server_name api\.staging\.c1rcle\.com;/);
});

test('accepts an origin lock on a served host and keeps it optional', () => {
  const secret = 'a'.repeat(40);
  const locked = validateStagingEnvironment(
    validEnvironment({
      NGINX_ADDITIONAL_SERVER_NAMES: 'api-staging.c1rcle.com',
      NGINX_ORIGIN_VERIFY_SECRET: secret,
      NGINX_ORIGIN_LOCKED_SERVER_NAMES: 'API-STAGING.c1rcle.com',
    }),
  );
  assert.equal(locked.ok, true, locked.issues.join('\n'));
  assert.deepEqual(locked.values.originLockedServerNames, ['api-staging.c1rcle.com']);

  const plain = validateStagingEnvironment(validEnvironment());
  assert.equal(plain.ok, true, plain.issues.join('\n'));
  assert.deepEqual(plain.values.originLockedServerNames, []);
});

test('rejects origin-lock values that would lock everything out or alter nginx config', () => {
  const cases = [
    [
      'a secret that is too short',
      { NGINX_ORIGIN_VERIFY_SECRET: 'short' },
      'NGINX_ORIGIN_VERIFY_SECRET',
    ],
    [
      'a secret with a quote',
      { NGINX_ORIGIN_VERIFY_SECRET: `${'a'.repeat(40)}"x` },
      'NGINX_ORIGIN_VERIFY_SECRET',
    ],
    [
      'a secret with a semicolon',
      { NGINX_ORIGIN_VERIFY_SECRET: `${'a'.repeat(40)};x` },
      'NGINX_ORIGIN_VERIFY_SECRET',
    ],
    [
      'a locked host with no secret',
      { NGINX_ORIGIN_LOCKED_SERVER_NAMES: 'api.staging.c1rcle.com' },
      'NGINX_ORIGIN_LOCKED_SERVER_NAMES',
    ],
    [
      'a locked host that is not served',
      {
        NGINX_ORIGIN_VERIFY_SECRET: 'a'.repeat(40),
        NGINX_ORIGIN_LOCKED_SERVER_NAMES: 'other.c1rcle.com',
      },
      'NGINX_ORIGIN_LOCKED_SERVER_NAMES',
    ],
  ];
  for (const [label, overrides, field] of cases) {
    const result = validateStagingEnvironment(validEnvironment(overrides));
    assert.equal(result.ok, false, `expected ${label} to be rejected`);
    assert.ok(
      result.issues.some((issue) => issue.includes(field)),
      `expected an ${field} issue for ${label}, got: ${result.issues.join('; ')}`,
    );
  }
});

test('rejects additional server names that could alter the nginx config', () => {
  for (const bad of [
    '*.c1rcle.com',
    'a.c1rcle.com;return 200',
    'https://a.c1rcle.com/x',
    'a.c1rcle.com"b',
    '.a.c1rcle.com',
    'a..c1rcle.com',
    'api.staging.c1rcle.com',
  ]) {
    const result = validateStagingEnvironment(
      validEnvironment({ NGINX_ADDITIONAL_SERVER_NAMES: bad }),
    );
    assert.equal(result.ok, false, `expected "${bad}" to be rejected`);
    assert.ok(
      result.issues.some((issue) => issue.includes('NGINX_ADDITIONAL_SERVER_NAMES')),
      `expected an NGINX_ADDITIONAL_SERVER_NAMES issue for "${bad}", got: ${result.issues.join('; ')}`,
    );
  }
});
