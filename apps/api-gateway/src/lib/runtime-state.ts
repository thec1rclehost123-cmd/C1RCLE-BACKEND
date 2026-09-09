/**
 * Process lifecycle state shared by readiness and the server shutdown path.
 *
 * This intentionally owns only gateway lifecycle state. Database, Redis,
 * worker, and WebSocket cleanup remain with the components that actually own
 * those resources; the current gateway does not expose close handles for
 * them yet.
 */
export interface GatewayRuntimeState {
  readonly startedAt: string;
  readonly isShuttingDown: boolean;
  markShuttingDown(): boolean;
}

export function createGatewayRuntimeState(startedAt = new Date()): GatewayRuntimeState {
  let shuttingDown = false;
  const startedAtIso = startedAt.toISOString();

  return {
    startedAt: startedAtIso,
    get isShuttingDown() {
      return shuttingDown;
    },
    markShuttingDown() {
      if (shuttingDown) return false;
      shuttingDown = true;
      return true;
    },
  };
}
