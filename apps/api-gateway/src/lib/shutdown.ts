import type { GatewayRuntimeState } from './runtime-state.js';

export interface ShutdownApp {
  close(): Promise<unknown>;
}

export interface ShutdownLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface ShutdownController {
  shutdown(signal: string): Promise<void>;
}

/**
 * Make shutdown idempotent. The server entrypoint owns signal registration;
 * this controller owns the one-time lifecycle transition and Fastify close.
 */
export function createShutdownController(
  app: ShutdownApp,
  runtime: GatewayRuntimeState,
  logger: ShutdownLogger,
): ShutdownController {
  let shutdownPromise: Promise<void> | null = null;

  return {
    shutdown(signal: string): Promise<void> {
      if (shutdownPromise) return shutdownPromise;

      runtime.markShuttingDown();
      shutdownPromise = app
        .close()
        .then(() => {
          logger.info({ signal }, 'api-gateway shutdown complete');
        })
        .catch((error: unknown) => {
          logger.error({ signal, err: error }, 'api-gateway shutdown failed');
          throw error;
        });
      return shutdownPromise;
    },
  };
}
