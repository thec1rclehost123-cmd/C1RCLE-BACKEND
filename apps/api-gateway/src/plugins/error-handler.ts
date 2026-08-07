import { buildV2ErrorResponse, errorCodeForStatus } from '@c1rcle/contracts';
import {
  DomainError,
  OrganizationNotFoundError,
  VenueNotFoundError,
  EventNotFoundError,
  SlotRequestNotFoundError,
  TicketTierNotFoundError,
  PromoterAssignmentNotFoundError,
  ForbiddenError,
  VersionConflictError,
  StateTransitionError,
  InvalidOperationError,
} from '@c1rcle/core/domain';

import type { ApiErrorCode } from '@c1rcle/contracts';
import type { Logger } from '@c1rcle/core';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Maps a DomainError to (status, code, message).
 * Anything unhandled falls through to a generic 500.
 */
export function mapDomainError(error: DomainError): {
  status: number;
  code: ApiErrorCode;
} {
  if (error instanceof ForbiddenError) return { status: 403, code: 'forbidden' };
  if (error instanceof VersionConflictError) return { status: 409, code: 'conflict' };
  if (
    error instanceof OrganizationNotFoundError ||
    error instanceof VenueNotFoundError ||
    error instanceof EventNotFoundError ||
    error instanceof SlotRequestNotFoundError ||
    error instanceof TicketTierNotFoundError ||
    error instanceof PromoterAssignmentNotFoundError
  ) {
    return { status: 404, code: 'not_found' };
  }
  if (error instanceof StateTransitionError) return { status: 409, code: 'conflict' };
  if (error instanceof InvalidOperationError) return { status: 400, code: 'validation' };
  return { status: 500, code: 'server' };
}

/**
 * Fastify error handler: serializes errors into the canonical V2 envelope
 * `{ status, code, message, requestId, fieldErrors? }` and redacts internals.
 */
export function errorHandler(
  logger: Logger,
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const requestId = request.id ?? '';

  if (error instanceof DomainError) {
    const mapped = mapDomainError(error);
    const body = buildV2ErrorResponse({
      status: mapped.status,
      code: mapped.code,
      message: error.message,
      requestId,
    });
    // 5xx must never leak the internal message to clients.
    if (mapped.status >= 500) {
      logger.error('unhandled_domain_error', {
        requestId,
        code: error.code,
        message: error.message,
      });
      body.message = 'Internal server error';
    } else {
      logger.warn('domain_error', { requestId, code: error.code });
    }
    void reply.status(mapped.status).send({ error: body });
    return;
  }

  // Fastify native errors (validation, notFound) come with statusCode.
  const raw = error as { statusCode?: number; validation?: unknown; message?: string };
  const status = raw.statusCode ?? 500;
  if (status >= 500) {
    logger.error('unhandled_error', {
      requestId,
      message: raw.message ?? 'Internal server error',
    });
  }
  const body = buildV2ErrorResponse({
    status,
    code: status >= 500 ? 'server' : errorCodeForStatus(status),
    message: status >= 500 ? 'Internal server error' : (raw.message ?? 'Request failed'),
    requestId,
  });
  void reply.status(status).send({ error: body });
}
