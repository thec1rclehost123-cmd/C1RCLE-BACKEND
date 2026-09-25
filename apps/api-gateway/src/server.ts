/**
 * ─── Gateway entrypoint ───────────────────────────────────────────────────────
 * Reads env once (via config), builds the app, listens on :8080 (or PORT).
 */
import { createPlatformAdmin } from '@c1rcle/core/domain';

import { buildApp } from './app.js';
import { getGatewayConfig } from './config/index.js';
import { createGatewayRuntimeState } from './lib/runtime-state.js';
import { createShutdownController } from './lib/shutdown.js';
import { createV2Services } from './lib/v2-services.js';

/**
 * Dev-only bootstrap so a fresh `STORAGE_DRIVER=memory` boot has a platform
 * admin to click through the console with — provisioning is normally TIER3
 * dual control (see `scripts/seed-platform-admin.ts`), which is exactly the
 * chicken-and-egg problem a real deploy solves out of band. Same gate as
 * `v2-services.ts`'s `actorFromRequest` fabrication (`NODE_ENV !==
 * 'production' && STORAGE_DRIVER === 'memory'`), so this never runs against
 * anything but a disposable in-memory store, and seeds the same `user_1` id
 * that fabrication defaults to when no `x-user-id` header is sent.
 */
async function seedDevAdmin(config: ReturnType<typeof getGatewayConfig>): Promise<void> {
  if (config.NODE_ENV === 'production' || config.STORAGE_DRIVER !== 'memory') return;
  const services = createV2Services();
  const admins = services.repos().platformAdmins;
  // A second seeded admin so dual-control (propose/approve, TIER3) can be
  // exercised locally without the propose→approve→provision bootstrap
  // problem the real seed script exists to solve.
  for (const id of ['user_1', 'user_2']) {
    const existing = await admins.getById(id);
    if (existing?.isActive) continue;
    await admins.save(createPlatformAdmin({ id, email: `${id}@c1rcle.test`, role: 'super' }));
    console.info(`[dev] seeded platform admin "${id}" (role: super) — memory driver only`);
  }
}

async function main(): Promise<void> {
  const config = getGatewayConfig();
  const runtimeState = createGatewayRuntimeState();
  const app = await buildApp({ config, runtimeState });
  await seedDevAdmin(config);

  const shutdown = createShutdownController(app, runtimeState, app.log);
  const onSignal = (signal: string) => {
    void shutdown.shutdown(signal).catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  const address = await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info({ address }, 'api-gateway listening');
}

void main().catch((error: unknown) => {
  console.error('Fatal startup error:', error);
  process.exitCode = 1;
});
