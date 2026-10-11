import { VersionConflictError } from '../../domain/errors.js';

import type { ProviderPayment } from '../../domain/models/provider-payment.js';
import type { ProviderPaymentRepository } from '../../domain/ports/repositories.js';

export class MemoryProviderPaymentRepository implements ProviderPaymentRepository {
  payments = new Map<string, ProviderPayment>();

  async findByPaymentId(paymentId: string): Promise<ProviderPayment | null> {
    const found = this.payments.get(paymentId);
    return found ? structuredClone(found) : null;
  }

  async save(record: ProviderPayment): Promise<void> {
    const existing = this.payments.get(record.id);
    // A new record (version 1) must not already exist; an update must follow
    // exactly the version that is stored.
    const expected = record.version - 1;
    const current = existing?.version ?? 0;
    if (current !== expected) throw new VersionConflictError(expected, current);
    this.payments.set(record.id, structuredClone(record));
  }
}
