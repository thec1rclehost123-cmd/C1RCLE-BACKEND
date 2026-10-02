import { describe, expect, it } from 'vitest';

import { InvalidOperationError, StateTransitionError } from './errors.js';
import {
  addOnboardingDocument,
  allRequiredDocumentsVerified,
  approveOnboardingRequest,
  createOnboardingRequest,
  missingDocuments,
  platformFeePercentFor,
  rejectKycDocument,
  rejectOnboardingRequest,
  requestOnboardingChanges,
  sanitizeApplicantProfile,
  submitOnboardingRequest,
  updateOnboardingProfile,
  verifyKycDocument,
} from './models/onboarding.js';

/**
 * ─── Partner onboarding ──────────────────────────────────────────────────────
 * Ported from v1's onboarding_requests flow. The privilege-escalation guard is
 * the rule most worth locking down.
 */

const NOW = new Date('2026-08-13T10:00:00.000Z');
const LATER = new Date('2026-08-13T12:00:00.000Z');

const request = () =>
  createOnboardingRequest({
    id: 'onb_1',
    userId: 'user_1',
    requestedType: 'venue',
    plan: 'silver',
    profile: {
      legalName: 'Skyline Hospitality',
      contactPerson: 'A Person',
      phone: '+910000000000',
      city: 'Mumbai',
    },
    now: NOW,
  });

const withDocuments = () => {
  let subject = request();
  for (const label of ['id_front', 'id_back', 'selfie']) {
    subject = addOnboardingDocument(subject, { label, storagePath: `kyc/${label}.jpg` }, NOW);
  }
  return subject;
};

describe('the applicant’s side', () => {
  it('starts as a draft with no documents', () => {
    expect(request()).toMatchObject({ status: 'draft', documents: [], submittedAt: null });
  });

  it('names the platform fee from the plan, not from the applicant', () => {
    expect(platformFeePercentFor('basic')).toBe(15);
    expect(platformFeePercentFor('silver')).toBe(12);
    expect(platformFeePercentFor('diamond')).toBe(10);
  });

  it('strips anything that is not a profile field — the escalation guard', () => {
    const sanitized = sanitizeApplicantProfile({
      city: 'Mumbai',
      role: 'admin',
      status: 'approved',
      provisionedOrganizationId: 'org_hijack',
    });

    // v1 stripped `role` from autosave for exactly this reason; here the
    // allow-list makes it total rather than field-by-field.
    expect(sanitized).toEqual({ city: 'Mumbai' });
  });

  it('replaces a re-uploaded document rather than keeping both', () => {
    const once = addOnboardingDocument(request(), { label: 'id_front', storagePath: 'a.jpg' }, NOW);
    const twice = addOnboardingDocument(once, { label: 'id_front', storagePath: 'b.jpg' }, LATER);

    // Keeping both invites an admin approving the stale copy.
    expect(twice.documents).toHaveLength(1);
    expect(twice.documents[0]?.storagePath).toBe('b.jpg');
  });

  it('starts every uploaded document pending, with no reviewer', () => {
    const uploaded = addOnboardingDocument(
      request(),
      { label: 'id_front', storagePath: 'a.jpg' },
      NOW,
    );
    expect(uploaded.documents[0]).toMatchObject({
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
    });
  });

  it('resets a re-uploaded document to pending, never inheriting the old review', () => {
    const uploaded = addOnboardingDocument(
      request(),
      { label: 'id_front', storagePath: 'a.jpg' },
      NOW,
    );
    const verified = verifyKycDocument(uploaded, 'id_front', 'admin_a', LATER);
    expect(verified.documents[0]?.status).toBe('verified');

    // A re-upload of an already-verified label must be re-reviewed, not
    // silently stay verified.
    const reUploaded = addOnboardingDocument(
      verified,
      { label: 'id_front', storagePath: 'c.jpg' },
      LATER,
    );
    expect(reUploaded.documents[0]).toMatchObject({
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      storagePath: 'c.jpg',
    });
  });

  it('requires the business document set for a business applicant, not the individual one', () => {
    const businessRequest = createOnboardingRequest({
      id: 'onb_biz',
      userId: 'user_biz',
      requestedType: 'venue',
      plan: 'basic',
      profile: {
        legalName: 'Biz Co',
        contactPerson: 'A Person',
        phone: '+910000000000',
        city: 'Mumbai',
        entityType: 'business',
      },
      now: NOW,
    });
    expect(missingDocuments(businessRequest)).toEqual([
      'registration_certificate',
      'sig_id_front',
      'sig_id_back',
      'sig_selfie',
    ]);
  });

  it('refuses to submit without the required documents', () => {
    expect(missingDocuments(request())).toEqual(['id_front', 'id_back', 'selfie']);
    expect(() => submitOnboardingRequest(request(), NOW)).toThrow(InvalidOperationError);
  });

  it('submits once the documents are present', () => {
    const submitted = submitOnboardingRequest(withDocuments(), LATER);
    expect(submitted).toMatchObject({ status: 'submitted' });
    expect(submitted.submittedAt).toBe(LATER.toISOString());
  });

  it('cannot edit a request that is under review', () => {
    const submitted = submitOnboardingRequest(withDocuments(), LATER);
    // Otherwise an applicant could change what an admin is reading.
    expect(() => updateOnboardingProfile(submitted, { city: 'Delhi' }, LATER)).toThrow(
      InvalidOperationError,
    );
  });
});

