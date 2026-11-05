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

/** Provider-sourced order identity used to reconcile uncertain creation. */
export interface ProviderOrder extends PaymentOrderResponse {
  receipt: string;
  metadata: Record<string, string>;
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
  /**
   * The provider order this payment was made against (Razorpay `order_id`).
   * Fulfilment compares it with the order bound to the hold, so one genuine
   * payment cannot be replayed against a different hold with the same total.
   * `null`/absent only when the provider does not report one.
   */
  orderId?: string | null;
  /** ISO-4217 code the provider captured in. */
  currency?: string;
  /** Provider's captured processing fee in paise, when returned by the provider. */
  feePaise?: number;
  /** Tax on the provider fee in paise, when returned by the provider. */
  taxOnFeePaise?: number;
}

/**
 * Razorpay Checkout callback signature: `HMAC_SHA256(order_id + "|" + payment_id,
 * KEY_SECRET)`, hex. This is the scheme Razorpay documents for the browser
 * callback, and it is keyed by the API **key secret** — not the webhook secret,
 * which signs webhook bodies instead. Shared by the real adapter and the memory
 * adapter so the two cannot drift: a test that builds a signature the memory
 * provider accepts builds one the real provider accepts.
 */
export function computeCheckoutSignature(input: {
  orderId: string;
  paymentId: string;
  keySecret: string;
}): string {
  return createHmac('sha256', input.keySecret)
    .update(`${input.orderId}|${input.paymentId}`)
    .digest('hex');
}

/**
 * Constant-time comparison that is safe for attacker-controlled input.
 * `timingSafeEqual` throws a `RangeError` on unequal lengths, which surfaced as
 * an HTTP 500 for a truncated signature; a length mismatch is simply "not equal".
 */
export function safeHexEqual(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
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

/** A refund fact fetched from the provider, never supplied by an operator. */
export interface ProviderRefund extends RefundResponse {
  paymentId: string;
  currency: string;
  receipt: string | null;
}

export interface PaymentProvider {
  /**
   * Creates a payment order with the provider (e.g., Razorpay order).
   * idempotencyKey is a stable receipt, NOT a provider POST idempotency guarantee.
   * Callers must durably claim creation before invoking this method.
   */
  createOrder(request: PaymentOrderRequest): Promise<PaymentOrderResponse>;
  /** Read-only recovery; unsupported adapters fail closed rather than create again. */
  findOrdersByReceipt?(receipt: string): Promise<ProviderOrder[]>;

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

  /** Read-only lookup used to reconcile an uncertain refund. */
  getRefund(paymentId: string, refundId: string): Promise<ProviderRefund>;

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
 * Uses the same checkout-signature scheme as the real Razorpay adapter
 * (`computeCheckoutSignature`: HMAC-SHA256 of `order_id|payment_id` under the
 * KEY secret, compared with `safeHexEqual`) so route/webhook tests exercise the
 * genuine signature-verification code path, not a bypass — only the
 * network call is simulated, never the security check.
 */
export class MemoryPaymentProvider implements PaymentProvider {
  private readonly orders = new Map<string, ProviderOrder>();
  private readonly payments = new Map<string, PaymentVerificationResponse>();
  private readonly refunds = new Map<string, ProviderRefund>();

  /**
   * @param webhookSecret signs/verifies webhook bodies (kept for call-site
   *   compatibility; the memory provider has no webhook transport of its own)
   * @param keySecret signs the checkout callback; defaults to `webhookSecret`
   *   so existing single-secret test setups keep working.
   */
  constructor(
    private readonly webhookSecret: string,
    private readonly keySecret: string = webhookSecret,
  ) {}

  generateSignature(payload: { paymentId: string; orderId: string }): string {
    return computeCheckoutSignature({ ...payload, keySecret: this.keySecret });
  }

  async createOrder(request: PaymentOrderRequest): Promise<PaymentOrderResponse> {
    const id = `order_mem_${request.idempotencyKey}`;
    const existing = this.orders.get(id);
    if (existing) return existing;
    const order: ProviderOrder = {
      id,
      amountPaise: request.amountPaise,
      currency: request.currency,
      status: 'created',
      receipt: request.idempotencyKey,
      metadata: { ...request.metadata },
    };
    this.orders.set(id, order);
    return order;
  }

  async findOrdersByReceipt(receipt: string): Promise<ProviderOrder[]> {
    return [...this.orders.values()]
      .filter((order) => order.receipt === receipt)
      .map((order) => ({ ...order, metadata: { ...order.metadata } }));
  }

  async verifyPayment(request: PaymentVerificationRequest): Promise<PaymentVerificationResponse> {
    const expected = this.generateSignature({
      paymentId: request.paymentId,
      orderId: request.orderId,
    });
    if (!safeHexEqual(expected, request.signature)) {
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
    const existing = this.payments.get(paymentId);
    const captured: PaymentVerificationResponse = {
      verified: true,
      paymentId,
      amountPaise: amountPaise ?? existing?.amountPaise ?? 0,
      captured: true,
      orderId: existing?.orderId ?? null,
      currency: existing?.currency ?? 'INR',
      feePaise: existing?.feePaise ?? 0,
      taxOnFeePaise: existing?.taxOnFeePaise ?? 0,
    };
    this.payments.set(paymentId, captured);
    return captured;
  }

  async refundPayment(request: RefundRequest): Promise<RefundResponse> {
    const payment = this.payments.get(request.paymentId);
    const refund: ProviderRefund = {
      id: `rfnd_mem_${request.idempotencyKey}`,
      status: 'processed',
      amountPaise: request.amountPaise ?? payment?.amountPaise ?? 0,
      paymentId: request.paymentId,
      currency: payment?.currency ?? 'INR',
      receipt: request.idempotencyKey,
    };
    this.refunds.set(refund.id, refund);
    return { id: refund.id, status: refund.status, amountPaise: refund.amountPaise };
  }

  async getRefund(paymentId: string, refundId: string): Promise<ProviderRefund> {
    const refund = this.refunds.get(refundId);
    if (!refund || refund.paymentId !== paymentId) {
      throw new InvalidOperationError('Provider refund not found');
    }
    return { ...refund };
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
  simulateCapture(
    paymentId: string,
    amountPaise: number,
    orderId: string | null = null,
    currency = 'INR',
    fees: { feePaise: number; taxOnFeePaise: number } = { feePaise: 0, taxOnFeePaise: 0 },
  ): void {
    this.payments.set(paymentId, {
      verified: true,
      paymentId,
      amountPaise,
      captured: true,
      orderId,
      currency,
      feePaise: fees.feePaise,
      taxOnFeePaise: fees.taxOnFeePaise,
    });
  }
}
