import { z } from 'zod';

/**
 * ─── Shared V2 contract primitives ─────────────────────────────────────────────
 * Base types used across all domains. Keep these stable.
 */

export const pageInfoSchema = z.object({
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  hasNextPage: z.boolean(),
});
export type PageInfo = z.infer<typeof pageInfoSchema>;

export function paginatedSchema<TItem extends z.ZodType>(itemSchema: TItem) {
  return z.object({
    items: z.array(itemSchema),
    pageInfo: pageInfoSchema,
  });
}
export interface Paginated<TItem> {
  items: TItem[];
  pageInfo: PageInfo;
}

export const noContentSchema = z.void();
export type NoContent = z.infer<typeof noContentSchema>;

/* ─── V2 error envelope (shared) ───────────────────────────────────────────── */

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

/* ─── T06 shared validation helpers ──────────────────────────────────────── */

export const opaqueIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Invalid opaque id format');
export type OpaqueId = z.infer<typeof opaqueIdSchema>;

export const cursorSchema = z.string().min(1).max(256);
export type Cursor = z.infer<typeof cursorSchema>;

export const paginationQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid Idempotency-Key format');
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

export const versionHeaderSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/, 'If-Match must be a positive integer version');
export type IfMatchVersion = z.infer<typeof versionHeaderSchema>;

export const organizationIdSchema = opaqueIdSchema;
export type OrganizationId = z.infer<typeof organizationIdSchema>;