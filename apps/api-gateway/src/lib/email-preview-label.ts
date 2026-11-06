import { decode, encode } from 'html-entities';

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
