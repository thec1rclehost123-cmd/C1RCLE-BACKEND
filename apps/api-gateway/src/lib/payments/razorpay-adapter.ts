import { createHash, createHmac } from 'node:crypto';

import {
  DefiniteProviderFailureError,
  InvalidOperationError,
  computeCheckoutSignature,
  safeHexEqual,
} from '@c1rcle/core/domain';

import type {
  PaymentOrderRequest,
  PaymentOrderResponse,
  PaymentVerificationRequest,
  PaymentVerificationResponse,
  RefundRequest,
  RefundResponse,
  ProviderRefund,
  ProviderOrder,
} from '@c1rcle/core/domain/ports';

interface RazorpayErrorResponse {
  error?: {
    description?: string;
    code?: string;
  };
}

interface RazorpayOrderResponse {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

interface RazorpayPaymentResponse {
  id: string;
  amount: number;
  currency: string;
  status: string;
  captured: boolean;
  /** The Razorpay order this payment was made against; null for orderless payments. */
  order_id?: string | null;
  fee?: number;
  tax?: number;
}

interface RazorpayRefundResponse {
  id: string;
  status: string;
  amount: number;
}

function isRazorpayErrorResponse(data: unknown): data is RazorpayErrorResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof (data as Record<string, unknown>).error === 'object'
  );
}

function isRazorpayOrderResponse(data: unknown): data is RazorpayOrderResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Record<string, unknown>).id === 'string' &&
    typeof (data as Record<string, unknown>).amount === 'number' &&
    typeof (data as Record<string, unknown>).currency === 'string' &&
    typeof (data as Record<string, unknown>).status === 'string'
  );
}

function isRazorpayPaymentResponse(data: unknown): data is RazorpayPaymentResponse {
  if (
    !isRazorpayOrderResponse(data) ||
    typeof (data as unknown as Record<string, unknown>).captured !== 'boolean'
  ) {
    return false;
  }
  const payment = data as unknown as Record<string, unknown>;
  return (
    (payment.fee === undefined || typeof payment.fee === 'number') &&
    (payment.tax === undefined || typeof payment.tax === 'number') &&
    (payment.status !== 'captured' ||
      (typeof payment.fee === 'number' && typeof payment.tax === 'number'))
  );
}

function isRazorpayRefundResponse(data: unknown): data is RazorpayRefundResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Record<string, unknown>).id === 'string' &&
    typeof (data as Record<string, unknown>).status === 'string' &&
    typeof (data as Record<string, unknown>).amount === 'number'
  );
}

function isDefiniteRefundRejection(
  status: number,
  data: unknown,
): data is { error: { code: 'BAD_REQUEST_ERROR'; description: string } } {
  // Fail closed on server/transport errors, in-flight conflicts and unknown
  // responses. A non-2xx status alone does not prove that no refund was accepted.
  if (![400, 401, 403, 404, 422].includes(status)) return false;
  if (typeof data !== 'object' || data === null) return false;
  const error = (data as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null) return false;
  const fields = error as Record<string, unknown>;
  return (
    fields.code === 'BAD_REQUEST_ERROR' &&
    typeof fields.description === 'string' &&
    fields.description.trim().length > 0
  );
}

function isRazorpayErrorResponseData(data: unknown): data is RazorpayErrorResponse {
  return isRazorpayErrorResponse(data);
}

function isRazorpayErrorResponseDataWithDescription(
  data: unknown,
): data is RazorpayErrorResponse & { error: { description: string } } {
  return (
    isRazorpayErrorResponseData(data) &&
    data.error !== undefined &&
    typeof data.error.description === 'string'
  );
}

/**
 * Razorpay ids are a `prefix_` token plus an alphanumeric body — `pay_…`,
 * `order_…`, `rfnd_…`, `cust_…`. Allowing only that shape is what makes an id
 * safe to interpolate into a request path: it cannot contain `/`, `.`, `\`, a
 * scheme separator, a query or fragment delimiter, or a newline, so it cannot
 * climb out of `/payments/` or repoint the request at another host.
 *
 * The id arrives here straight from the client on the redirect-confirm path, so
 * it is untrusted. `checkout-service.ts` already declines to trust it for the
 * money decision; this keeps it from being trusted for the request shape either.
 *
 * The error message deliberately does not echo the rejected value, so a hostile
 * id cannot smuggle newlines or terminal escapes into logs or error responses.
 */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

function assertProviderId(value: string, field: string): string {
  if (!PROVIDER_ID_PATTERN.test(value)) {
    throw new InvalidOperationError(`Invalid Razorpay ${field}`);
  }
  return value;
}

/**
 * ─── Razorpay PaymentProvider Adapter ──────────────────────────────────────────
 * Implements the PaymentProvider interface using Razorpay API.
 * Webhook HMAC verification is NOT optional (D-022).
 */
export class RazorpayPaymentProvider {
  constructor(
    private readonly config: {
      keyId: string;
      keySecret: string;
      webhookSecret: string;
      baseUrl?: string;
      requestTimeoutMs?: number;
    },
  ) {}

