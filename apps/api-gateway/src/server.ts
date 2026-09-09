/**
 * ─── Gateway entrypoint ───────────────────────────────────────────────────────
 * Reads env once (via config), builds the app, listens on :8080 (or PORT).
 */
import { buildApp } from './app.js';
import { getGatewayConfig } from './config/index.js';
import { createGatewayRuntimeState } from './lib/runtime-state.js';
import { createShutdownController } from './lib/shutdown.js';

async function main(): Promise<void> {
  const config = getGatewayConfig();
  const runtimeState = createGatewayRuntimeState();
  const app = await buildApp({ config, runtimeState });

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
