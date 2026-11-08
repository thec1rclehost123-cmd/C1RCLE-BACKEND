import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { TaxRule, TaxRuleKind } from '../../domain/models/tax-rule.js';
import type { TaxRuleRepository } from '../../domain/ports/repositories.js';

export class MemoryTaxRuleRepository implements TaxRuleRepository {
  rules = new Map<EntityId, TaxRule>();

  async getById(id: EntityId): Promise<TaxRule | null> {
    const found = this.rules.get(id);
    return found ? structuredClone(found) : null;
  }

  async listAll(): Promise<TaxRule[]> {
    return [...this.rules.values()].map((rule) => structuredClone(rule));
  }

  async listByKind(kind: TaxRuleKind): Promise<TaxRule[]> {
    return (await this.listAll()).filter((rule) => rule.kind === kind);
  }

  async save(rule: TaxRule): Promise<void> {
    const expected = rule.version - 1;
    const current = this.rules.get(rule.id)?.version ?? 0;
    if (current !== expected) throw new VersionConflictError(expected, current);
    this.rules.set(rule.id, structuredClone(rule));
  }
}
