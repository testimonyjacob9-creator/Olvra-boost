// _lib/email-template.js
// One shared branded wrapper so every email (verification, password reset,
// order confirmation) looks consistent instead of being plain unstyled HTML.
// Inline CSS only — most email clients (Gmail, Outlook) strip <style> blocks.

const BRAND_BLUE = "#2C5CF6";
const BRAND_BLUE_DEEP = "#1339B0";
const TEXT = "#10162B";
const MUTED = "#6B7590";
const BORDER = "#E7ECF5";
const BG = "#F4F7FE";

/**
 * @param {string} title       - shown as the big heading inside the card
 * @param {string} bodyHtml    - inner content, plain inline-styled HTML
 * @param {string} [ctaText]   - optional button label
 * @param {string} [ctaUrl]    - optional button link
 */
function renderEmail({ title, bodyHtml, ctaText, ctaUrl }) {
  const button = ctaText && ctaUrl
    ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px">
        <tr>
          <td style="border-radius:12px;background:linear-gradient(135deg,${BRAND_BLUE},${BRAND_BLUE_DEEP})">
            <a href="${ctaUrl}" style="display:inline-block;padding:14px 28px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">
              ${ctaText}
            </a>
          </td>
        </tr>
      </table>`
    : "";

  return `
  <div style="background:${BG};padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;">
      <tr>
        <td style="padding-bottom:20px;text-align:center;">
          <span style="font-size:20px;font-weight:800;color:${TEXT};letter-spacing:-0.02em;">
            Olvra <span style="color:${BRAND_BLUE}">Boost</span>
          </span>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;border:1px solid ${BORDER};border-radius:20px;padding:32px 28px;box-shadow:0 6px 22px rgba(23,43,133,0.08);">
          <h1 style="margin:0 0 14px;font-size:19px;color:${TEXT};font-weight:700;">${title}</h1>
          <div style="font-size:14px;line-height:1.6;color:${TEXT};">
            ${bodyHtml}
          </div>
          ${button}
        </td>
      </tr>
      <tr>
        <td style="padding-top:22px;text-align:center;font-size:12px;color:${MUTED};line-height:1.6;">
          Olvra Boost — social media growth, delivered.<br>
          If you didn't expect this email, you can safely ignore it.
        </td>
      </tr>
    </table>
  </div>`;
}

module.exports = { renderEmail, BRAND_BLUE, MUTED };
