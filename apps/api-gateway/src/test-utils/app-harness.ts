import { buildApp } from '../app.js';
import { getGatewayConfig } from '../config/index.js';
import { resetV2Services } from '../lib/v2-services.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Integration harness (test doubles live ONLY here — rule 10) ─────────────
 *
 * Builds the real app with the real auth stack and signs a partner in, so route
 * tests exercise the same path a browser does: session → membership → policy →
 * service. Nothing here ships: `tsconfig.build.json` excludes this directory.
 */

export interface Partner {
  app: FastifyInstance;
  bearer: string;
  userId: string;
  organizationId: string;
  /** Headers for a read scoped to the partner's organization. */
  read(): Record<string, string>;
  /** Headers for a write; each call gets a fresh idempotency key. */
  write(extra?: Record<string, string>): Record<string, string>;
}

let keySeq = 0;
let emailSeq = 0;

/** Builds an app with a fresh store. Rate limiting off unless asked for. */
export async function buildTestApp(
  options: { rateLimit?: boolean } = {},
): Promise<FastifyInstance> {
  resetV2Services();
  return buildApp({ config: getGatewayConfig(), rateLimit: options.rateLimit ?? false });
}

/** Signs up a partner and gives them an organization to act in. */
export async function signInPartner(
  app: FastifyInstance,
  options: { email?: string; organizationSlug?: string } = {},
): Promise<Partner> {
  const email = options.email ?? `partner-${++emailSeq}-${Date.now()}@example.com`;

  const signUp = await app.inject({
    method: 'POST',
    url: '/api/v2/auth/sign-up',
    payload: { email, password: 'password12345', displayName: 'Test Partner' },
  });
  if (signUp.statusCode !== 201) {
    throw new Error(`sign-up failed (${signUp.statusCode}): ${signUp.body}`);
  }
  const session = signUp.json();
  const bearer = `Bearer ${session.accessToken}`;

  const slug = options.organizationSlug ?? `org-${++keySeq}-${Date.now()}`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/v2/partner/organizations',
    headers: { authorization: bearer, 'idempotency-key': `harness-org-${keySeq}` },
    payload: { name: 'Test Org', slug: slug.slice(0, 60) },
  });
  if (created.statusCode !== 201) {
    throw new Error(`organization create failed (${created.statusCode}): ${created.body}`);
  }
  const organizationId = created.json().id;

  return {
    app,
    bearer,
    userId: session.user.id,
    organizationId,
    read: () => ({ authorization: bearer, 'x-organization-id': organizationId }),
    write: (extra: Record<string, string> = {}) => ({
      authorization: bearer,
      'x-organization-id': organizationId,
      'idempotency-key': `test-key-${++keySeq}`,
      ...extra,
    }),
  };
}
