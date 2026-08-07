/**
 * ─── Logger port ───────────────────────────────────────────────────────────────
 * Domain/application layers depend on this interface, never on pino directly.
 * The gateway adapts its pino logger; infra adapters implement it.
 * Default: `noopLogger` (silent).
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Silent no-op logger — safe default for tests and minimal contexts. */
export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Wraps a pino-style logger into the `Logger` port. */
export function createLogger(backend: {
  info(msg: string, obj?: Record<string, unknown>): void;
  warn(msg: string, obj?: Record<string, unknown>): void;
  error(msg: string, obj?: Record<string, unknown>): void;
}): Logger {
  return {
    info: (message, fields) => {
      backend.info(message, fields);
    },
    warn: (message, fields) => {
      backend.warn(message, fields);
    },
    error: (message, fields) => {
      backend.error(message, fields);
    },
  };
}
