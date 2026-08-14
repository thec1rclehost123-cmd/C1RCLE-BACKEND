import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from './errors.js';
import { createVenue, updateVenueMenu } from './models/venue.js';

/**
 * ─── Venue menu ──────────────────────────────────────────────────────────────
 * The last Phase 0 carry-over: `/venues/:venueId/menu` could not be registered
 * because no `menu` field existed anywhere on the venue profile.
 */

const NOW = new Date('2026-08-13T10:00:00.000Z');
const LATER = new Date('2026-08-13T12:00:00.000Z');

const venue = () =>
  createVenue({
    id: 'ven_1',
    organizationId: 'org_1',
    ownerId: 'user_1',
    name: 'Sky Bar',
    slug: 'sky-bar',
    now: NOW,
  });

const section = (name: string, pricePaise: number | null = 45000) => ({
  name,
  items: [{ name: `${name} item`, pricePaise, tags: [] }],
});

describe('venue menu', () => {
  it('starts empty rather than absent, so a read never has to special-case null', () => {
    expect(venue().public.menu).toEqual({ sections: [], updatedAt: null });
  });

  it('replaces the menu wholesale and stamps the edit time', () => {
    const updated = updateVenueMenu(venue(), { sections: [section('Cocktails')], now: LATER });

    expect(updated.public.menu.sections).toHaveLength(1);
    expect(updated.public.menu.updatedAt).toBe(LATER.toISOString());
    expect(updated.version).toBe(2);
  });

  it('removes a section by omitting it — the reason this is a replace, not a merge', () => {
    const withTwo = updateVenueMenu(venue(), {
      sections: [section('Cocktails'), section('Food')],
      now: LATER,
    });
    const withOne = updateVenueMenu(withTwo, { sections: [section('Food')], now: LATER });

    // A merge could not express this at all.
    expect(withOne.public.menu.sections.map((s) => s.name)).toEqual(['Food']);
  });

  it('accepts a null price — "market price" is a real menu concept', () => {
    const updated = updateVenueMenu(venue(), {
      sections: [section('Specials', null)],
      now: LATER,
    });
    expect(updated.public.menu.sections[0]?.items[0]?.pricePaise).toBeNull();
  });

  it('rejects a negative price', () => {
    expect(() =>
      updateVenueMenu(venue(), { sections: [section('Broken', -1)], now: LATER }),
    ).toThrow(InvalidOperationError);
  });

  it('leaves the rest of the public profile untouched', () => {
    const before = venue();
    const after = updateVenueMenu(before, { sections: [section('Cocktails')], now: LATER });

    expect(after.public.name).toBe(before.public.name);
    expect(after.public.slug).toBe(before.public.slug);
    expect(after.private).toEqual(before.private);
  });
});
