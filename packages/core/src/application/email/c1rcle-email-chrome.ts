/** Shared email-safe C1RCLE frame and actions used by transactional and auth emails. */
export function renderC1rcleEmailShell(preheader: string, rows: string): string {
  return `<div style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all">${escapeEmailHtml(preheader)}&#847;&zwnj;&nbsp;</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#080808" style="width:100%;background-color:#080808;color-scheme:dark,supported-color-schemes:dark;"><tr><td align="center" style="padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#080808" style="width:100%;max-width:520px;background-color:#080808;color:#f7f7f7;font-family:Arial,Helvetica,sans-serif;color-scheme:dark,supported-color-schemes:dark;">${rows}</table></td></tr></table>`;
}

export function renderC1rcleBrandHeader(): string {
  return '<tr><td style="padding:30px 24px 0;color:#ff5a00;font-size:12px;line-height:1.2;font-weight:800;letter-spacing:2.6px;">THE C1RCLE</td></tr>';
}

export function renderC1rcleEditorialEyebrow(label: string): string {
  return `<tr><td style="padding:30px 24px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="28" height="2" bgcolor="#ff5a00" style="width:28px;height:2px;background:#ff5a00;font-size:1px;line-height:1px;">&nbsp;</td><td style="padding-left:10px;color:#ff7540;font-size:10px;line-height:1.2;font-weight:800;letter-spacing:1.8px;">${escapeEmailHtml(label)}</td></tr></table></td></tr>`;
}

export function renderC1rclePrimaryCta(url: string, label: string): string {
  return `<tr><td style="padding:0 24px 34px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#ff5a00" style="background-color:#ff5a00;"><a href="${escapeEmailHtml(url)}" style="display:block;padding:18px 20px;color:#ffffff;font-size:13px;line-height:1.25;font-weight:800;letter-spacing:1.2px;text-align:center;text-decoration:none;">${escapeEmailHtml(label.toUpperCase())}<span style="padding-left:10px;">&#8594;</span></a></td></tr></table></td></tr>`;
}

export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
