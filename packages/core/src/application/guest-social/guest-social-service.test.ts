import { beforeEach, describe, expect, it, vi } from 'vitest';

import { changeEntitlementHolder } from '../../domain/models/entitlement.js';
import { createEvent } from '../../domain/models/event.js';
import { createGuestProfile } from '../../domain/models/guest-profile.js';
import { createOrganization } from '../../domain/models/organization.js';
import { MemoryGuestSocialRepository } from '../../infrastructure/memory/memory-guest-social-repository.js';
import { type MemoryUserAccountRepository } from '../../infrastructure/memory/memory-user-account-repository.js';
import { buildRepositories } from '../../infrastructure/utils.js';

import { GuestSocialService } from './guest-social-service.js';

import type { Entitlement } from '../../domain/models/entitlement.js';
import type { Event } from '../../domain/models/event.js';
import type { TicketTransfer } from '../../domain/models/ticket-transfer.js';

const NOW = new Date('2026-11-04T00:00:00Z');
const consent = { profileVisible: true, showOnGuestlists: true, showUpcomingEvents: true };
const actor = {
  userId: 'host-owner',
  organizationId: 'org-social',
  role: 'owner' as const,
  capabilities: ['host'] as const,
};
function entitlement(
  id: string,
  holder: string | null,
  extra: Partial<Entitlement> = {},
): Entitlement {
  return {
    id,
    eventId: 'event-social',
    organizationId: 'org-social',
    orderId: 'private-order',
    tierId: 'private-tier',
    tierName: 'General',
    userId: 'purchaser-c',
    currentHolderUserId: holder,
    holderName: 'Private admission name',
    status: 'valid',
    scanCountAllowed: 1,
    scanCount: 0,
    scannedAt: [],
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...extra,
  };
}
async function setup() {
  const repositories = buildRepositories({
    STORAGE_DRIVER: 'memory',
    FIRESTORE_PROJECT_ID: 'synthetic',
  });
  const social = new MemoryGuestSocialRepository();
  let seq = 0;
  const service = new GuestSocialService({
    repositories,
    social,
    config: { clock: { now: () => NOW }, ids: () => `report-${++seq}` },
  });
  for (const id of ['guest-a', 'guest-b', 'purchaser-c', 'partner-p', 'unverified', 'incomplete']) {
    (repositories.users as MemoryUserAccountRepository).save({
      id,
      email: `private-${id}@example.invalid`,
      image: 'https://example.invalid/avatar.png',
      name: `Auth ${id}`,
      role: id === 'partner-p' ? 'partner' : 'guest',
      emailVerified: id !== 'unverified',
      createdAt: 0,
      updatedAt: 0,
    });
    await repositories.guestProfiles.save({
      ...createGuestProfile(id, {
        displayName: `Name ${id}`,
        dateOfBirth: '2000-01-01',
        city: 'Private City',
        tastes: ['House', 'private joining text'],
        intents: ['private reason'],
      }),
      ...(id !== 'incomplete'
        ? { phoneNumber: '+919000000041', phoneVerifiedAt: NOW.toISOString() }
        : {}),
    });
  }
  await repositories.organizations.save(
    createOrganization({
      id: actor.organizationId,
      ownerId: actor.userId,
      name: 'Synthetic Host',
      slug: 'synthetic-host',
      capabilities: ['host'],
    }),
  );
  const event: Event = {
    ...createEvent({
      id: 'event-social',
      organizationId: actor.organizationId,
      venueId: 'venue-social',
      title: 'Future Social Event',
      startAt: '2026-12-01T18:00:00Z',
      endAt: '2026-12-02T01:00:00Z',
    }),
    status: 'published',
    isPublic: true,
  };
  await repositories.events.save(event);
  return { service, social, repositories, event };
}

