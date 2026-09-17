// _lib/admin-alert.js
//
// Best-effort email to the admin inbox the moment a money-handling
// function hits a real failure — amount mismatch, unmatched reference, a
// thrown error mid wallet-credit/debit, a refund that itself failed, etc.
//
// Ported from WoodPayVTU's _adminAlert.js pattern, rebuilt on top of
// Olvra Boost's own Brevo wrapper (sendEmail in ./brevo) and shared email
// template (./email-template) instead of duplicating Brevo's HTTP call —
// this gets the same retry-on-5xx/429 behavior every other Olvra email
// already gets, for free.
//
// Branding matches WoodPayVTU's "Olives" persona EXACTLY — same automated-
// backend-assistant identity, same 🫒 prefix, same sender-name convention
// ("Olives from WoodPay" -> "Olives from Olvra Boost"). See WoodPayVTU's
// _notify.js (`from === 'admin' ? title : '🫒 Olives — ${title}'`) and its
// reengage-inactive-users.js / price-alert.js (`sender: { name: 'Olives
// from WoodPay', ... }`). Olvra already uses this identical convention for
// user-facing automated mail (see reengage-users.js: "🫒 Olives here —
// just checking in") — this just extends the same persona to admin alerts.
//
// Before this, every failure branch in the money-handling functions
// (flutterwave-webhook.js, verify-onetime-payment.js, place-order.js,
// buy-number.js, buy-hosting.js, refund-expired-numbers.js...) just did
// console.error() and moved on — invisible until a user complained.
//
// Never let this fail the caller's real request: sendAdminFailureAlert
// swallows and logs its own errors, same best-effort posture as every
// other non-critical notification in this codebase (see e.g. the
// notification try/catches in place-order.js).

const { sendEmail } = require("./brevo");
const { renderEmail, MUTED } = require("./email-template");

// Same fallback admin address contact-support.js emails to. Override with
// ADMIN_NOTIFY_EMAIL if the admin ever wants alerts routed somewhere else
// (e.g. a distribution list) without touching code.
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || "testimonyjacob9@gmail.com";

function escapeHtml(str) {
  return String(str == null ? "—" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function row(label, value) {
  return `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #E7ECF5;color:${MUTED};font-size:13px;">${escapeHtml(label)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #E7ECF5;font-weight:600;font-size:13px;text-align:right;">${escapeHtml(value)}</td>
    </tr>`;
}

/**
 * @param {object} details
 * @param {string} details.source    - which function/branch raised this, e.g. "flutterwave-webhook.js — unhandled error"
 * @param {string} [details.txType]  - e.g. "wallet_funding_dynamic", "order_refund_auto"
 * @param {number} [details.amount]  - naira amount involved, if known
 * @param {string} [details.ref]     - Flutterwave tx_ref, order id, or other reference
 * @param {string} [details.reason]  - human-readable reason the branch failed
 * @param {string} [details.userEmail]
 * @param {string} [details.uid]
 */
async function sendAdminFailureAlert(details = {}) {
  try {
    const when = new Date().toLocaleString("en-NG", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Lagos",
    });

    const bodyHtml = `
      <p style="margin:0 0 16px;">A money-handling function just hit a failure branch. Details below:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E7ECF5;">
        ${row("Source", details.source || "unknown")}
        ${details.txType ? row("Transaction type", details.txType) : ""}
        ${details.amount != null ? row("Amount", `₦${Number(details.amount).toLocaleString()}`) : ""}
        ${row("Reference", details.ref || "—")}
        ${row("Reason", details.reason || "—")}
        ${row("User email", details.userEmail || "—")}
        ${details.uid ? row("User UID", details.uid) : ""}
        ${row("Time (Lagos)", when)}
      </table>
    `;

    await sendEmail({
      to: ADMIN_NOTIFY_EMAIL,
      senderName: "Olives from Olvra Boost",
      subject: `🫒 Olives — Failed transaction — ${details.txType || "transaction"}${details.ref ? " — " + details.ref : ""}`,
      html: renderEmail({ title: "🫒 Olives — Failed transaction alert", bodyHtml }),
    });
    return { ok: true };
  } catch (err) {
    // Never let an alert-email failure break the caller's real request.
    console.error("_lib/admin-alert: sendAdminFailureAlert failed:", err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = { sendAdminFailureAlert };
