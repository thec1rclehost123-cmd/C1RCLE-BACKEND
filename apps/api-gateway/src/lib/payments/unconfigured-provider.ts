import { ServiceUnavailableError } from '@c1rcle/core/domain';

import type {
  PaymentOrderRequest,
  PaymentOrderResponse,
  PaymentProvider,
  PaymentVerificationRequest,
  PaymentVerificationResponse,
  RefundRequest,
  RefundResponse,
} from '@c1rcle/core/domain/ports';

/**
 * Stands in for the real payment provider when Razorpay credentials are absent.
 *
 * Constructing `RazorpayPaymentProvider` with placeholder secrets (the previous
 * behaviour) is not harmless: client-redirect payment verification is an HMAC
 * keyed by `RAZORPAY_KEY_SECRET`, so a deployment missing that variable would
 * accept signatures computed with the published placeholder. Every operation
 * here instead fails closed with a 503.
 */
export class UnconfiguredPaymentProvider implements PaymentProvider {
  private fail(): never {
    throw new ServiceUnavailableError('Payments are not configured on this deployment.');
  }

  createOrder(_request: PaymentOrderRequest): Promise<PaymentOrderResponse> {
    return Promise.resolve().then(() => this.fail());
  }
  verifyPayment(_request: PaymentVerificationRequest): Promise<PaymentVerificationResponse> {
    return Promise.resolve().then(() => this.fail());
  }
  capturePayment(_paymentId: string, _amountPaise?: number): Promise<PaymentVerificationResponse> {
    return Promise.resolve().then(() => this.fail());
  }
  refundPayment(_request: RefundRequest): Promise<RefundResponse> {
    return Promise.resolve().then(() => this.fail());
  }
  getPayment(_paymentId: string): Promise<PaymentVerificationResponse | null> {
    return Promise.resolve().then(() => this.fail());
  }
}
