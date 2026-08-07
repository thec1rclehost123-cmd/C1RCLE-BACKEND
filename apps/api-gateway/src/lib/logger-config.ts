/**
 * ─── Logger security configuration ───────────────────────────────────────────
 * Pino `redact` paths for the gateway logger. Centralized so the redaction
 * guarantee is testable and stays in sync when headers/plugins change.
 *
 * Guard rule: anything secret (tokens, cookies, API keys, payment/webhook
 * secrets) MUST be listed here before it can be logged.
 */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  // Payment + webhook secrets travelling in request/response bodies
  '*.razorpay_signature',
  '*.razorpay_payment_id',
  '*.secret',
  // Auth bootstrap + session material
  '*idToken*',
  '*refreshToken*',
];

export interface LogFieldNames {
  requestId: string;
  userId: string;
  organizationId: string;
  clientIp: string;
  route: string;
  method: string;
  statusCode: string;
  durationMs: string;
}

/** Stable mapping of canonical log field names (contract for observability). */
export const logFieldNames: LogFieldNames = {
  requestId: 'requestId',
  userId: 'userId',
  organizationId: 'organizationId',
  clientIp: 'clientIp',
  route: 'route',
  method: 'method',
  statusCode: 'statusCode',
  durationMs: 'durationMs',
};
