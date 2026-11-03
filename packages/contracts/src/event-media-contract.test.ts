import { describe, expect, it } from 'vitest';

import { eventMediaSchema } from './contracts/event.js';

describe('event media URL validation', () => {
  it.each([
    'not-a-url',
    'http://youtube.com/watch?v=abc',
    'https://youtube.com.evil.test/watch',
    'https://youtube.com@evil.test/watch',
    'javascript:alert(1)',
  ])('rejects %s without throwing', (youtubeUrl) => {
    expect(eventMediaSchema.safeParse({ youtubeUrl, gallery: [], spotlights: [] }).success).toBe(
      false,
    );
  });
  it.each(['https://youtu.be/abc', 'https://www.youtube.com/watch?v=abc'])(
    'accepts %s',
    (youtubeUrl) => {
      expect(eventMediaSchema.safeParse({ youtubeUrl, gallery: [], spotlights: [] }).success).toBe(
        true,
      );
    },
  );
});
