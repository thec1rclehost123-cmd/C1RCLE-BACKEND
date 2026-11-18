import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCheckpoint, execute, validateCheckpoint } from './checkpoint.mjs';

const authority = {
  fixtures: {
    fixtures: [{ id: 'guest_canonical_paid_event' }],
    requirements: [{ id: 'partner_slot_accept' }],
  },
  findings: { findings: [{ id: 'GUEST-RSVP-001' }] },
  acceptance: {
    guest: [{ id: 'guest.event-price-cta' }, { id: 'guest.paid-fulfillment' }],
    partner: [{ id: 'partner.host.create-request' }, { id: 'partner.venue.slot-decision' }],
  },
};

async function withStore(run) {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'c1rcle-checkpoint-'));
  try {
    await run({
      storageDir,
      call: (args) =>
        execute(args, { storageDir, authority, now: new Date('2026-11-17T12:00:00.000Z') }),
    });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
}

test('Guest hosted audit resumes at the exact next safe boundary', async () => {
  await withStore(async ({ call }) => {
    const created = await call([
      'create',
      '--id',
      'cp-guest-audit',
      '--workflow',
      'hosted-audit',
      '--task',
      'Guest audit',
      '--role',
      'Guest=Guest Complete',
      '--credential-ref',
      'C1RCLE_QA_GUEST_COMPLETE',
      '--fixture',
      'guest_canonical_paid_event',
      '--session-state',
      'SESSION_MUST_BE_RECREATED',
      '--browser-position',
      'Canonical event detail; quote not started',
      '--next-action',
      'Verify Step 10 deployment and auth, then check the event price CTA.',
    ]);
    assert.equal(created.code, 0);
    await call([
      'record',
      'cp-guest-audit',
      'result',
      '--item-id',
      'guest.event-price-cta',
      '--result',
      'PASS',
      '--source',
      'REUSED',
    ]);
    const resumed = await call(['resume', 'cp-guest-audit', '--json']);
    const packet = JSON.parse(resumed.output);
    assert.equal(packet.fixture_ids[0], 'guest_canonical_paid_event');
    assert.equal(packet.acceptance_results[0].source, 'REUSED');
    assert.match(packet.next_action, /event price CTA/);
    assert.match(packet.step10_read_only_commands.join('\n'), /acceptance:prepare/);
    assert.equal(packet.mutations.length, 0);
    assert.match(packet.missing_fixture_rule, /do not search staging randomly/);
  });
});

test('payment owner handoff resumes by reconciling the same order without another payment', async () => {
  await withStore(async ({ call }) => {
    await call([
      'create',
      '--id',
      'cp-payment',
      '--workflow',
      'hosted-audit',
      '--task',
      'Guest payment handoff',
      '--next-action',
      'Review the canonical total.',
    ]);
    await call([
      'record',
      'cp-payment',
      'step',
      '--text',
      'Quote and Review Order total ₹636.78 confirmed.',
    ]);
    await call([
      'record',
      'cp-payment',
      'object',
      '--type',
      'order',
      '--object-id',
      'order_test_123',
    ]);
    await call([
      'wait-owner',
      'cp-payment',
      '--action',
      'Owner completes Razorpay Test Mode checkout for order_test_123.',
      '--next-action',
      'Wait for owner completion; do not create another payment.',
    ]);
    let packet = JSON.parse((await call(['resume', 'cp-payment', '--json'])).output);
    assert.equal(packet.provider_state, 'WAITING_FOR_OWNER');
    assert.equal(packet.object_ids[0].id, 'order_test_123');
    assert.match(packet.next_action, /do not create another payment/);
    await call([
      'owner-done',
      'cp-payment',
      '--next-action',
      'Reconcile the same order, inventory and ticket; do not retry payment.',
    ]);
    packet = JSON.parse((await call(['resume', 'cp-payment', '--json'])).output);
    assert.equal(packet.provider_state, 'OWNER_COMPLETED_ACTION');
    assert.equal(packet.human_action_pending, null);
    assert.equal(packet.object_ids[0].id, 'order_test_123');
    assert.match(packet.next_action, /same order/);
    assert.match(packet.authority_note, /do not replay completed actions/);
  });
});

test('Partner cross-role resume preserves the same Venue request identity', async () => {
  await withStore(async ({ call }) => {
    await call([
      'create',
      '--id',
      'cp-partner-request',
      '--workflow',
      'cross-role-acceptance',
      '--task',
      'Venue decision',
      '--role',
      'Host=Host A',
      '--role',
      'Venue=Venue A',
      '--next-action',
      'Switch to Venue and decide the submitted request.',
    ]);
    await call([
      'record',
      'cp-partner-request',
      'mutation',
      '--type',
      'slot_request',
      '--object-id',
      'request_same_456',
      '--action',
      'Host submitted request',
      '--observed-result',
      'Request pending Venue decision',
      '--reversible',
      'UNKNOWN',
      '--reset-required',
      'UNKNOWN',
    ]);
    const packet = JSON.parse((await call(['resume', 'cp-partner-request', '--json'])).output);
    assert.equal(packet.object_ids[0].id, 'request_same_456');
    assert.match(packet.next_action, /Venue/);
    assert.match(packet.step10_read_only_commands.join('\n'), /prepare (host|venue)/);
  });
});

