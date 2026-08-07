/**
 * ─── Standard error envelope (V1 + V2) ──────────────────────────────────────
 * Ported from thec1rcle api-gateway `lib/api-contracts.ts` (frozen, tested).
 * Single home of the success/error envelope for every API response.
 */

export type ApiErrorCode =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'parse'
  | 'unknown'
  | 'server';

export type FieldErrors = Record<string, string[]>;

export type RequestId = string;

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  status: number;
  requestId?: string;
  fieldErrors?: FieldErrors;
  details?: unknown;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: { path: string; message: string }[] | Record<string, unknown> | null;
  requestId?: string;
}

export interface StandardErrorResponse {
  success: false;
  error: ApiErrorPayload;
}

export function buildErrorResponse(payload: ApiErrorPayload): StandardErrorResponse {
  const error: ApiErrorPayload = {
    code: payload.code,
    message: payload.message,
  };

  if (payload.details && (Array.isArray(payload.details) ? payload.details.length > 0 : true)) {
    error.details = payload.details;
  }

  if (payload.requestId) {
    error.requestId = payload.requestId;
  }

  return { success: false, error };
}

/**
 * Wraps a payload in the canonical success envelope. All existing top-level
 * fields from `data` are also spread at the root for backward compatibility
 * with clients that consumed the flat shape.
 */
export function buildSuccessResponse<T extends Record<string, unknown>>(
  data: T,
): { success: true; data: T } & T {
  return { success: true, data, ...data };
}

export function buildValidationDetails(
  issues: { path?: (string | number)[]; message: string }[] = [],
) {
  return issues.map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.join('.') : '',
    message: issue.message,
  }));
}

/* ─── V2 API error contract (additive layer) ─────────────────────────────── */

/** Locked status → code table. */
export const STATUS_CODE_TO_ERROR_CODE: Readonly<Partial<Record<number, ApiErrorCode>>> = {
  400: 'validation',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'validation',
  429: 'rate_limited',
};

export function errorCodeForStatus(status: number): ApiErrorCode {
  const mapped = STATUS_CODE_TO_ERROR_CODE[status];
  if (mapped) return mapped;
  return status >= 500 ? 'server' : 'unknown';
}

export interface V2ErrorBody extends ApiError {
  status: number;
}

export function buildV2ErrorResponse(input: {
  status: number;
  message: string;
  code?: ApiErrorCode;
  requestId?: RequestId;
  fieldErrors?: FieldErrors;
  details?: unknown;
}): V2ErrorBody {
  const error: V2ErrorBody = {
    status: input.status,
    code: input.code ?? errorCodeForStatus(input.status),
    message: input.message,
  };
  if (input.requestId) error.requestId = input.requestId;
  if (input.fieldErrors && Object.keys(input.fieldErrors).length > 0) {
    error.fieldErrors = input.fieldErrors;
  }
  if (input.details !== undefined) error.details = input.details;
  return error;
}

/** Lodash-free flatten of a zod error into `{ field: string[] }`. */
export function zodToFieldErrors(error: {
  issues: { path: PropertyKey[] | string; message: string }[];
}): FieldErrors {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues ?? []) {
    const key =
      Array.isArray(issue.path) && issue.path.length > 0
        ? issue.path.join('.')
        : String(issue.path) || '_root';
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}
