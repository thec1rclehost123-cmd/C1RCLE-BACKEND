/**
 * ─── Gateway entrypoint ───────────────────────────────────────────────────────
 * Reads env once (via config), builds the app, listens on :8080 (or PORT).
 */
import { buildApp } from './app.js';
import { getGatewayConfig } from './config/index.js';

async function main(): Promise<void> {
  const config = getGatewayConfig();
  const app = await buildApp({ config });

  const address = await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info({ address }, 'api-gateway listening');
}

void main().catch((error: unknown) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
