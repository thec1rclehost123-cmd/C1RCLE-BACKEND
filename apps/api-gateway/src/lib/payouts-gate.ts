import { buildV2ErrorResponse } from '@c1rcle/contracts';

import { getGatewayConfig, type GatewayConfig } from '../config/index.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Whether payout actions are switched on. An explicit `PAYOUTS_ENABLED` wins in
 * either direction; unset means on outside production and OFF in production, so
 * a production deploy that has not been explicitly approved cannot move payout
 * state by accident.
 */
export function payoutsEnabled(
  config: Pick<GatewayConfig, 'NODE_ENV' | 'PAYOUTS_ENABLED'>,
): boolean {
  return config.PAYOUTS_ENABLED ?? config.NODE_ENV !== 'production';
}

/**
 * Pre-handler for the routes that request, batch-run or release a payout. When
 * payouts are off it answers 503 and the handler never runs, so no service is
 * called and no state changes. The config is read per request, not captured at
 * registration, so the answer always reflects the current environment.
 */
export function requirePayoutsEnabled(readConfig: () => GatewayConfig = getGatewayConfig) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (payoutsEnabled(readConfig())) return;
    void reply.status(503).send(
      buildV2ErrorResponse({
        status: 503,
        code: 'server',
        message: 'Payouts are not enabled on this deployment.',
        requestId: request.id,
      }),
    );
    return reply;
  };
}
