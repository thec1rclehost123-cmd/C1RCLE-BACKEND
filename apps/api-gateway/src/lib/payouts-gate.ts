import { buildV2ErrorResponse } from '@c1rcle/contracts';

import { getGatewayConfig, type GatewayConfig } from '../config/index.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Payout actions require explicit authorization in every environment.
 * Unset or undefined configuration must never enable money movement.
 */
export function payoutsEnabled(
  config: Pick<GatewayConfig, 'NODE_ENV'> & { PAYOUTS_ENABLED?: boolean | undefined },
): boolean {
  return config.PAYOUTS_ENABLED === true;
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
