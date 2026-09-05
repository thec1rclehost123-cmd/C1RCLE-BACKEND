import { createHmac, timingSafeEqual } from 'node:crypto';

import { InvalidOperationError } from '../errors.js';

/**
 * ─── PaymentProvider Port (Phase 4) ────────────────────────────────────────────
 * Pluggable interface for payment gateways (Razorpay, Stripe, etc.).
 * Mirrors v1's provider abstraction pattern.
 * The webhook HMAC verification is NOT optional and needs its own tests.
 */

export interface PaymentOrderRequest {
  amountPaise: number;
  currency: string;
  idempotencyKey: string;
  metadata: Record<string, string>;
}

export interface PaymentOrderResponse {
  id: string;
  amountPaise: number;
  currency: string;
  status: string;
}

export interface PaymentVerificationRequest {
  paymentId: string;
  orderId: string;
  signature: string;
}

export interface PaymentVerificationResponse {
  verified: boolean;
  paymentId: string;
  amountPaise: number;
  captured: boolean;
}

export interface RefundRequest {
  paymentId: string;
  amountPaise?: number; // partial refund if specified
  idempotencyKey: string;
}

export interface RefundResponse {
  id: string;
  status: string;
  amountPaise: number;
}

export interface PaymentProvider {
  /**
   * Creates a payment order with the provider (e.g., Razorpay order).
   * Must be idempotent via idempotencyKey.
   */
  createOrder(request: PaymentOrderRequest): Promise<PaymentOrderResponse>;

  /**
   * Verifies a payment signature (webhook or redirect).
   * HMAC verification is NOT optional.
   */
  verifyPayment(request: PaymentVerificationRequest): Promise<PaymentVerificationResponse>;

  /**
   * Captures a payment (for delayed capture flows).
   */
  capturePayment(paymentId: string, amountPaise?: number): Promise<PaymentVerificationResponse>;

  /**
   * Initiates a refund.
   */
  refundPayment(request: RefundRequest): Promise<RefundResponse>;

  /**
   * Gets payment details.
   */
  getPayment(paymentId: string): Promise<PaymentVerificationResponse | null>;
}

/**
 * ─── MemoryPaymentProvider ──────────────────────────────────────────────────
 * The `STORAGE_DRIVER=memory` adapter for `PaymentProvider` — same role as
 * every other memory adapter in this codebase (`EchoObjectStorage`,
 * `Memory*Repository`): a real, shipped implementation with no I/O, selected
 * at runtime, never a fetch call. Without this, `pnpm test` / CI would have
 * no way to exercise checkout/payments without a live Razorpay account,
 * which every other Phase 4 port already avoids.
 *
 * Mirrors the real Razorpay adapter's signature scheme exactly (HMAC-SHA256
 * over a deterministic `key=value&...` canonicalization of the sorted
 * payload, `timingSafeEqual` comparison) so route/webhook tests exercise the
 * genuine signature-verification code path, not a bypass — only the
 * network call is simulated, never the security check.
 */
export class MemoryPaymentProvider implements PaymentProvider {
  private readonly orders = new Map<string, PaymentOrderResponse>();
  private readonly payments = new Map<string, PaymentVerificationResponse>();

  constructor(private readonly webhookSecret: string) {}

  generateSignature(payload: { paymentId: string; orderId: string }): string {
    const sortedKeys = Object.keys(payload).sort() as (keyof typeof payload)[];
    const canonical = sortedKeys.map((k) => `${k}=${payload[k]}`).join('&');
    return createHmac('sha256', this.webhookSecret).update(canonical).digest('hex');
  }

  async createOrder(request: PaymentOrderRequest): Promise<PaymentOrderResponse> {
    const id = `order_mem_${request.idempotencyKey}`;
    const existing = this.orders.get(id);
    if (existing) return existing;
    const order: PaymentOrderResponse = {
      id,
      amountPaise: request.amountPaise,
      currency: request.currency,
      status: 'created',
    };
    this.orders.set(id, order);
    return order;
  }

  async verifyPayment(request: PaymentVerificationRequest): Promise<PaymentVerificationResponse> {
    const expected = this.generateSignature({
      paymentId: request.paymentId,
      orderId: request.orderId,
    });
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(request.signature, 'utf8');
    const signatureValid =
      expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
    if (!signatureValid) throw new InvalidOperationError('Invalid payment signature');

    const payment = await this.getPayment(request.paymentId);
    if (!payment) throw new InvalidOperationError('Payment not found');
    return payment;
  }

  async capturePayment(
    paymentId: string,
    amountPaise?: number,
  ): Promise<PaymentVerificationResponse> {
    const existing = this.payments.get(paymentId);
    const captured: PaymentVerificationResponse = {
      verified: true,
      paymentId,
      amountPaise: amountPaise ?? existing?.amountPaise ?? 0,
      captured: true,
    };
    this.payments.set(paymentId, captured);
    return captured;
  }

  async refundPayment(request: RefundRequest): Promise<RefundResponse> {
    const payment = this.payments.get(request.paymentId);
    return {
      id: `rfnd_mem_${request.idempotencyKey}`,
      status: 'processed',
      amountPaise: request.amountPaise ?? payment?.amountPaise ?? 0,
    };
  }

  async getPayment(paymentId: string): Promise<PaymentVerificationResponse | null> {
    return this.payments.get(paymentId) ?? null;
  }

  /**
   * Test/seed-only hook: simulates "the guest completed checkout at the
   * provider's hosted page and the payment is now captured" — the one thing
   * a memory adapter cannot derive on its own, since real capture happens in
   * a browser the gateway never sees. Not part of the `PaymentProvider`
   * interface; callers reach it only through the concrete class, exactly
   * like every other memory adapter's test-seeding escape hatch in this repo.
   */
  simulateCapture(paymentId: string, amountPaise: number): void {
    this.payments.set(paymentId, {
      verified: true,
      paymentId,
      amountPaise,
      captured: true,
    });
  }
}
