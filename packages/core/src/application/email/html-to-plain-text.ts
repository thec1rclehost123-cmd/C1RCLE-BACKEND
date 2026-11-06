import { decode } from 'html-entities';

/**
 * Convert rendered email markup to readable text and decode entities once.
 * The result is plain text only: callers put it in `TransactionalEmail.text`,
 * compare it as a label, or re-escape it through `renderC1rclePrimaryCta`.
 * Never interpolate this decoded value directly into HTML.
 */
export function htmlToPlainText(html: string): string {
  const text = html
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<\/(p|li|h[1-6]|div|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ');

  return decode(text, { level: 'html5' })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
