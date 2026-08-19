import { createHmac, timingSafeEqual } from 'node:crypto';

import { InvalidOperationError } from '../../domain/errors.js';

import type {
  PaymentProvider,
  PaymentOrderRequest,
  PaymentOrderResponse,
  PaymentVerificationRequest,
  PaymentVerificationResponse,
  RefundRequest,
  RefundResponse,
} from '../payments/payment-provider.js';

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
}

interface RazorpayRefundResponse {
  id: string;
  status: string;
  amount: number;
}

/**
 * ─── Razorpay PaymentProvider Adapter ──────────────────────────────────────────
 * Implements the PaymentProvider interface using Razorpay API.
 * Webhook HMAC verification is NOT optional (D-022).
 */
export class RazorpayPaymentProvider implements PaymentProvider {
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
      const error = (await response
        .json()
        .catch(() => ({ error: { description: 'Unknown error' } }))) as RazorpayErrorResponse;
      throw new InvalidOperationError(
        `Razorpay create order failed: ${error.error?.description ?? response.statusText}`,
      );
    }

    const data = (await response.json()) as RazorpayOrderResponse;
    return {
      id: data.id,
      amountPaise: data.amount,
      currency: data.currency,
      status: data.status,
    };
  }

  async verifyPayment(request: PaymentVerificationRequest): Promise<PaymentVerificationResponse> {
    // HMAC verification is NOT optional (D-022)
    const expectedSignature = this.generateSignature({
      paymentId: request.paymentId,
      orderId: request.orderId,
    });

    if (!timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(request.signature))) {
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
    const url = `${this.baseUrl}/payments/${paymentId}/capture`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
      },
      body: amountPaise ? JSON.stringify({ amount: amountPaise }) : undefined,
    });

    if (!response.ok) {
      const error = (await response
        .json()
        .catch(() => ({ error: { description: 'Unknown error' } }))) as RazorpayErrorResponse;
      throw new InvalidOperationError(
        `Razorpay capture failed: ${error.error?.description ?? response.statusText}`,
      );
    }

    const data = (await response.json()) as RazorpayPaymentResponse;
    return {
      verified: data.status === 'captured',
      paymentId: data.id,
      amountPaise: data.amount,
      captured: data.status === 'captured',
    };
  }

  async refundPayment(request: RefundRequest): Promise<RefundResponse> {
    const response = await fetch(`${this.baseUrl}/payments/${request.paymentId}/refund`, {
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
      const error = (await response
        .json()
        .catch(() => ({ error: { description: 'Unknown error' } }))) as RazorpayErrorResponse;
      throw new InvalidOperationError(
        `Razorpay refund failed: ${error.error?.description ?? response.statusText}`,
      );
    }

    const data = (await response.json()) as RazorpayRefundResponse;
    return {
      id: data.id,
      status: data.status,
      amountPaise: data.amount,
    };
  }

  async getPayment(paymentId: string): Promise<PaymentVerificationResponse> {
    const response = await fetch(`${this.baseUrl}/payments/${paymentId}`, {
      headers: {
        Authorization: this.authHeader,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new InvalidOperationError('Payment not found');
      }
      const error = (await response
        .json()
        .catch(() => ({ error: { description: 'Unknown error' } }))) as RazorpayErrorResponse;
      throw new InvalidOperationError(
        `Razorpay get payment failed: ${error.error?.description ?? response.statusText}`,
      );
    }

    const data = (await response.json()) as RazorpayPaymentResponse;
    return {
      verified: data.status === 'captured',
      paymentId: data.id,
      amountPaise: data.amount,
      captured: data.status === 'captured',
    };
  }

  /**
   * Generates HMAC-SHA256 signature for webhook verification.
   * Uses deterministic JSON.stringify (D-022).
   */
  generateSignature(payload: { paymentId: string; orderId: string }): string {
    // Deterministic stringification: sort keys for consistency
    const sortedKeys = Object.keys(payload).sort();
    const canonical = sortedKeys.map((k) => `${k}=${payload[k as keyof typeof payload]}`).join('&');
    return createHmac('sha256', this.config.webhookSecret).update(canonical).digest('hex');
  }

  /**
   * Verifies webhook signature from raw body and signature header.
   * Uses timingSafeEqual to prevent timing attacks.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expectedSignature = createHmac('sha256', this.config.webhookSecret)
      .update(rawBody)
      .digest('hex');
    return timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));
  }
}
