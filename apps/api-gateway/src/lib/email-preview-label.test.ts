import { describe, expect, it } from 'vitest';

import { escapeMarkdownLabel, extractPrimaryLabel } from './email-preview-label.js';

describe('email preview CTA label', () => {
  it('extracts and decodes the canonical action label once', () => {
    expect(
      extractPrimaryLabel(
        '<table><tr><td bgcolor="#ff5a00"><a href="/tickets">VIEW &amp; CLAIM</a></td></tr></table>',
      ),
    ).toBe('VIEW & CLAIM');
  });

  it('keeps encoded markup inert in the generated Markdown index', () => {
    const label = extractPrimaryLabel(
      '<table><tr><td bgcolor="#ff5a00"><a href="/">&lt;script&gt;alert(1)&lt;/script&gt;</a></td></tr></table>',
    );
    expect(escapeMarkdownLabel(label)).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('does not double-decode nested entities', () => {
    expect(
      extractPrimaryLabel(
        '<table><tr><td bgcolor="#ff5a00"><a href="/">&amp;lt;script&amp;gt;</a></td></tr></table>',
      ),
    ).toBe('&lt;script&gt;');
  });
});
