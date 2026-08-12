import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp } from '../../test-utils/app-harness.js';

import { BLOCKED_PATHS, V2_ROUTE_MANIFEST } from './route-manifest.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── B11 / T14: the manifest is the registration authority ───────────────────
 * Gate: "every registered route has an ACTIVE manifest entry and vice-versa;
 * BLOCKED paths 404." Drift in either direction fails here rather than in
 * production.
 */

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildTestApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

/**
 * What Fastify actually registered, as `METHOD /path` pairs.
 *
 * `printRoutes` emits a tree whose child lines hold only the segment relative
 * to their parent, so full paths are rebuilt from the indentation depth.
 */
function registeredRoutes(instance: FastifyInstance): Set<string> {
  const routes = new Set<string>();
  const byDepth: string[] = [];

  for (const line of instance.printRoutes({ commonPrefix: false }).split('\n')) {
    const match = /^(.*?)(\/\S*)\s+\(([^)]+)\)\s*$/.exec(line);
    if (!match) continue;
    const indent = match[1] ?? '';
    const segment = match[2] ?? '';
    const methods = match[3] ?? '';

    // "├── " is 4 columns per level, so depth 0 starts at column 4.
    const depth = Math.max(0, Math.floor(indent.length / 4) - 1);
    byDepth[depth] = segment;
    const path = byDepth
      .slice(0, depth + 1)
      .join('')
      .replace(/\/$/, '');

    for (const method of methods.split(',').map((entry) => entry.trim())) {
      // HEAD/OPTIONS are Fastify's automatic companions, not declared routes.
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.add(`${method} ${path}`);
    }
  }
  return routes;
}

describe('v2 route manifest', () => {
  it('registers every ACTIVE manifest entry', () => {
    const registered = registeredRoutes(app);
    const missing = V2_ROUTE_MANIFEST.filter(
      (route) => route.status === 'ACTIVE' && !registered.has(`${route.method} ${route.path}`),
    );
    expect(missing.map((route) => `${route.method} ${route.path}`)).toEqual([]);
  });

  it('registers nothing that the manifest does not declare', () => {
    const declared = new Set(V2_ROUTE_MANIFEST.map((route) => `${route.method} ${route.path}`));
    const undeclared = [...registeredRoutes(app)].filter((route) => !declared.has(route));
    expect(undeclared).toEqual([]);
  });

  it('404s every BLOCKED path — absent, never a 501 stub', async () => {
    for (const path of BLOCKED_PATHS) {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode, `${path} should 404`).toBe(404);
      expect(response.json()).toMatchObject({ status: 404 });
    }
  });

  it('never answers with 501 anywhere on the v2 surface', async () => {
    for (const path of [...BLOCKED_PATHS, '/api/v2/nothing-here']) {
      for (const method of ['GET', 'POST'] as const) {
        const response = await app.inject({ method, url: path });
        expect(response.statusCode).not.toBe(501);
      }
    }
  });

  it('marks every write as idempotency-REQUIRED, and every PATCH version-locked', () => {
    const writes = V2_ROUTE_MANIFEST.filter(
      (route) => route.auth === 'PARTNER' && ['POST', 'PATCH', 'PUT'].includes(route.method),
    );
    expect(writes.every((route) => route.idempotency === 'REQUIRED')).toBe(true);
    expect(
      writes
        .filter((route) => route.method === 'PATCH')
        .every((route) => route.expectedVersion === 'REQUIRED'),
    ).toBe(true);
  });
});
