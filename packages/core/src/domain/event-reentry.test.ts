import { describe, expect, it } from 'vitest';

import { createEvent, updateEvent } from './models/event.js';

const input = {
  id: 'night',
  organizationId: 'host',
  venueId: 'venue',
  title: 'Night',
  startAt: '2099-11-10T20:00:00.000Z',
};
const entryRules = {
  doorsOpenAt: null,
  lastEntryAt: null,
  reentryAllowed: true,
  minimumAge: null,
  idRequired: null,
  accessibilityNotes: null,
  dressCode: null,
  alcoholPolicy: null,
  prohibitedItems: [],
  supportDetails: null,
};
describe('V1 no automatic re-entry', () => {
  it('rejects new events and explicit edits promising unsupported re-entry', () => {
    expect(() => createEvent({ ...input, entryRules })).toThrow(
      'Automatic re-entry is unavailable',
    );
    const event = createEvent(input);
    expect(() => updateEvent(event, { entryRules })).toThrow('Automatic re-entry is unavailable');
    expect(
      updateEvent(event, { entryRules: { ...entryRules, reentryAllowed: false } }).entryRules
        ?.reentryAllowed,
    ).toBe(false);
  });
});
