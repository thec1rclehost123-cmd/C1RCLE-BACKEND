import { ForbiddenError, NotFoundError } from '../../domain/errors.js';
import {
  activeTaxRule,
  createTaxRuleDraft,
  enableTaxRule,
  indiaDate,
  retireTaxRule,
} from '../../domain/models/tax-rule.js';

import type { EntityId } from '../../domain/identity.js';
import type { AdminRole } from '../../domain/models/admin-authority.js';
import type { TaxBasis, TaxRule, TaxRuleKind } from '../../domain/models/tax-rule.js';
import type { AdminAuthorityService, AuditInput } from '../admin/admin-authority-service.js';
import type { ServiceDeps } from '../context.js';

/** Tax is a finance and leadership call; `ops` and `support` can change neither. */
const TAX_ROLES: readonly AdminRole[] = ['super', 'admin', 'finance'];

type RequestMeta = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

export interface CreateTaxRuleCommand {
  kind: TaxRuleKind;
  rateBps: number;
  basis: TaxBasis;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string;
}

/**
 * ─── Tax rule management ─────────────────────────────────────────────────────
 * Drafts, enables and retires tax rules (see `tax-rule.ts` for the rules about
 * rules). Every change is audited with who, when and the advice it rests on.
 * `activeRule` is deliberately open: pricing and settlement will need it, and
 * it returns null, meaning "no tax", until a rule has been properly enabled.
 */
export class TaxRuleService {
  constructor(
    private deps: ServiceDeps,
    private authority: AdminAuthorityService,
  ) {}

  private get rules() {
    return this.deps.repositories.taxRules;
  }

  private async admin(adminUserId: EntityId) {
    const admin = await this.authority.authorize(adminUserId, 'TAX_RULE_UPDATE');
    if (!TAX_ROLES.includes(admin.role)) {
      throw new ForbiddenError('Only super, admin and finance may manage tax rules');
    }
    return admin;
  }

  private async require(ruleId: EntityId): Promise<TaxRule> {
    const rule = await this.rules.getById(ruleId);
    if (!rule) throw new NotFoundError('tax_rule', ruleId);
    return rule;
  }

  async createDraft(
    adminUserId: EntityId,
    command: CreateTaxRuleCommand,
    meta?: RequestMeta,
  ): Promise<TaxRule> {
    const admin = await this.admin(adminUserId);
    const rule = createTaxRuleDraft({
      ...command,
      id: this.deps.config.ids(),
      createdBy: admin.id,
      now: this.deps.config.clock.now(),
    });
    await this.rules.save(rule);
    await this.authority.record(admin, {
      action: 'TAX_RULE.create',
      targetType: 'tax_rule',
      targetId: rule.id,
      before: null,
      after: { kind: rule.kind, rateBps: rule.rateBps, status: rule.status },
      ...meta,
    });
    return rule;
  }

  async enable(
    adminUserId: EntityId,
    ruleId: EntityId,
    approvalRef: string,
    meta?: RequestMeta,
  ): Promise<TaxRule> {
    const admin = await this.admin(adminUserId);
    const rule = await this.require(ruleId);
    const enabled = enableTaxRule(rule, {
      enabledBy: admin.id,
      approvalRef,
      sameKind: await this.rules.listByKind(rule.kind),
      now: this.deps.config.clock.now(),
    });
    await this.rules.save(enabled);
    await this.authority.record(admin, {
      action: 'TAX_RULE.enable',
      targetType: 'tax_rule',
      targetId: rule.id,
      before: { status: rule.status },
      after: {
        status: enabled.status,
        kind: enabled.kind,
        rateBps: enabled.rateBps,
        effectiveFrom: enabled.effectiveFrom,
        effectiveTo: enabled.effectiveTo,
      },
      // The written advice this rule rests on, kept with the audit entry.
      reason: enabled.approvalRef,
      ...meta,
    });
    return enabled;
  }

  async retire(
    adminUserId: EntityId,
    ruleId: EntityId,
    reason: string,
    meta?: RequestMeta,
  ): Promise<TaxRule> {
    const admin = await this.admin(adminUserId);
    const rule = await this.require(ruleId);
    const retired = retireTaxRule(rule, admin.id, this.deps.config.clock.now());
    await this.rules.save(retired);
    await this.authority.record(admin, {
      action: 'TAX_RULE.retire',
      targetType: 'tax_rule',
      targetId: rule.id,
      before: { status: rule.status },
      after: { status: retired.status },
      reason,
      ...meta,
    });
    return retired;
  }

  async list(adminUserId: EntityId, kind?: TaxRuleKind): Promise<TaxRule[]> {
    await this.authority.requireAdmin(adminUserId);
    return kind ? this.rules.listByKind(kind) : this.rules.listAll();
  }

  /**
   * The enabled rule for `kind` on a day (today, India time, by default), or
   * null. Null is the normal answer until a rule has been approved.
   */
  async activeRule(kind: TaxRuleKind, at?: Date): Promise<TaxRule | null> {
    const day = indiaDate(at ?? this.deps.config.clock.now());
    return activeTaxRule(await this.rules.listByKind(kind), kind, day);
  }
}
