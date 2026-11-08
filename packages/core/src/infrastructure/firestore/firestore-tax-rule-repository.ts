import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { TaxRule, TaxRuleKind } from '../../domain/models/tax-rule.js';
import type { TaxRuleRepository } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const TAX_RULE_COLLECTION = 'v2_tax_rules';

export class FirestoreTaxRuleRepository implements TaxRuleRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(TAX_RULE_COLLECTION);
  }

  async getById(id: EntityId): Promise<TaxRule | null> {
    const data = (await this.collection.doc(id).get()).data();
    return data ? toTaxRule(data) : null;
  }

  // A handful of rules exist at most, so reads are unpaginated. `listByKind` filters on one
  // field only, which needs no composite index.
  async listAll(): Promise<TaxRule[]> {
    const snap = await this.collection.get();
    return snap.docs.map((doc) => toTaxRule(doc.data()));
  }

  async listByKind(kind: TaxRuleKind): Promise<TaxRule[]> {
    const snap = await this.collection.where('kind', '==', kind).get();
    return snap.docs.map((doc) => toTaxRule(doc.data()));
  }

  async save(rule: TaxRule): Promise<void> {
    const ref = this.collection.doc(rule.id);
    await this.db.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data();
      const expected = rule.version - 1;
      const current = data ? (data.version as number) : 0;
      if (current !== expected) throw new VersionConflictError(expected, current);
      tx.set(ref, toDoc(rule));
    });
  }
}

function toDoc(rule: TaxRule): DocumentData {
  return { ...rule };
}

function toTaxRule(data: DocumentData): TaxRule {
  return {
    id: data.id as string,
    kind: data.kind as TaxRule['kind'],
    rateBps: data.rateBps as number,
    basis: data.basis as TaxRule['basis'],
    effectiveFrom: data.effectiveFrom as string,
    effectiveTo: (data.effectiveTo as string | null | undefined) ?? null,
    status: data.status as TaxRule['status'],
    approvalRef: (data.approvalRef as string | null | undefined) ?? null,
    notes: (data.notes as string | undefined) ?? '',
    createdBy: data.createdBy as string,
    enabledBy: (data.enabledBy as string | null | undefined) ?? null,
    enabledAt: (data.enabledAt as string | null | undefined) ?? null,
    retiredBy: (data.retiredBy as string | null | undefined) ?? null,
    retiredAt: (data.retiredAt as string | null | undefined) ?? null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
