import { describe, expect, it } from 'vitest';

import {
  createBankAccount,
  maskAccountNumber,
  removeBankAccount,
  setAsDefault,
  unsetDefault,
} from './models/bank-account.js';

import type { BankAccountCreateInput } from './models/bank-account.js';

function input(overrides: Partial<BankAccountCreateInput> = {}): BankAccountCreateInput {
  return {
    organizationId: 'org_1',
    bankName: 'HDFC Bank',
    accountHolder: 'Venue Co',
    last4: '1234',
    encryptedAccountNumber: 'deadbeef:cafebabe',
    ifscCode: 'HDFC0001234',
    isFirstAccount: false,
    now: new Date('2026-09-07T00:00:00.000Z'),
    ...overrides,
  };
}

describe('createBankAccount', () => {
  it('is default when it is the first account', () => {
    const acc = createBankAccount(input({ isFirstAccount: true }));
    expect(acc.isDefault).toBe(true);
    expect(acc.verified).toBe(false);
  });

  it('is not default when it is not the first account', () => {
    const acc = createBankAccount(input({ isFirstAccount: false }));
    expect(acc.isDefault).toBe(false);
  });

  it('never carries the plaintext account number, only last4 + ciphertext envelope', () => {
    const acc = createBankAccount(input());
    expect(acc.last4).toBe('1234');
    expect(acc.encryptedAccountNumber).toBe('deadbeef:cafebabe');
    expect(Object.keys(acc)).not.toContain('accountNumber');
  });
});

describe('default toggling', () => {
  it('setAsDefault / unsetDefault bump version', () => {
    const acc = createBankAccount(input());
    const asDefault = setAsDefault(acc);
    expect(asDefault.isDefault).toBe(true);
    expect(asDefault.version).toBe(acc.version + 1);
    const unset = unsetDefault(asDefault);
    expect(unset.isDefault).toBe(false);
  });
});

describe('removeBankAccount', () => {
  it('rejects removing the default account', () => {
    const acc = createBankAccount(input({ isFirstAccount: true }));
    expect(() => removeBankAccount(acc)).toThrow(/default bank account/);
  });

  it('allows removing a non-default account', () => {
    const acc = createBankAccount(input({ isFirstAccount: false }));
    expect(() => removeBankAccount(acc)).not.toThrow();
  });
});

describe('maskAccountNumber', () => {
  it('masks to bullet-prefixed last4', () => {
    expect(maskAccountNumber('1234')).toBe('••1234');
  });
});
