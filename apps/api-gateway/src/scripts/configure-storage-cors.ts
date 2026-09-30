import { storageClient } from '@c1rcle/core/infrastructure';

import { getGatewayConfig } from '../config/index.js';

/**
 * ─── Configure KYC bucket CORS (Phase 2 onboarding uploads) ──────────────────
 *
 * The onboarding Documents step PUTs KYC images straight from the browser to
 * Firebase/Google Cloud Storage via a v4 signed URL
 * (`uploadToSignedUrl.ts` in the frontend) — the gateway never touches the
 * bytes. That makes the upload a cross-origin request the *bucket itself*
 * must authorize: a bucket with no CORS configuration silently fails every
 * browser upload at the preflight, while the signed-URL minting endpoint
 * keeps reporting success (it never touches the bucket). The frontend's own
 * CSP `connect-src` entry (`proxy.ts`) only controls what the browser is
 * willing to attempt — it says nothing about what GCS is willing to accept.
 *
 * A fresh bucket (a new environment, or a first-time local setup pointed at
 * `STORAGE_DRIVER=firestore`) has no CORS policy by default. Run this once
 * per bucket:
 *
 *   pnpm --filter api-gateway configure:storage-cors
 *
 * Idempotent — safe to re-run; it replaces whatever CORS policy is present
 * with the one below rather than merging, so this file is the single source
 * of truth for allowed origins.
 */

const ALLOWED_ORIGINS = [
  // Local dev — the port apps/partner-dashboard/.env.local actually runs on.
  'http://localhost:4000',
  // Local dev — the port documented as this app's default (AGENTS.md).
  'http://localhost:3001',
  'http://localhost:3000',
  // Production.
  'https://thec1rcle.com',
];

async function main(): Promise<void> {
  const gw = getGatewayConfig();
  if (gw.STORAGE_DRIVER === 'memory') {
    throw new Error(
      'STORAGE_DRIVER=memory has no real bucket (the EchoObjectStorage stub never leaves the ' +
        'process). Set STORAGE_DRIVER=firestore to configure CORS on a real bucket.',
    );
  }

  const bucketName = gw.FIREBASE_STORAGE_BUCKET ?? `${gw.FIRESTORE_PROJECT_ID}.firebasestorage.app`;
  const bucket = storageClient(gw).bucket(bucketName);

  await bucket.setCorsConfiguration([
    {
      origin: ALLOWED_ORIGINS,
      method: ['PUT'],
      responseHeader: ['Content-Type', 'x-goog-content-length-range'],
      maxAgeSeconds: 3600,
    },
  ]);

  console.info(`CORS configured on ${bucketName} for: ${ALLOWED_ORIGINS.join(', ')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