test('blocked unprovisioned fixture packet directs to requirements, not random staging discovery', async () => {
  await withStore(async ({ call }) => {
    await call([
      'create',
      '--id',
      'cp-missing-fixture',
      '--workflow',
      'cross-role-acceptance',
      '--task',
      'Accept flow',
      '--fixture',
      'partner_slot_accept',
      '--next-action',
      'Wait for the slot request requirement to be provisioned and bound.',
    ]);
    await call([
      'block',
      'cp-missing-fixture',
      '--reason',
      'Accept request requirement has no usable locator yet.',
      '--next-action',
      'Wait for approved provisioning and binding; do not search staging randomly.',
    ]);
    const packet = JSON.parse((await call(['resume', 'cp-missing-fixture', '--json'])).output);
    assert.equal(packet.status, 'BLOCKED');
    assert.equal(packet.fixture_ids[0], 'partner_slot_accept');
    assert.match(packet.missing_fixture_rule, /consult STAGING_FIXTURES.json requirements/i);
    assert.match(packet.next_action, /do not search staging randomly/);
  });
});

test('secret fields and secret-like values are rejected while credential labels validate', () => {
  const checkpoint = createCheckpoint(
    {
      checkpoint_id: 'cp-secret-check',
      workflow: 'hosted-audit',
      task: 'Secret rejection',
      next_action: 'Continue safely.',
      credential_refs: ['C1RCLE_QA_GUEST_COMPLETE'],
    },
    new Date('2026-11-17T12:00:00.000Z'),
  );
  assert.deepEqual(validateCheckpoint(checkpoint, authority), []);
  assert.ok(
    validateCheckpoint({ ...checkpoint, password: 'not-stored' }, authority).some((error) =>
      error.includes('secret/session fields'),
    ),
  );
  assert.ok(
    validateCheckpoint(
      { ...checkpoint, notes: ['authorization: Bearer abcdefghijklmnop'] },
      authority,
    ).some((error) => error.includes('secret-like')),
  );
  assert.ok(
    validateCheckpoint({ ...checkpoint, notes: ['token: abcdefghijklmnop'] }, authority).some(
      (error) => error.includes('secret-like'),
    ),
  );
  for (const field of [
    'otp',
    'cookie',
    'authorization',
    'bypass_token',
    'api_key',
    'card_number',
    'razorpay_secret',
  ]) {
    assert.ok(
      validateCheckpoint({ ...checkpoint, [field]: 'x' }, authority).length > 0,
      `${field} must be rejected`,
    );
  }
});

test('CLI rejects unknown secret options and exports only a validated checkpoint', async () => {
  await withStore(async ({ call }) => {
    await assert.rejects(
      call([
        'create',
        '--workflow',
        'hosted-audit',
        '--task',
        'CLI secret guard',
        '--next-action',
        'Continue safely.',
        '--password',
        'do-not-store',
      ]),
      /unknown option: password/,
    );
    await call([
      'create',
      '--id',
      'cp-export-check',
      '--workflow',
      'hosted-audit',
      '--task',
      'Export check',
      '--credential-ref',
      'C1RCLE_QA_GUEST_COMPLETE',
      '--next-action',
      'Resume after verification.',
    ]);
    const exported = JSON.parse((await call(['export', 'cp-export-check'])).output);
    assert.equal(exported.credential_refs[0], 'C1RCLE_QA_GUEST_COMPLETE');
    assert.equal(Object.hasOwn(exported, 'password'), false);
    await call(['complete', 'cp-export-check']);
    await assert.rejects(call(['resume', 'cp-export-check']), /not resumable/);
  });
});

test('fixture, finding, acceptance, and workflow references are validated offline', () => {
  const checkpoint = createCheckpoint(
    {
      checkpoint_id: 'cp-reference-check',
      workflow: 'hosted-audit',
      task: 'Reference checks',
      next_action: 'Continue.',
      fixture_ids: ['missing_fixture'],
      finding_ids: ['MISSING-001'],
    },
    new Date('2026-11-17T12:00:00.000Z'),
  );
  const errors = validateCheckpoint(checkpoint, authority);
  assert.ok(errors.some((error) => error.includes('unknown fixture/requirement ID')));
  assert.ok(errors.some((error) => error.includes('unknown finding ID')));
  assert.ok(
    validateCheckpoint({ ...checkpoint, workflow: 'other' }, authority).some((error) =>
      error.includes('workflow'),
    ),
  );
  checkpoint.fixture_ids = ['guest_canonical_paid_event'];
  checkpoint.finding_ids = ['GUEST-RSVP-001'];
  assert.deepEqual(validateCheckpoint(checkpoint, authority), []);
});
