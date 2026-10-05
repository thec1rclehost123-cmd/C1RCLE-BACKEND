import { describe, expect, it } from 'vitest';

import { ForbiddenError, InvalidOperationError } from './errors.js';
import {
  approveRefundRequest,
  approversRequiredFor,
  createRefundRequest,
  isFullyApproved,
  markRefundFailed,
  markRefundSettled,
  rejectRefundRequest,
} from './models/refund-request.js';

const T0 = new Date('2026-08-14T12:00:00.000Z');

function request(overrides: Partial<Parameters<typeof createRefundRequest>[0]> = {}) {
  return createRefundRequest({
    id: 'rfd_1',
    orderId: 'ord_1',
    organizationId: 'org_1',
    amountPaise: 100_000, // ₹1,000 — single-approver tier
    requestedBy: 'admin_a',
    reason: 'Guest requested cancellation',
    hasRedeemedEntitlement: false,
    now: T0,
    ...overrides,
  });
}

describe('amount-tiered approver count', () => {
  it('requires zero approvers under ₹500', () => {
    expect(approversRequiredFor(49_999, false)).toBe(0);
  });

  it('requires one approver from ₹500 up to ₹5,000', () => {
    expect(approversRequiredFor(50_000, false)).toBe(1);
    expect(approversRequiredFor(499_999, false)).toBe(1);
  });

  it('requires two approvers at ₹5,000 and above', () => {
    expect(approversRequiredFor(500_000, false)).toBe(2);
    expect(approversRequiredFor(10_000_000, false)).toBe(2);
  });

  it('a redeemed (checked-in) entitlement blocks auto-approval even under ₹500', () => {
    expect(approversRequiredFor(1_000, true)).toBe(1);
  });
});

describe('creating a refund request', () => {
  it('refuses a non-positive amount', () => {
    expect(() => request({ amountPaise: 0 })).toThrow(InvalidOperationError);
    expect(() => request({ amountPaise: -1 })).toThrow(InvalidOperationError);
  });

  it('refuses an empty reason', () => {
    expect(() => request({ reason: '   ' })).toThrow(InvalidOperationError);
  });

  it('a request under ₹500 with no redeemed entitlement is already approved', () => {
    const r = request({ amountPaise: 10_000, hasRedeemedEntitlement: false });
    expect(r.approversRequired).toBe(0);
    expect(r.status).toBe('approved');
    expect(isFullyApproved(r)).toBe(true);
  });

  it('a request of ₹1,000 starts pending, needing one approver', () => {
    const r = request();
    expect(r.approversRequired).toBe(1);
    expect(r.status).toBe('pending');
    expect(isFullyApproved(r)).toBe(false);
  });
});

describe('approving a refund request', () => {
  it('becomes approved once enough distinct admins sign off', () => {
    let r = request({ amountPaise: 600_000 }); // ₹6,000 — two approvers
    expect(r.approversRequired).toBe(2);
    r = approveRefundRequest(r, 'admin_b', T0);
    expect(r.status).toBe('pending');
    r = approveRefundRequest(r, 'admin_c', T0);
    expect(r.status).toBe('approved');
    expect(r.approvals).toHaveLength(2);
  });

  it('refuses the requester approving their own request', () => {
    const r = request();
    expect(() => approveRefundRequest(r, 'admin_a', T0)).toThrow(ForbiddenError);
  });

  it('refuses the same admin approving twice', () => {
    let r = request({ amountPaise: 600_000 });
    r = approveRefundRequest(r, 'admin_b', T0);
    expect(() => approveRefundRequest(r, 'admin_b', T0)).toThrow(ForbiddenError);
  });

  it('refuses approving a request that is not pending', () => {
    const r = request({ amountPaise: 10_000, hasRedeemedEntitlement: false }); // already approved
    expect(() => approveRefundRequest(r, 'admin_b', T0)).toThrow(InvalidOperationError);
  });
});

describe('rejecting a refund request', () => {
  it('rejects with a reason and is terminal', () => {
    const r = rejectRefundRequest(request(), 'admin_b', 'Order already fulfilled', T0);
    expect(r.status).toBe('rejected');
    expect(r.rejectedBy).toBe('admin_b');
    expect(r.rejectionReason).toBe('Order already fulfilled');
  });

  it('refuses an empty rejection reason', () => {
    expect(() => rejectRefundRequest(request(), 'admin_b', '  ', T0)).toThrow(
      InvalidOperationError,
    );
  });

  it('refuses rejecting a request that is not pending', () => {
    const rejected = rejectRefundRequest(request(), 'admin_b', 'No', T0);
    expect(() => rejectRefundRequest(rejected, 'admin_c', 'No again', T0)).toThrow(
      InvalidOperationError,
    );
  });
});

describe('settlement', () => {
  it('refuses to settle a request that has not been approved', () => {
    const r = request(); // pending, one approver still needed
    expect(() => markRefundSettled(r, 'rfnd_provider_1', T0)).toThrow(InvalidOperationError);
  });

  it('records the provider refund id once settled', () => {
    let r = request();
    r = approveRefundRequest(r, 'admin_b', T0);
    r = markRefundSettled(r, 'rfnd_provider_1', T0);
    expect(r.status).toBe('settled');
    expect(r.providerRefundId).toBe('rfnd_provider_1');
  });

  it('records a failure reason when settlement fails', () => {
    let r = request();
    r = approveRefundRequest(r, 'admin_b', T0);
    r = markRefundFailed(r, 'Provider timeout', T0);
    expect(r.status).toBe('failed');
    expect(r.failureReason).toBe('Provider timeout');
  });
});
