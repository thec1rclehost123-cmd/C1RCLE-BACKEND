import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MemoryPaymentProvider,
  computeCheckoutSignature,
  safeHexEqual,
} from './payment-provider.js';

// Independent known-answer vector (see the matching test in the gateway's
// razorpay-adapter.test.ts): computed with
//   printf 'order_EKwxwAgItmmXdp|pay_EKwxwAgItmmXdp' | openssl dgst -sha256 -hmac 'rzp_test_key_secret_example'
const VECTOR = {
  keySecret: 'rzp_test_key_secret_example',
  orderId: 'order_EKwxwAgItmmXdp',
  paymentId: 'pay_EKwxwAgItmmXdp',
  signature: 'd0bd7ac27b0059bab53e8f01b37f7d9f9f0f9725336fa6738ef59a2c32ff3fe9',
};

describe('computeCheckoutSignature', () => {
  it('is HMAC-SHA256 of "order_id|payment_id" under the key secret', () => {
    expect(computeCheckoutSignature(VECTOR)).toBe(VECTOR.signature);
  });

  it('depends on the key secret, the order id and the payment id', () => {
    const base = computeCheckoutSignature(VECTOR);
    expect(computeCheckoutSignature({ ...VECTOR, keySecret: 'other' })).not.toBe(base);
    expect(computeCheckoutSignature({ ...VECTOR, orderId: 'order_other' })).not.toBe(base);
    expect(computeCheckoutSignature({ ...VECTOR, paymentId: 'pay_other' })).not.toBe(base);
  });
});

describe('safeHexEqual', () => {
  it('compares equal and unequal strings of the same length', () => {
    expect(safeHexEqual('abcdef', 'abcdef')).toBe(true);
    expect(safeHexEqual('abcdef', 'abcdee')).toBe(false);
  });

  it('returns false for a different length instead of throwing a RangeError', () => {
    expect(() => safeHexEqual('abcdef', 'abc')).not.toThrow();
    expect(safeHexEqual('abcdef', 'abc')).toBe(false);
    expect(safeHexEqual('abcdef', '')).toBe(false);
  });
});

describe('MemoryPaymentProvider signs like the real adapter', () => {
  it('uses the key secret, separately from the webhook secret', async () => {
    const provider = new MemoryPaymentProvider('webhook_secret', VECTOR.keySecret);
    const signature = provider.generateSignature({
      orderId: VECTOR.orderId,
      paymentId: VECTOR.paymentId,
    });
    expect(signature).toBe(VECTOR.signature);

    provider.simulateCapture(VECTOR.paymentId, 1000, VECTOR.orderId);
    await expect(
      provider.verifyPayment({
        orderId: VECTOR.orderId,
        paymentId: VECTOR.paymentId,
        signature,
      }),
    ).resolves.toMatchObject({ captured: true, orderId: VECTOR.orderId, currency: 'INR' });
  });

  it('rejects a signature made with the webhook secret or truncated, without throwing a RangeError', async () => {
    const provider = new MemoryPaymentProvider('webhook_secret', VECTOR.keySecret);
    provider.simulateCapture(VECTOR.paymentId, 1000, VECTOR.orderId);
    const wrongKey = createHmac('sha256', 'webhook_secret')
      .update(`${VECTOR.orderId}|${VECTOR.paymentId}`)
      .digest('hex');

    for (const signature of [wrongKey, VECTOR.signature.slice(0, 12), '']) {
      await expect(
        provider.verifyPayment({ orderId: VECTOR.orderId, paymentId: VECTOR.paymentId, signature }),
      ).rejects.toThrow('Invalid payment signature');
    }
  });
});
