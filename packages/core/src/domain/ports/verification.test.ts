import { describe, expect, it } from 'vitest';

import { CompositeVerificationProvider, FormatCheckVerificationProvider } from './verification.js';

import type {
  VerificationProvider,
  VerificationRequest,
  VerificationResult,
} from './verification.js';

class StubProvider implements VerificationProvider {
  constructor(
    readonly name: string,
    private readonly result: VerificationResult,
  ) {}
  async verify(): Promise<VerificationResult> {
    return this.result;
  }
}

describe('FormatCheckVerificationProvider', () => {
  const provider = new FormatCheckVerificationProvider();

  it('passes a well-formed Aadhaar number', async () => {
    const result = await provider.verify({
      documentType: 'aadhaar',
      documentNumber: '234567890123',
    });
    expect(result).toEqual({ passed: true, provider: 'format-check', reason: 'format_ok' });
  });

  it('fails a malformed Aadhaar number', async () => {
    const result = await provider.verify({ documentType: 'aadhaar', documentNumber: '123' });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('malformed');
  });

  it('reports an unsupported document type rather than guessing', async () => {
    const result = await provider.verify({
      documentType: 'phone',
      documentNumber: '+919876543210',
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('unsupported_document_type');
  });
});

describe('CompositeVerificationProvider', () => {
  it('routes a registered documentType to its dedicated provider', async () => {
    const phone = new StubProvider('phone-stub', {
      passed: true,
      provider: 'phone-stub',
      reason: 'phone_verified',
    });
    const composite = new CompositeVerificationProvider(
      { phone },
      new FormatCheckVerificationProvider(),
    );
    const request: VerificationRequest = {
      documentType: 'phone',
      documentNumber: '+919876543210',
      proofToken: 'token',
    };
    const result = await composite.verify(request);
    expect(result.provider).toBe('phone-stub');
    expect(result.passed).toBe(true);
  });

  it('falls back to the default provider for any unregistered documentType', async () => {
    const phone = new StubProvider('phone-stub', { passed: true, provider: 'phone-stub' });
    const composite = new CompositeVerificationProvider(
      { phone },
      new FormatCheckVerificationProvider(),
    );
    const result = await composite.verify({
      documentType: 'aadhaar',
      documentNumber: '234567890123',
    });
    expect(result.provider).toBe('format-check');
  });
});
