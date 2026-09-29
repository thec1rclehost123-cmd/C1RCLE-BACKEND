/**
 * Read-only Firestore connection to the OLD v1 project (`thec1rcle-india`),
 * used only by `scripts/migrate-and-seed-v1-sample.ts`. Lives here (not in
 * `scripts/`) because `scripts/check-boundaries.mjs` Rule 3 only allows a
 * `firebase-admin` import from `apps/api-gateway/src/lib` or the core
 * Firestore adapter — never from an arbitrary script file.
 *
 * Deliberately a SEPARATE named Firebase app from `@c1rcle/core`'s
 * `getFirestoreClient` (which caches a single app under the fixed name
 * `'c1rcle-v2'`): reusing that helper with v1 credentials would silently
 * return the already-cached v2 app on a second call, pointing "v1 reads" at
 * the v2 project instead.
 */
import { readFileSync } from 'node:fs';

import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

const V1_ENV_PATH =
  'C:\\Users\\SHRIYASH SAWANT\\OneDrive\\Desktop\\Circle1\\thec1rcle\\apps\\api-gateway\\.env.development';
const V1_APP_NAME = 'v1-read-only';

function readV1Credentials(): { projectId: string; clientEmail: string; privateKey: string } {
  const raw = readFileSync(V1_ENV_PATH, 'utf8');
  const get = (key: string): string => {
    const line = raw.split('\n').find((entry) => entry.startsWith(`${key}=`));
    if (line === undefined) throw new Error(`${key} not found in ${V1_ENV_PATH}`);
    let value = line.slice(key.length + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return value;
  };
  return {
    projectId: get('FIREBASE_PROJECT_ID'),
    clientEmail: get('FIREBASE_CLIENT_EMAIL'),
    privateKey: get('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
  };
}

let cached: Firestore | null = null;

/** Read-only handle to v1's Firestore. Never used for writes. */
function v1Firestore(): Firestore {
  if (cached !== null) return cached;
  const creds = readV1Credentials();
  const app = initializeApp(
    {
      credential: cert({
        projectId: creds.projectId,
        clientEmail: creds.clientEmail,
        privateKey: creds.privateKey,
      }),
    },
    V1_APP_NAME,
  );
  cached = getFirestore(app);
  return cached;
}

/** Counts non-empty leaf values (string/number/boolean truthy, non-empty array/object) recursively — a cheap "how filled-in is this doc" score. */
function richness(value: unknown, depth = 0): number {
  if (depth > 4 || value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.trim().length > 0 ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'boolean') return 1;
  if (Array.isArray(value))
    return value.reduce((sum: number, entry) => sum + richness(entry, depth + 1), 0);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce(
      (sum: number, entry) => sum + richness(entry, depth + 1),
      0,
    );
  }
  return 0;
}

/** The `limit` most-populated documents in a v1 collection, richest first. */
export async function richestV1Docs(
  collection: string,
  limit: number,
): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const snap = await v1Firestore().collection(collection).limit(500).get();
  const docs: { id: string; data: Record<string, unknown> }[] = snap.docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
  }));
  docs.sort((a, b) => richness(b.data) - richness(a.data));
  return docs.slice(0, limit);
}
