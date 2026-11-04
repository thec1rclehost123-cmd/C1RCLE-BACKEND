import type { EntityId } from '../../domain/identity.js';
import type { EmailDelivery, EmailDeliveryRepository } from '../../domain/ports/email-delivery.js';

export class MemoryEmailDeliveryRepository implements EmailDeliveryRepository {
  readonly records = new Map<EntityId, EmailDelivery>();

  async get(id: EntityId): Promise<EmailDelivery | null> {
    return this.records.get(id) ?? null;
  }

  async createIfAbsent(delivery: EmailDelivery): Promise<EmailDelivery> {
    const existing = this.records.get(delivery.id);
    if (existing) return existing;
    this.records.set(delivery.id, delivery);
    return delivery;
  }

  async claim(id: EntityId, now: number, leaseExpiresAt: number): Promise<boolean> {
    const current = this.records.get(id);
    if (!current || current.status === 'sent') return false;
    if (current.status === 'sending' && (current.leaseExpiresAt ?? 0) > now) return false;
    this.records.set(id, {
      ...current,
      status: 'sending',
      retryCount: current.retryCount + 1,
      leaseExpiresAt,
      updatedAt: now,
    });
    return true;
  }

  async markSent(id: EntityId, providerMessageId: string, now: number): Promise<void> {
    const current = this.records.get(id);
    if (!current) return;
    this.records.set(id, {
      ...current,
      status: 'sent',
      providerMessageId,
      sentAt: now,
      updatedAt: now,
      lastError: null,
      leaseExpiresAt: null,
    });
  }

  async markFailed(id: EntityId, safeError: string, now: number): Promise<void> {
    const current = this.records.get(id);
    if (!current) return;
    this.records.set(id, {
      ...current,
      status: 'failed',
      lastError: safeError.slice(0, 160),
      updatedAt: now,
      leaseExpiresAt: null,
    });
  }

  async listForAggregate(aggregateId: EntityId, limit = 50): Promise<EmailDelivery[]> {
    return [...this.records.values()]
      .filter((record) => record.aggregateId === aggregateId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit);
  }
}
