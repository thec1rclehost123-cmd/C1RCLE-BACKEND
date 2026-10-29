import { VersionConflictError } from '../../domain/errors.js';

import type { ProviderPayment } from '../../domain/models/provider-payment.js';
import type {
  ProviderPaymentRepository,
  Page,
  PaginationQuery,
} from '../../domain/ports/repositories.js';

export class MemoryProviderPaymentRepository implements ProviderPaymentRepository {
  payments = new Map<string, ProviderPayment>();

  async findByPaymentId(paymentId: string): Promise<ProviderPayment | null> {
    const found = this.payments.get(paymentId);
    return found ? structuredClone(found) : null;
  }

  async findByProviderOrderId(providerOrderId: string): Promise<ProviderPayment | null> {
    const found = [...this.payments.values()].find(
      (payment) => payment.providerOrderId === providerOrderId,
    );
    return found ? structuredClone(found) : null;
  }

  async listAll(query: PaginationQuery): Promise<Page<ProviderPayment>> {
    const all = [...this.payments.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
    const start = query.cursor ? all.findIndex((item) => item.id === query.cursor) + 1 : 0;
    const items = all.slice(start, start + query.limit).map((item) => structuredClone(item));
    return {
      items,
      total: all.length,
      nextCursor: start + items.length < all.length ? (items.at(-1)?.id ?? null) : null,
    };
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
