import { describe, expect, it, vi } from 'vitest';

import { createGatewayRuntimeState } from './runtime-state.js';
import { createShutdownController } from './shutdown.js';

describe('gateway shutdown controller', () => {
  it('marks readiness false and closes the app once for repeated signals', async () => {
    const close = vi.fn(async () => undefined);
    const logger = { info: vi.fn(), error: vi.fn() };
    const runtime = createGatewayRuntimeState();
    const controller = createShutdownController({ close }, runtime, logger);

    await Promise.all([controller.shutdown('SIGTERM'), controller.shutdown('SIGINT')]);

    expect(runtime.isShuttingDown).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { signal: 'SIGTERM' },
      'api-gateway shutdown complete',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs and rethrows close failures', async () => {
    const failure = new Error('close failed');
    const close = vi.fn(async () => {
      throw failure;
    });
    const logger = { info: vi.fn(), error: vi.fn() };
    const controller = createShutdownController({ close }, createGatewayRuntimeState(), logger);

    await expect(controller.shutdown('SIGTERM')).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledWith(
      { signal: 'SIGTERM', err: failure },
      'api-gateway shutdown failed',
    );
  });
});
