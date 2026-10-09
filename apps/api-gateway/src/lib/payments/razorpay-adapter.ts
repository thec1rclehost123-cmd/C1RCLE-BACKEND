import { createHmac } from 'node:crypto';

import { InvalidOperationError, computeCheckoutSignature, safeHexEqual } from '@c1rcle/core/domain';

import type {
  PaymentOrderRequest,
  PaymentOrderResponse,
  PaymentVerificationRequest,
  PaymentVerificationResponse,
  RefundRequest,
  RefundResponse,
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
  return (
    isRazorpayOrderResponse(data) &&
    typeof (data as unknown as Record<string, unknown>).captured === 'boolean'
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
    };
  }

  async refundPayment(request: RefundRequest): Promise<RefundResponse> {
    const id = assertProviderId(request.paymentId, 'payment id');
    const response = await fetch(`${this.baseUrl}/payments/${id}/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
      },
      body: JSON.stringify({
        amount: request.amountPaise,
        receipt: request.idempotencyKey,
      }),
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: { description: 'Unknown error' } }));
      if (!isRazorpayErrorResponseDataWithDescription(error)) {
        throw new InvalidOperationError(`Razorpay refund failed: ${response.statusText}`);
      }
      throw new InvalidOperationError(`Razorpay refund failed: ${error.error.description}`);
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

  async getPayment(paymentId: string): Promise<PaymentVerificationResponse> {
    const id = assertProviderId(paymentId, 'payment id');
    const response = await fetch(`${this.baseUrl}/payments/${id}`, {
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
