/**
 * ─── Firestore client (B12) ────────────────────────────────────────────────
 * The one place `firebase-admin` is initialized. Credentials are injected —
 * never `process.env` (that's the gateway config's job, T09/rule 9). This
 * directory is the only place in `packages/core` allowed to import
 * `firebase-admin` (`scripts/check-boundaries.mjs` Rule 3 exemption).
 *
 * V2 collections are prefixed `v2_` and are never the same collections V1
 * (`thec1rcle`) reads/writes — see architecture rule 8 (V1‖V2 parallel).
 */
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

// Re-exported so callers outside this directory (e.g. the gateway's auth
// plugin, which needs the type for `betterAuth-firestore`) never need their
// own `firebase-admin` import — this directory stays the one place that
// knows the storage engine exists (scripts/check-boundaries.mjs Rule 3).
export type { Firestore };

export interface FirestoreCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const APP_NAME = 'c1rcle-v2';

let cachedApp: App | null = null;

/** Idempotent: safe to call repeatedly (e.g. across `tsx watch` reloads). */
export function getFirestoreClient(credentials: FirestoreCredentials): Firestore {
  cachedApp ??=
    getApps().find((app) => app.name === APP_NAME) ??
    initializeApp(
      {
        projectId: credentials.projectId,
        credential: cert({
          projectId: credentials.projectId,
          clientEmail: credentials.clientEmail,
          // .env files store the key with literal `\n` escapes.
          privateKey: credentials.privateKey.replace(/\\n/g, '\n'),
        }),
      },
      APP_NAME,
    );
  return getFirestore(cachedApp);
}