describe('the admin’s side', () => {
  const submitted = () => submitOnboardingRequest(withDocuments(), LATER);

  it('approves, recording who decided and what was provisioned', () => {
    const approved = approveOnboardingRequest(submitted(), {
      reviewedBy: 'admin_a',
      provisionedOrganizationId: 'org_new',
      note: 'Docs check out',
      now: LATER,
    });

    expect(approved).toMatchObject({
      status: 'approved',
      reviewedBy: 'admin_a',
      provisionedOrganizationId: 'org_new',
    });
  });

  it('requires a note when asking for changes', () => {
    // "Changes requested" with no note leaves the applicant guessing.
    expect(() =>
      requestOnboardingChanges(submitted(), { reviewedBy: 'admin_a', now: LATER }),
    ).toThrow(InvalidOperationError);
  });

  it('lets an applicant fix and resubmit after changes are requested', () => {
    const returned = requestOnboardingChanges(submitted(), {
      reviewedBy: 'admin_a',
      note: 'ID photo is blurry',
      now: LATER,
    });
    expect(returned.status).toBe('changes_requested');

    const edited = updateOnboardingProfile(returned, { city: 'Pune' }, LATER);
    expect(submitOnboardingRequest(edited, LATER).status).toBe('submitted');
  });

  it('treats a decision as final', () => {
    const rejected = rejectOnboardingRequest(submitted(), {
      reviewedBy: 'admin_a',
      note: 'Not eligible',
      now: LATER,
    });

    expect(() =>
      approveOnboardingRequest(rejected, {
        reviewedBy: 'admin_b',
        provisionedOrganizationId: 'org_x',
        now: LATER,
      }),
    ).toThrow(StateTransitionError);
  });

  it('cannot approve something never submitted', () => {
    expect(() =>
      approveOnboardingRequest(request(), {
        reviewedBy: 'admin_a',
        provisionedOrganizationId: 'org_x',
        now: LATER,
      }),
    ).toThrow(StateTransitionError);
  });
});

describe('the KYC document desk', () => {
  it('verifies one uploaded document, stamping who and when', () => {
    const subject = withDocuments();
    const verified = verifyKycDocument(subject, 'id_front', 'admin_a', LATER);
    expect(verified.documents.find((d) => d.label === 'id_front')).toMatchObject({
      status: 'verified',
      reviewedBy: 'admin_a',
      reviewedAt: LATER.toISOString(),
      rejectionReason: null,
    });
    // Reviewing one document must not disturb the others.
    expect(verified.documents.find((d) => d.label === 'id_back')?.status).toBe('pending');
  });

  it('rejects one uploaded document, requiring a reason', () => {
    const subject = withDocuments();
    expect(() => rejectKycDocument(subject, 'selfie', '', 'admin_a', LATER)).toThrow(
      InvalidOperationError,
    );

    const rejected = rejectKycDocument(subject, 'selfie', 'Blurry photo', 'admin_a', LATER);
    expect(rejected.documents.find((d) => d.label === 'selfie')).toMatchObject({
      status: 'rejected',
      reviewedBy: 'admin_a',
      rejectionReason: 'Blurry photo',
    });
  });

  it('refuses to review a label that was never uploaded', () => {
    expect(() => verifyKycDocument(request(), 'passport', 'admin_a', LATER)).toThrow(
      InvalidOperationError,
    );
    expect(() => rejectKycDocument(request(), 'passport', 'Not valid', 'admin_a', LATER)).toThrow(
      InvalidOperationError,
    );
  });

  it('gates on every required document being verified, per entity type', () => {
    const subject = withDocuments();
    expect(allRequiredDocumentsVerified(subject)).toBe(false);

    const oneVerified = verifyKycDocument(subject, 'id_front', 'admin_a', LATER);
    expect(allRequiredDocumentsVerified(oneVerified)).toBe(false);

    const allVerified = ['id_front', 'id_back', 'selfie'].reduce(
      (acc, label) => verifyKycDocument(acc, label, 'admin_a', LATER),
      subject,
    );
    expect(allRequiredDocumentsVerified(allVerified)).toBe(true);

    // A rejected (not merely missing) required document still blocks the gate.
    const oneRejected = rejectKycDocument(allVerified, 'selfie', 'Retake', 'admin_a', LATER);
    expect(allRequiredDocumentsVerified(oneRejected)).toBe(false);
  });
});
