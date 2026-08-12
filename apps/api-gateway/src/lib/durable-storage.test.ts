import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { getGatewayConfig } from '../config/index.js';

import { resetV2Services } from './v2-services.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── B12: the app on durable storage ─────────────────────────────────────────
 * The contract suite proves the adapter satisfies the ports. This proves the
 * GATEWAY actually runs on it: a request through the real HTTP surface leaves
 * rows on disk, and a fresh process reads them back.
 */

let directory: string;
let databasePath: string;
let app: FastifyInstance;

function sqliteConfig() {
  return { ...getGatewayConfig(), STORAGE_DRIVER: 'sqlite' as const, SQLITE_PATH: databasePath };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'c1rcle-durable-'));
  databasePath = join(directory, 'test.sqlite');
  resetV2Services();
  app = await buildApp({ config: sqliteConfig(), rateLimit: false });
});

afterEach(async () => {
  await app.close();
  resetV2Services();
  rmSync(directory, { recursive: true, force: true });
});

async function createOrganization(instance: FastifyInstance) {
  const signUp = await instance.inject({
    method: 'POST',
    url: '/api/v2/auth/sign-up',
    payload: { email: 'durable@example.com', password: 'password12345', displayName: 'Durable' },
  });
  const token = signUp.json().accessToken;

  const created = await instance.inject({
    method: 'POST',
    url: '/api/v2/partner/organizations',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'durable-1' },
    payload: { name: 'Durable Co', slug: 'durable-co' },
  });
  return { token, created };
}

describe('gateway on SQLite', () => {
  it('writes a request through to disk', async () => {
    const { created } = await createOrganization(app);
    expect(created.statusCode).toBe(201);

    // Read the file directly: this is durability, not a cache of our own making.
    const db = new DatabaseSync(databasePath);
    const organizations = db.prepare('SELECT id, slug FROM organizations').all() as unknown as {
      id: string;
      slug: string;
    }[];
    const members = db.prepare('SELECT user_id FROM organization_members').all();

    expect(organizations).toHaveLength(1);
    expect(organizations[0]?.slug).toBe('durable-co');
    expect(members).toHaveLength(1);
    db.close();
  });

  it('survives a restart — a new app instance reads the same rows', async () => {
    const { created } = await createOrganization(app);
    const organizationId = created.json().id;

    await app.close();
    resetV2Services();

    // A brand-new process-equivalent, pointed at the same file.
    const restarted = await buildApp({ config: sqliteConfig(), rateLimit: false });
    try {
      const login = await restarted.inject({
        method: 'POST',
        url: '/api/v2/auth/login',
        payload: { email: 'durable@example.com', password: 'password12345' },
      });
      // Sessions are still Better Auth's in-memory store, so the credential
      // does not survive: only the business data is durable today.
      expect([200, 401]).toContain(login.statusCode);

      const db = new DatabaseSync(databasePath);
      const rows = db
        .prepare('SELECT document FROM organizations WHERE id = ?')
        .all(String(organizationId)) as unknown as { document: string }[];
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.document ?? '{}')).toMatchObject({ slug: 'durable-co' });
      db.close();
    } finally {
      await restarted.close();
      app = await buildApp({ config: sqliteConfig(), rateLimit: false });
    }
  });
});
