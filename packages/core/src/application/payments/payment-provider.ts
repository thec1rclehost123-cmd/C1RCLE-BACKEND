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
