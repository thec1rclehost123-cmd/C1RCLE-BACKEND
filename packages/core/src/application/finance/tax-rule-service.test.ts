import { describe, expect, it } from 'vitest';

import { ForbiddenError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { MemoryTaxRuleRepository } from '../../infrastructure/memory/memory-tax-rule-repository.js';

import { TaxRuleService } from './tax-rule-service.js';

import type { AdminRole } from '../../domain/models/admin-authority.js';
import type { AdminAuthorityService, AuditInput } from '../admin/admin-authority-service.js';
import type { ServiceDeps } from '../context.js';

const NOW = new Date('2026-10-11T10:00:00.000Z');

function build() {
  const roles = new Map<string, AdminRole>([
    ['author', 'finance'],
    ['checker', 'super'],
    ['ops_user', 'ops'],
    ['support_user', 'support'],
  ]);
  const audit: (AuditInput & { adminId: string })[] = [];
  let seq = 0;
  const authority = {
    requireAdmin: async (id: string) => {
      const role = roles.get(id);
      if (!role) throw new Error('not an admin');
      return { id, role };
    },
    authorize: async (id: string) => {
      const role = roles.get(id);
      if (!role) throw new Error('not an admin');
      if (role === 'support') throw new ForbiddenError('tier');
      return { id, role };
    },
    record: async (admin: { id: string }, input: AuditInput) => {
      audit.push({ ...input, adminId: admin.id });
    },
  } as unknown as AdminAuthorityService;
  const deps = {
    repositories: { taxRules: new MemoryTaxRuleRepository() },
    config: { clock: { now: () => NOW }, ids: () => `rule_${String(++seq)}` },
  } as unknown as ServiceDeps;
  return { service: new TaxRuleService(deps, authority), audit };
}

const command = {
  kind: 'tds_194o' as const,
  rateBps: 10,
  basis: 'net_payable_to_seller' as const,
  effectiveFrom: '2026-04-01',
};

describe('TaxRuleService', () => {
  it('has no active rule of any kind until one has been enabled', async () => {
    const { service } = build();

    for (const kind of ['ticket_gst', 'convenience_fee_gst', 'tds_194o', 'gst_tcs_s52'] as const) {
      expect(await service.activeRule(kind)).toBeNull();
    }
  });

  it('a drafted rule is not active; an enabled one is, until retired', async () => {
    const { service } = build();
    const rule = await service.createDraft('author', command);
    expect(await service.activeRule('tds_194o')).toBeNull();

    await service.enable('checker', rule.id, 'CA advice dated 5 Oct 2026');
    expect((await service.activeRule('tds_194o'))?.rateBps).toBe(10);

    await service.retire('checker', rule.id, 'CA revised advice');
    expect(await service.activeRule('tds_194o')).toBeNull();
  });

  it('will not let the author enable their own rule', async () => {
    const { service } = build();
    const rule = await service.createDraft('author', command);

    await expect(
      service.enable('author', rule.id, 'CA advice dated 5 Oct 2026'),
    ).rejects.toBeInstanceOf(InvalidOperationError);
    expect(await service.activeRule('tds_194o')).toBeNull();
  });

  it('keeps ops and support away from tax rules entirely', async () => {
    const { service } = build();

    await expect(service.createDraft('ops_user', command)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.createDraft('support_user', command)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await service.list('checker')).toEqual([]);
  });

  it('audits every change with who, what and the advice relied on', async () => {
    const { service, audit } = build();
    const rule = await service.createDraft('author', command, { ipAddress: '10.0.0.1' });
    await service.enable('checker', rule.id, 'CA advice dated 5 Oct 2026');
    await service.retire('checker', rule.id, 'superseded');

    expect(audit.map((entry) => [entry.action, entry.adminId])).toEqual([
      ['TAX_RULE.create', 'author'],
      ['TAX_RULE.enable', 'checker'],
      ['TAX_RULE.retire', 'checker'],
    ]);
    expect(audit[0]?.ipAddress).toBe('10.0.0.1');
    expect(audit[1]).toMatchObject({
      targetId: rule.id,
      reason: 'CA advice dated 5 Oct 2026',
      before: { status: 'draft' },
      after: { status: 'enabled', rateBps: 10 },
    });
    expect(audit[2]?.reason).toBe('superseded');
  });

  it('writes no audit record for a change that is refused', async () => {
    const { service, audit } = build();
    const rule = await service.createDraft('author', command);
    audit.length = 0;

    await expect(service.enable('author', rule.id, 'CA advice dated 5 Oct 2026')).rejects.toThrow();
    await expect(service.enable('checker', rule.id, '')).rejects.toThrow();

    expect(audit).toEqual([]);
  });

  it('refuses to enable a rule that overlaps an enabled one, and reports unknown ids', async () => {
    const { service } = build();
    const first = await service.createDraft('author', command);
    await service.enable('checker', first.id, 'CA advice dated 5 Oct 2026');
    const second = await service.createDraft('author', { ...command, rateBps: 20 });

    await expect(
      service.enable('checker', second.id, 'CA advice dated 6 Oct 2026'),
    ).rejects.toThrow(/already covers/);
    await expect(
      service.enable('checker', 'rule_missing', 'CA advice dated 5 Oct 2026'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('evaluates the rule for the date asked about, in India time', async () => {
    const { service } = build();
    const rule = await service.createDraft('author', { ...command, effectiveFrom: '2026-10-12' });
    await service.enable('checker', rule.id, 'CA advice dated 5 Oct 2026');

    // 18:29 UTC on the 11th is still the 11th in India; 18:30 UTC is the 12th.
    expect(await service.activeRule('tds_194o', new Date('2026-10-11T18:29:00.000Z'))).toBeNull();
    expect((await service.activeRule('tds_194o', new Date('2026-10-11T18:30:00.000Z')))?.id).toBe(
      rule.id,
    );
  });
});
