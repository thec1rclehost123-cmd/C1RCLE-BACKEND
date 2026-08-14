import { describe, expect, it } from 'vitest';

import { InvalidOperationError, StateTransitionError } from './errors.js';
import {
  approveConnection,
  blockConnection,
  createPromoterConnection,
  isConnectionLive,
  recipientOf,
  rejectConnection,
  revokeConnection,
} from './models/promoter-connection.js';

/**
 * ─── Promoter connections ────────────────────────────────────────────────────
 * Ported from v1 `routes/v1/promoter-connections.ts`. The asymmetry is the
 * interesting part: the recipient approves/rejects, only the promoter revokes.
 */

const NOW = new Date('2026-08-13T10:00:00.000Z');
const PROMOTER = 'org_promoter';
const TARGET = 'org_venue';

const connection = (initiatedBy: 'promoter' | 'target' = 'promoter') =>
  createPromoterConnection({
    id: 'pc_1',
    promoterId: PROMOTER,
    targetId: TARGET,
    targetType: 'venue',
    initiatedBy,
    now: NOW,
  });

describe('opening a connection', () => {
  it('starts pending and counts as live', () => {
    expect(connection().status).toBe('pending');
    expect(isConnectionLive(connection())).toBe(true);
  });

  it('refuses a self-connection', () => {
    expect(() =>
      createPromoterConnection({
        id: 'pc_x',
        promoterId: PROMOTER,
        targetId: PROMOTER,
        targetType: 'host',
        initiatedBy: 'promoter',
        now: NOW,
      }),
    ).toThrow(InvalidOperationError);
  });

  it('names the recipient as the side that did not open it', () => {
    expect(recipientOf(connection('promoter'))).toBe(TARGET);
    expect(recipientOf(connection('target'))).toBe(PROMOTER);
  });
});

describe('answering', () => {
  it('lets the recipient approve', () => {
    expect(approveConnection(connection('promoter'), TARGET, NOW).status).toBe('active');
  });

  it('refuses approval by the side that opened it', () => {
    expect(() => approveConnection(connection('promoter'), PROMOTER, NOW)).toThrow(
      InvalidOperationError,
    );
  });

  it('records a rejection reason', () => {
    expect(rejectConnection(connection(), TARGET, 'Not a fit', NOW)).toMatchObject({
      status: 'rejected',
      resolutionReason: 'Not a fit',
    });
  });

  it('lets either party block, and makes it terminal', () => {
    const blocked = blockConnection(connection(), TARGET, 'Spam', NOW);
    expect(blocked.status).toBe('blocked');
    expect(() => approveConnection(blocked, TARGET, NOW)).toThrow(StateTransitionError);
  });

  it('refuses a block from an unrelated organization', () => {
    expect(() => blockConnection(connection(), 'org_stranger', undefined, NOW)).toThrow(
      InvalidOperationError,
    );
  });
});

describe('revoking', () => {
  it('is the promoter’s action alone', () => {
    // Separate from `reject` on purpose: withdrawing is not the counterparty
    // refusing you.
    expect(revokeConnection(connection(), PROMOTER, NOW).status).toBe('revoked');
    expect(() => revokeConnection(connection(), TARGET, NOW)).toThrow(InvalidOperationError);
  });

  it('works on an active connection, not just a pending one', () => {
    const active = approveConnection(connection(), TARGET, NOW);
    expect(revokeConnection(active, PROMOTER, NOW).status).toBe('revoked');
  });

  it('cannot revive a revoked connection', () => {
    const revoked = revokeConnection(connection(), PROMOTER, NOW);
    expect(() => approveConnection(revoked, TARGET, NOW)).toThrow(StateTransitionError);
    expect(isConnectionLive(revoked)).toBe(false);
  });
});