  private get baseUrl(): string {
    return this.config.baseUrl ?? 'https://api.razorpay.com/v1';
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64')}`;
  }

  async createOrder(request: PaymentOrderRequest): Promise<PaymentOrderResponse> {
    const response = await fetch(`${this.baseUrl}/orders`, {
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(this.config.requestTimeoutMs ?? 10_000, 10_000)),
      ),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
      },
      body: JSON.stringify({
        amount: request.amountPaise,
        currency: request.currency,
        receipt: request.idempotencyKey,
        notes: request.metadata,
      }),
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: { description: 'Unknown error' } }));
      if (!isRazorpayErrorResponseDataWithDescription(error)) {
        throw new InvalidOperationError(`Razorpay create order failed: ${response.statusText}`);
      }
      throw new InvalidOperationError(`Razorpay create order failed: ${error.error.description}`);
    }

    const data = await response.json();
    if (!isRazorpayOrderResponse(data)) {
      throw new InvalidOperationError('Invalid Razorpay order response');
    }
    // The amount the guest will be charged is whatever the provider order says.
    // If it ever differs from what we asked for, fail here rather than let the
    // guest pay a total the server never quoted.
    if (data.amount !== request.amountPaise || data.currency !== request.currency) {
      throw new InvalidOperationError('Razorpay order does not match the requested amount');
    }
    return {
      id: data.id,
      amountPaise: data.amount,
      currency: data.currency,
      status: data.status,
    };
  }

  /** Razorpay documents GET /orders?receipt=...; no create POST is used here. */
  async findOrdersByReceipt(receipt: string): Promise<ProviderOrder[]> {
    if (!receipt || receipt.length > 40)
      throw new InvalidOperationError('Invalid provider receipt');
    const response = await fetch(
      `${this.baseUrl}/orders?${new URLSearchParams({ receipt, count: '2' })}`,
      {
        method: 'GET',
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(this.config.requestTimeoutMs ?? 10_000, 10_000)),
        ),
        headers: { Authorization: this.authHeader },
      },
    );
    if (!response.ok) throw new InvalidOperationError('Razorpay order lookup unavailable');
    const data: unknown = await response.json();
    if (
      !data ||
      typeof data !== 'object' ||
      !('items' in data) ||
      !Array.isArray(data.items) ||
      !('count' in data) ||
      data.count !== data.items.length ||
      data.items.length > 2
    ) {
      throw new InvalidOperationError('Invalid Razorpay order lookup response');
    }
    return data.items.map((item: unknown) => {
      if (
        !isRazorpayOrderResponse(item) ||
        !('receipt' in item) ||
        item.receipt !== receipt ||
        !('notes' in item) ||
        !item.notes ||
        typeof item.notes !== 'object' ||
        Array.isArray(item.notes) ||
        Object.values(item.notes).some((value) => typeof value !== 'string')
      ) {
        throw new InvalidOperationError('Invalid Razorpay order identity');
      }
      return {
        id: item.id,
        amountPaise: item.amount,
        currency: item.currency,
        status: item.status,
        receipt,
        metadata: item.notes as Record<string, string>,
      };
    });
  }

  async verifyPayment(request: PaymentVerificationRequest): Promise<PaymentVerificationResponse> {
    // HMAC verification is NOT optional (D-022). `safeHexEqual` never throws on
    // a wrong-length signature, so a forged one is a clean 4xx, not a 500.
    const expectedSignature = this.generateSignature({
      paymentId: request.paymentId,
      orderId: request.orderId,
    });

    if (!safeHexEqual(expectedSignature, request.signature)) {
      throw new InvalidOperationError('Invalid payment signature');
    }

    const payment = await this.getPayment(request.paymentId);
    if (!payment) throw new InvalidOperationError('Payment not found');
    return payment;
  }

  async capturePayment(
    paymentId: string,
    amountPaise?: number,
  ): Promise<PaymentVerificationResponse> {
    const id = assertProviderId(paymentId, 'payment id');
    const response = await fetch(`${this.baseUrl}/payments/${id}/capture`, {
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(this.config.requestTimeoutMs ?? 10_000, 10_000)),
      ),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
      },
      body: amountPaise ? JSON.stringify({ amount: amountPaise }) : undefined,
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: { description: 'Unknown error' } }));
      if (!isRazorpayErrorResponseDataWithDescription(error)) {
        throw new InvalidOperationError(`Razorpay capture failed: ${response.statusText}`);
      }
      throw new InvalidOperationError(`Razorpay capture failed: ${error.error.description}`);
    }

    const data = await response.json();
    if (!isRazorpayPaymentResponse(data)) {
      throw new InvalidOperationError('Invalid Razorpay payment response');
    }
    return {
      verified: data.status === 'captured',
      paymentId: data.id,
      amountPaise: data.amount,
      captured: data.status === 'captured',
      orderId: data.order_id ?? null,
      currency: data.currency,
      feePaise: data.fee,
      taxOnFeePaise: data.tax,
    };
  }

  async refundPayment(request: RefundRequest): Promise<RefundResponse> {
    const id = assertProviderId(request.paymentId, 'payment id');
    if (!request.idempotencyKey.trim())
      throw new InvalidOperationError('Refund requires a canonical idempotency key');
    // Razorpay's refund idempotency header permits only alphanumerics, '-' and
    // '_'. Preserve the canonical receipt used by provider-fact reconciliation.
    const providerKey = `c1r_${createHash('sha256').update(request.idempotencyKey).digest('hex')}`;
    const response = await fetch(`${this.baseUrl}/payments/${id}/refund`, {
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(this.config.requestTimeoutMs ?? 10_000, 10_000)),
      ),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
        'X-Refund-Idempotency': providerKey,
      },
      body: JSON.stringify({
        amount: request.amountPaise,
        receipt: request.idempotencyKey,
      }),
    });

    if (!response.ok) {
      const error: unknown = await response.json().catch(() => null);
      if (isDefiniteRefundRejection(response.status, error)) {
        throw new DefiniteProviderFailureError(
          `Razorpay refund was rejected: ${error.error.description}`,
        );
      }
      throw new InvalidOperationError('Razorpay refund result is uncertain');
    }

    const data = await response.json();
    if (!isRazorpayRefundResponse(data)) {
      throw new InvalidOperationError('Invalid Razorpay refund response');
    }
    return {
      id: data.id,
      status: data.status,
      amountPaise: data.amount,
    };
  }

  async getRefund(paymentId: string, refundId: string): Promise<ProviderRefund> {
    const payment = assertProviderId(paymentId, 'payment id');
    const refund = assertProviderId(refundId, 'refund id');
    const response = await fetch(`${this.baseUrl}/payments/${payment}/refunds/${refund}`, {
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(this.config.requestTimeoutMs ?? 10_000, 10_000)),
      ),
      headers: { Authorization: this.authHeader },
    });
    // Missing, failed or malformed lookups do not prove refund failure/absence.
    if (!response.ok) throw new InvalidOperationError('Unable to establish provider refund fact');
    const data: unknown = await response.json();
    if (!isRazorpayRefundResponse(data)) {
      throw new InvalidOperationError('Invalid provider refund fact');
    }
    const fact = data as unknown as Record<string, unknown>;
    if (
      data.id !== refund ||
      fact.payment_id !== payment ||
      !Number.isSafeInteger(data.amount) ||
      data.amount <= 0 ||
      !['pending', 'processed', 'failed'].includes(data.status) ||
      typeof fact.currency !== 'string' ||
      !(fact.receipt === null || typeof fact.receipt === 'string')
    )
      throw new InvalidOperationError('Invalid provider refund fact');
    return {
      id: data.id,
      status: data.status,
      amountPaise: data.amount,
      paymentId: payment,
      currency: fact.currency,
      receipt: fact.receipt,
    };
  }

  async getPayment(paymentId: string): Promise<PaymentVerificationResponse> {
    const id = assertProviderId(paymentId, 'payment id');
    const response = await fetch(`${this.baseUrl}/payments/${id}`, {
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(this.config.requestTimeoutMs ?? 10_000, 10_000)),
      ),
      headers: {
        Authorization: this.authHeader,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new InvalidOperationError('Payment not found');
      }
      const error = await response
        .json()
        .catch(() => ({ error: { description: 'Unknown error' } }));
      if (!isRazorpayErrorResponseDataWithDescription(error)) {
        throw new InvalidOperationError(`Razorpay get payment failed: ${response.statusText}`);
      }
      throw new InvalidOperationError(`Razorpay get payment failed: ${error.error.description}`);
    }

    const data = await response.json();
    if (!isRazorpayPaymentResponse(data)) {
      throw new InvalidOperationError('Invalid Razorpay payment response');
    }
    return {
      verified: data.status === 'captured',
      paymentId: data.id,
      amountPaise: data.amount,
      captured: data.status === 'captured',
      orderId: data.order_id ?? null,
      currency: data.currency,
      feePaise: data.fee,
      taxOnFeePaise: data.tax,
    };
  }

  /**
   * Checkout-callback signature: HMAC-SHA256 of `order_id|payment_id` keyed by
   * the API **key secret** (what Razorpay documents). This used to sign a sorted
   * `key=value&...` string with the *webhook* secret, so a genuine payment's
   * callback could never verify. See `computeCheckoutSignature`.
   */
  generateSignature(payload: { paymentId: string; orderId: string }): string {
    return computeCheckoutSignature({ ...payload, keySecret: this.config.keySecret });
  }

  /**
   * Verifies webhook signature from raw body and signature header.
   * Uses timingSafeEqual to prevent timing attacks.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expectedSignature = createHmac('sha256', this.config.webhookSecret)
      .update(rawBody)
      .digest('hex');
    return safeHexEqual(expectedSignature, signature);
  }
}
