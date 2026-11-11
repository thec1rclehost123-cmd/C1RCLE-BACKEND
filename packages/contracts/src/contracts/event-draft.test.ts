import { describe, expect, it } from 'vitest';

import { eventDraftRequestSchema } from './event-draft.js';

describe('event draft request', () => {
  it('accepts versioned, allowlisted editor data including external location details', () => {
    expect(
      eventDraftRequestSchema.safeParse({
        schemaVersion: 1,
        data: {
          name: 'Event',
          description: 'Description',
          externalVenue: {
            name: 'Independent Hall',
            address: '12 Example Road',
            managerName: 'Manager',
            managerPhone: '+91 98765 43210',
            managerEmail: 'manager@example.test',
          },
          externalWorkflowKey: 'stable-retry-key',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields, credentials, and temporary or signed URLs', () => {
    const base = { schemaVersion: 1, data: { name: 'Event' } };
    expect(
      eventDraftRequestSchema.safeParse({ ...base, data: { ...base.data, secret: 'value' } })
        .success,
    ).toBe(false);
    expect(
      eventDraftRequestSchema.safeParse({
        ...base,
        data: { ...base.data, imageUrl: 'https://example.test/image?token=secret' },
      }).success,
    ).toBe(false);
    expect(
      eventDraftRequestSchema.safeParse({
        ...base,
        data: { ...base.data, artwork: { type: 'image', value: 'blob:temporary' } },
      }).success,
    ).toBe(false);
  });

  it('rejects a draft from an unsupported schema version', () => {
    expect(
      eventDraftRequestSchema.safeParse({ schemaVersion: 2, data: { name: 'Event' } }).success,
    ).toBe(false);
  });
});
