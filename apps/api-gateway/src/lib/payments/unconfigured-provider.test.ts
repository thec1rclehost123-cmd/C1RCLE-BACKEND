import { ServiceUnavailableError } from '@c1rcle/core/domain';
import { describe, expect, it } from 'vitest';

import { mapDomainError } from '../../plugins/error-handler.js';

import { UnconfiguredPaymentProvider } from './unconfigured-provider.js';

describe('UnconfiguredPaymentProvider', () => {
  const provider = new UnconfiguredPaymentProvider();

  it('fails every operation closed rather than running on placeholder secrets', async () => {
    await expect(
      provider.verifyPayment({
        orderId: 'order_1',
        paymentId: 'pay_1',
        signature: 'forged',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(provider.createOrder({} as never)).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(provider.capturePayment('pay_1')).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(provider.refundPayment({} as never)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    await expect(provider.getPayment('pay_1')).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('surfaces as HTTP 503, not a generic 500', () => {
    const error = new ServiceUnavailableError('Payments are not configured on this deployment.');
    expect(mapDomainError(error)).toEqual({ status: 503, code: 'server' });
  });
});
