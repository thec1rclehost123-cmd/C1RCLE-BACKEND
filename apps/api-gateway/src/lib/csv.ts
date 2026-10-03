/**
 * Shared CSV cell escaper for every admin desk's `export.csv` route.
 *
 * Quotes and escapes per RFC 4180, and additionally neutralizes formula
 * injection: a cell whose first character is `=`, `+`, `-`, `@`, tab, or CR
 * is interpreted as a formula by Excel/Sheets/LibreOffice when the CSV is
 * opened — a value like `=HYPERLINK(...)` sourced from admin-controlled data
 * (a venue name, a promo code, a refund reason) would execute in whoever
 * opens the export. Prefixing with `'` forces those tools to treat it as
 * plain text while leaving the CSV value itself unchanged.
 */
export function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
