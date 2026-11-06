import { describe, expect, it } from 'vitest';

import { htmlToPlainText } from './html-to-plain-text.js';

describe('htmlToPlainText', () => {
  it('keeps useful structure and decodes standard entities once', () => {
    expect(
      htmlToPlainText('<p>View <a href="https://example.test/a?x=1&amp;y=2">tickets</a></p>'),
    ).toBe('View tickets (https://example.test/a?x=1&y=2)');
  });

  it('does not turn nested escaped markup into markup during plain-text conversion', () => {
    expect(htmlToPlainText('<p>&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;</p>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('decodes encoded markup only into the plain-text result', () => {
    expect(htmlToPlainText('<p>&lt;script&gt;literal text&lt;/script&gt;</p>')).toBe(
      '<script>literal text</script>',
    );
  });
});
