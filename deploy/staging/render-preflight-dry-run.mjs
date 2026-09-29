import fs from 'node:fs';
import path from 'node:path';

import { renderStagingNginx } from './render-nginx.mjs';
import { assertValidStagingEnvironment } from './validate-environment.mjs';

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex === -1 ? '' : process.argv[outputIndex + 1];
if (!outputPath) throw new Error('Usage: node render-preflight-dry-run.mjs --output <path>');

// Reserved, non-routable fixture values prove the Render shape without
// embedding live service addresses or credentials in the repository.
const environment = {
  STAGING_PREFLIGHT_DRY_RUN: '1',
  NGINX_PROFILE: 'staging',
  NGINX_TLS_MODE: 'external',
  NGINX_SERVER_NAME: 'circle-v2-edge-staging.invalid',
  NGINX_FORWARDED_PROTO: 'https',
  FASTIFY_UPSTREAM: 'circle-v2-backend-staging.internal:8080',
  FASTIFY_PORT: '8080',
  PORT: '18080',
  NGINX_READINESS_TOKEN: 'dry-run-readiness-token-fixture',
  TRUSTED_PROXY_CIDRS: '10.20.0.0/24',
  PUBLIC_API_URL: 'https://circle-v2-edge-staging.invalid',
  ALLOWED_ORIGINS: 'https://partner-staging.invalid',
  BETTER_AUTH_TRUSTED_ORIGINS: 'https://partner-staging.invalid',
  BETTER_AUTH_URL: 'https://circle-v2-edge-staging.invalid',
  NODE_ENV: 'production',
  HOST: '0.0.0.0',
  STORAGE_DRIVER: 'firestore',
  FIRESTORE_PROJECT_ID: 'c1rcle-staging-dry-run',
  FIREBASE_STORAGE_BUCKET: 'c1rcle-staging-dry-run.firebasestorage.app',
  FIREBASE_CLIENT_EMAIL: 'staging-dry-run@c1rcle-staging-dry-run.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY:
    '-----BEGIN PRIVATE KEY-----\nrender-staging-dry-run-only\n-----END PRIVATE KEY-----',
  BETTER_AUTH_SECRET: 'render-staging-dry-run-secret-not-for-runtime'.repeat(2),
  APP_VERSION: '0.1.0-staging',
  RENDER_GIT_COMMIT: 'a'.repeat(40),
  LOG_LEVEL: 'info',
};

const validated = assertValidStagingEnvironment(environment);
const rendered = renderStagingNginx(environment);

if (validated.values.httpPort !== 18080 || validated.values.fastifyPort !== 8080) {
  throw new Error('Render public PORT and private Fastify port were not kept separate');
}
if (validated.values.buildSha !== environment.RENDER_GIT_COMMIT) {
  throw new Error('RENDER_GIT_COMMIT did not populate BUILD_SHA');
}
if (validated.values.redisUrl !== '')
  throw new Error('Redis must remain optional for initial staging');
if (rendered.content.includes('${')) throw new Error('Rendered Nginx config has placeholders');
if (!rendered.content.includes('listen 18080;')) throw new Error('Nginx did not consume PORT');
if (!rendered.content.includes('server circle-v2-backend-staging.internal:8080;')) {
  throw new Error('Nginx did not preserve the private Fastify upstream');
}
if (!rendered.content.includes('default https;')) {
  throw new Error('Render TLS ownership did not produce an HTTPS forwarding boundary');
}

const absoluteOutput = path.resolve(outputPath);
fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
fs.writeFileSync(absoluteOutput, rendered.content, { encoding: 'utf8', mode: 0o600 });
console.log(`Render staging dry-run rendered ${absoluteOutput}`);