describe('Guest social privacy and authoritative holder projections', () => {
  let context: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    context = await setup();
  });
  it('keeps all old/new profiles private until explicit consent', async () => {
    const { service } = context;
    expect(await service.getPrivacy('guest-a')).toMatchObject({
      profileVisible: false,
      showOnGuestlists: false,
      showUpcomingEvents: false,
    });
    await expect(service.getProfile('guest-a', 'guest-b')).rejects.toThrow('not found');
  });
  it.each(['partner-p', 'unverified', 'incomplete', 'missing-user'])(
    'denies ineligible social viewer %s',
    async (id) => {
      await context.social.savePrivacy('guest-b', consent);
      await expect(context.service.getProfile(id, 'guest-b')).rejects.toThrow('Guest account');
    },
  );
  it('projects only approved identity fields and curated interests', async () => {
    await context.service.savePrivacy('guest-b', consent);
    const result = await context.service.getProfile('guest-a', 'guest-b');
    expect(result.identity).toEqual({
      id: 'guest-b',
      displayName: 'Name guest-b',
      avatarUrl: 'https://example.invalid/avatar.png',
      interests: ['House'],
    });
    const body = JSON.stringify(result);
    for (const secret of [
      'private-guest-b@',
      '2000-01-01',
      '+919000000041',
      'Private City',
      'private reason',
      'private joining text',
      'phoneVerifiedAt',
    ])
      expect(body).not.toContain(secret);
  });
  it('requires organizer AND Guest consent, and counts people rather than ticket quantity', async () => {
    const { service, social, repositories } = context;
    await service.savePrivacy('guest-a', consent);
    await service.savePrivacy('guest-b', consent);
    await service.savePrivacy('purchaser-c', consent);
    for (const ticket of [
      entitlement('ticket-a1', 'guest-a', { scanCountAllowed: 2 }),
      entitlement('ticket-a2', 'guest-a'),
      entitlement('ticket-b', 'guest-b', { unitKind: 'free_rsvp' }),
      entitlement('unclaimed', null),
    ])
      await repositories.entitlements.save(ticket);
    await expect(service.guestlist('guest-a', 'event-social')).rejects.toThrow();
    await social.setEventEnabled('event-social', true);
    const page = await service.guestlist('guest-a', 'event-social', 0, 1);
    expect(page.visibleCount).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('1');
    expect(
      (await service.guestlist('guest-a', 'event-social', 1, 1)).items.map((item) => item.id),
    ).toEqual(['guest-b']);
    await service.savePrivacy('guest-b', { ...consent, showOnGuestlists: false });
    expect((await service.guestlist('guest-a', 'event-social')).visibleCount).toBe(1);
  });
  it('does not infer attendance from a purchaser or explicit unclaimed unit', async () => {
    const { service, social, repositories } = context;
    await service.savePrivacy('purchaser-c', consent);
    await social.setEventEnabled('event-social', true);
    await repositories.entitlements.save(entitlement('unclaimed', null));
    expect((await service.getProfile('guest-a', 'purchaser-c')).upcomingEvents).toEqual([]);
  });
  it('moves attendance on actual canonical holder change, preserving no old-holder attendance', async () => {
    const { service, social, repositories } = context;
    await service.savePrivacy('guest-a', consent);
    await service.savePrivacy('guest-b', consent);
    await social.setEventEnabled('event-social', true);
    const ticket = entitlement('transfer-ticket', 'guest-a');
    await repositories.entitlements.save(ticket);
    expect((await service.getProfile('guest-b', 'guest-a')).upcomingEvents).toHaveLength(1);
    const transferred = changeEntitlementHolder(ticket, {
      expectedCurrentHolderUserId: 'guest-a',
      nextHolderUserId: 'guest-b',
      holderName: 'Accepted Guest',
      now: NOW,
    });
    await repositories.entitlements.save(transferred);
    expect((await service.getProfile('guest-b', 'guest-a')).upcomingEvents).toEqual([]);
    expect((await service.getProfile('guest-a', 'guest-b')).upcomingEvents).toHaveLength(1);
    expect(
      (await service.guestlist('guest-a', 'event-social')).items.map((item) => item.id),
    ).toEqual(['guest-b']);
  });
  it('hides one event from both profile and guestlist without touching operational admission', async () => {
    const { service, social, repositories } = context;
    await service.savePrivacy('guest-b', consent);
    await social.setEventEnabled('event-social', true);
    const ticket = entitlement('hidden-ticket', 'guest-b');
    await repositories.entitlements.save(ticket);
    await service.hideEvent('guest-b', 'event-social', true);
    expect((await service.getProfile('guest-a', 'guest-b')).upcomingEvents).toEqual([]);
    expect((await service.guestlist('guest-a', 'event-social')).visibleCount).toBe(0);
    expect(await repositories.entitlements.getById(ticket.id)).toEqual(ticket);
    await service.hideEvent('guest-b', 'event-social', false);
    expect((await service.getProfile('guest-a', 'guest-b')).upcomingEvents).toHaveLength(1);
  });
  it.each(['void', 'refund-lock', 'frozen-transfer'])(
    'excludes %s admission rights',
    async (state) => {
      const { service, social, repositories } = context;
      await service.savePrivacy('guest-b', consent);
      await social.setEventEnabled('event-social', true);
      await repositories.entitlements.save(
        entitlement(
          'inactive-ticket',
          'guest-b',
          state === 'void'
            ? { status: 'void' }
            : state === 'refund-lock'
              ? { refundLock: { refundRequestId: 'refund-private', frozenAt: NOW.toISOString() } }
              : { pendingTransferId: 'frozen-transfer' },
        ),
      );
      vi.spyOn(repositories.entitlements, 'getTicketTransfer').mockResolvedValue({
        status: 'frozen',
      } as TicketTransfer);
      expect((await service.getProfile('guest-a', 'guest-b')).upcomingEvents).toEqual([]);
      expect((await service.guestlist('guest-a', 'event-social')).visibleCount).toBe(0);
    },
  );
  it.each(['cancelled', 'ended', 'private', 'past'])(
    'does not share %s event attendance',
    async (state) => {
      const { service, social, repositories, event } = context;
      await service.savePrivacy('guest-b', consent);
      await social.setEventEnabled(event.id, true);
      await repositories.entitlements.save(entitlement('event-state-ticket', 'guest-b'));
      await repositories.events.save({
        ...event,
        version: 2,
        ...(state === 'cancelled' || state === 'ended'
          ? { status: state }
          : state === 'private'
            ? { visibilityMode: 'invited' }
            : { startAt: '2026-10-01T18:00:00Z', endAt: '2026-10-02T01:00:00Z' }),
      });
      expect((await service.getProfile('guest-a', 'guest-b')).upcomingEvents).toEqual([]);
      await expect(service.guestlist('guest-a', event.id)).rejects.toThrow();
    },
  );
  it('applies blocks reciprocally to profiles, rows and social counts only', async () => {
    const { service, social, repositories } = context;
    await service.savePrivacy('guest-a', consent);
    await service.savePrivacy('guest-b', consent);
    await social.setEventEnabled('event-social', true);
    const ticket = entitlement('blocked-ticket', 'guest-b');
    await repositories.entitlements.save(ticket);
    await service.block('guest-a', 'guest-b', true);
    await expect(service.getProfile('guest-a', 'guest-b')).rejects.toThrow();
    await expect(service.getProfile('guest-b', 'guest-a')).rejects.toThrow();
    expect((await service.guestlist('guest-a', 'event-social')).visibleCount).toBe(0);
    expect(await repositories.entitlements.getById(ticket.id)).toEqual(ticket);
    await service.block('guest-a', 'guest-b', false);
    expect((await service.guestlist('guest-a', 'event-social')).visibleCount).toBe(1);
  });
  it('creates a real support report without revealing private target data or auto-banning', async () => {
    const { service, repositories } = context;
    const result = await service.report(
      'guest-a',
      'guest-b',
      'safety',
      'Synthetic report reason only.',
    );
    const saved = await repositories.supportTickets.getById(result.reference);
    expect(saved).toMatchObject({
      subject: 'Guest report: safety',
      requester: { userId: 'guest-a', email: null },
      links: { userId: 'guest-b' },
    });
    expect(saved?.description).not.toContain('private-guest-b@example.invalid');
    expect(await repositories.userBans.getByUserId('guest-b')).toBeNull();
  });
  it('authorizes organizer policy without modifying operational event fields', async () => {
    const { service, repositories, event } = context;
    await expect(
      service.setEventPolicy({ ...actor, userId: 'stranger' }, event.id, true),
    ).rejects.toThrow();
    await service.setEventPolicy(actor, event.id, true);
    expect(await repositories.events.getById(event.id)).toEqual(event);
  });
  it('uses the authoritative rescheduled event date without parallel social event state', async () => {
    const { service, social, repositories, event } = context;
    await service.savePrivacy('guest-b', consent);
    await social.setEventEnabled(event.id, true);
    await repositories.entitlements.save(entitlement('postponed-ticket', 'guest-b'));
    await repositories.events.save({
      ...event,
      version: 2,
      startAt: '2027-02-01T18:00:00Z',
      endAt: '2027-02-02T01:00:00Z',
    });
    expect((await service.getProfile('guest-a', 'guest-b')).upcomingEvents[0]?.startAt).toBe(
      '2027-02-01T18:00:00Z',
    );
  });
  it('does not disclose a private display name when blocking a guessed opaque ID', async () => {
    const { service } = context;
    await service.block('guest-a', 'guest-b', true);
    expect((await service.getPrivacy('guest-a')).blockedUsers).toEqual([
      { id: 'guest-b', displayName: 'Guest' },
    ]);
  });
});
