import { createPlatformAdmin } from '@c1rcle/core/domain';

import type { AdminRole } from '@c1rcle/core/domain';

import { getGatewayConfig } from '../config/index.js';
import { createV2Services } from '../lib/v2-services.js';

/**
 * ─── Seed the first platform admin (Phase 2) ─────────────────────────────────
 *
 * Provisioning an admin through the API is a TIER3 action under dual control:
 * one admin proposes, a *different* one approves. That is deliberate — there is
 * no self-service path to platform authority — but it means the very first
 * `super` admin cannot be created through the API at all. Something has to
 * break the cycle from outside, exactly once, and this is it.
 *
 * Usage:
 *
 *   pnpm --filter api-gateway seed:admin -- --user-id <authUserId> --email <email>
 *
 * `--role` defaults to `super` (the only role that can bootstrap the rest).
 * `--user-id` must be the **Better Auth user id** of an account that already
 * exists: admin records are keyed by it, so a typo produces an admin record
 * that no session will ever match.
 *
 * Refuses to run when an active admin already exists, unless `--force` is
 * given. Bootstrapping is a one-time act; a second run is far more likely to be
 * a mistake than an intention, and quietly minting a `super` admin against a
 * live database is not a mistake worth being relaxed about.
 */

interface Args {
  userId: string;
  email: string;
  role: AdminRole;
  force: boolean;
}

const ADMIN_ROLES: readonly AdminRole[] = ['super', 'admin', 'ops', 'finance', 'support'];

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let force = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--force') {
      force = true;
      continue;
    }
    if (token?.startsWith('--')) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Missing value for ${token}`);
      }
      values.set(token.slice(2), next);
      index++;
    }
  }

  const userId = values.get('user-id');
  const email = values.get('email');
  const role = values.get('role') ?? 'super';

  if (!userId) throw new Error('--user-id is required (the Better Auth user id)');
  if (!email) throw new Error('--email is required');
  if (!ADMIN_ROLES.includes(role as AdminRole)) {
    throw new Error(`--role must be one of: ${ADMIN_ROLES.join(', ')}`);
  }
  return { userId, email, role: role as AdminRole, force };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const gateway = getGatewayConfig();

  if (gateway.STORAGE_DRIVER === 'memory') {
    // A memory-driver seed writes into a store that dies with this process —
    // it would report success and change nothing.
    throw new Error(
      'STORAGE_DRIVER=memory would seed an in-memory store that dies with this process. ' +
        'Set STORAGE_DRIVER=firestore (with credentials) to seed a real admin.',
    );
  }

  const services = createV2Services();
  const admins = services.repos().platformAdmins;

  const existing = await admins.getById(args.userId);
  if (existing?.isActive) {
    console.info(
      `Admin ${args.userId} already exists with role "${existing.role}" — nothing to do.`,
    );
    return;
  }

  if (!args.force) {
    const roster = await admins.list({ limit: 1, cursor: null });
    const active = roster.items.filter((admin) => admin.isActive);
    if (active.length > 0) {
      throw new Error(
        `${roster.total} admin(s) already exist. Provision further admins through ` +
          'the dual-control API (POST /api/v2/admin/proposals), or pass --force if ' +
          'you are certain you need to bypass it.',
      );
    }
  }

  const admin = createPlatformAdmin({ id: args.userId, email: args.email, role: args.role });
  // A previously-revoked admin keeps its version history, so the adapter's
  // compare-and-set still sees a coherent sequence.
  await admins.save(existing ? { ...admin, version: existing.version + 1 } : admin);

  await services.adminAudits().append({
    id: `seed_${Date.now()}`,
    adminId: args.userId,
    adminRole: args.role,
    action: 'ADMIN_SEED',
    targetType: 'platform_admin',
    targetId: args.userId,
    before: existing ? { role: existing.role, isActive: existing.isActive } : null,
    after: { role: args.role, isActive: true },
    // Out-of-band by definition: the audit trail should say so rather than
    // look like a normal provisioning.
    reason: 'Bootstrapped out of band via seed-platform-admin',
    occurredAt: Date.now(),
  });

  console.info(`Seeded platform admin ${args.userId} (${args.email}) with role "${args.role}".`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
