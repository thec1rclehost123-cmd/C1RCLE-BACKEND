import { describe, expect, it } from 'vitest';

import { createGatewayRuntimeState } from './runtime-state.js';

describe('gateway runtime state', () => {
  it('starts ready and transitions to shutting down exactly once', () => {
    const runtime = createGatewayRuntimeState(new Date('2026-08-31T00:00:00.000Z'));

    expect(runtime.startedAt).toBe('2026-08-31T00:00:00.000Z');
    expect(runtime.isShuttingDown).toBe(false);
    expect(runtime.markShuttingDown()).toBe(true);
    expect(runtime.isShuttingDown).toBe(true);
    expect(runtime.markShuttingDown()).toBe(false);
  });
});
