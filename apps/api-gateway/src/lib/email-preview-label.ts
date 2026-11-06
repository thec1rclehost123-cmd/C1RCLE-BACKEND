import { decode, encode } from 'html-entities';

/**
 * Extract a label as plain text. It may contain decoded angle brackets; callers
 * must escape it for the output format before writing it. The preview index
 * uses `escapeMarkdownLabel` so raw labels are never parsed as Markdown HTML.
 */
export function extractPrimaryLabel(html: string): string {
  const match =
    /<td\b[^>]*bgcolor=["']#ff5a00["'][^>]*>\s*<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(html) ??
    /<a\b[^>]*style=["'][^"']*background:#ff5a00[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(html);
  if (!match?.[1]) return 'None (no canonical deep-link action available)';

  const label = decode(match[1].replace(/<[^>]*>/g, ''), { level: 'html5' }).trim();
  return label || 'None (no canonical deep-link action available)';
}

/** Keep labels displayable in Markdown while preventing raw HTML interpretation. */
export function escapeMarkdownLabel(value: string): string {
  return encode(value, { level: 'html5' });
}
