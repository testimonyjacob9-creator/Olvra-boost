// _lib/brevo.js
// Thin wrapper around Brevo's transactional email API (v3), plus branded
// templates for every transactional email Olvra Boost sends.

const axios = require("axios");
const { renderEmail, MUTED } = require("./email-template");

const BREVO_BASE_URL = "https://api.brevo.com/v3";

async function sendEmail({ to, toName, subject, html, replyTo, attachment }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) {
    throw new Error("Missing BREVO_API_KEY or BREVO_SENDER_EMAIL env var.");
  }

  const payload = {
    sender: { email: senderEmail, name: "Olvra Boost" },
    to: [{ email: to, name: toName || to }],
    subject,
    htmlContent: html,
  };
  if (replyTo) payload.replyTo = { email: replyTo };
  if (attachment && attachment.content) {
    payload.attachment = [{ content: attachment.content, name: attachment.name || "screenshot.png" }];
  }

  await axios.post(`${BREVO_BASE_URL}/smtp/email`, payload, {
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: 15000,
  });
}

function orderConfirmationEmail({ serviceName, quantity, totalCharged, orderId, status }) {
  const rows = [
    ["Order ID", orderId],
    ["Service", serviceName],
    ["Quantity", quantity],
    ["Total charged", `₦${Number(totalCharged).toLocaleString()}`],
    ["Status", status || "processing"],
  ]
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:8px 0;color:${MUTED};font-size:13px;">${label}</td>
        <td style="padding:8px 0;text-align:right;font-weight:600;font-size:13px;">${value}</td>
      </tr>`
    )
    .join("");

  const body = `
    <p style="margin:0 0 16px;">Your order has been placed successfully — here's a quick summary:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E7ECF5;border-bottom:1px solid #E7ECF5;">
      ${rows}
    </table>
    <p style="margin:16px 0 0;">You can track live status from your Olvra Boost dashboard at any time.</p>
  `;

  return {
    subject: `Order confirmed — ${serviceName}`,
    html: renderEmail({
      title: "Order confirmed",
      bodyHtml: body,
      ctaText: "View order status",
      ctaUrl: process.env.APP_URL ? `${process.env.APP_URL}/orders.html` : undefined,
    }),
  };
}

function passwordResetEmail({ resetLink }) {
  const body = `
    <p style="margin:0 0 8px;">We received a request to reset your Olvra Boost password.</p>
    <p style="margin:0;">Tap the button below to choose a new one. This link expires in 1 hour.</p>
  `;
  return {
    subject: "Reset your Olvra Boost password",
    html: renderEmail({
      title: "Reset your password",
      bodyHtml: body,
      ctaText: "Reset password",
      ctaUrl: resetLink,
    }),
  };
}

function verificationCodeEmail({ name, code }) {
  const body = `
    <p style="margin:0 0 4px;">Hi ${name || "there"},</p>
    <p style="margin:0 0 20px;">Enter this code to verify your email address:</p>
    <div style="text-align:center;">
      <span style="display:inline-block;font-size:32px;font-weight:800;letter-spacing:10px;color:#2C5CF6;padding:14px 10px;background:#EEF3FF;border-radius:14px;">
        ${code}
      </span>
    </div>
    <p style="margin:20px 0 0;color:${MUTED};">This code expires in 10 minutes. Don't share it with anyone.</p>
  `;
  return {
    subject: "Your Olvra Boost verification code",
    html: renderEmail({ title: "Verify your email", bodyHtml: body }),
  };
}

function walletFundedEmail({ amount, newBalance }) {
  const body = `
    <p style="margin:0 0 16px;">Your wallet has been credited:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E7ECF5;border-bottom:1px solid #E7ECF5;">
      <tr><td style="padding:8px 0;color:${MUTED};font-size:13px;">Amount credited</td><td style="padding:8px 0;text-align:right;font-weight:600;font-size:13px;">₦${Number(amount).toLocaleString()}</td></tr>
      <tr><td style="padding:8px 0;color:${MUTED};font-size:13px;">New balance</td><td style="padding:8px 0;text-align:right;font-weight:600;font-size:13px;">₦${Number(newBalance).toLocaleString()}</td></tr>
    </table>
  `;
  return {
    subject: "Wallet funded — Olvra Boost",
    html: renderEmail({ title: "Wallet funded", bodyHtml: body }),
  };
}

function supportEscalationEmail({ userEmail, message, hasAttachment }) {
  const body = `
    <p style="margin:0 0 12px;">New support request from <strong>${userEmail}</strong> via the Olives chat widget${hasAttachment ? " (screenshot attached)" : ""}:</p>
    <div style="background:#EEF3FF;border-radius:12px;padding:14px 16px;white-space:pre-wrap;font-size:13.5px;line-height:1.6;">${escapeHtml(message)}</div>
    <p style="margin:16px 0 0;color:${MUTED};font-size:12.5px;">Reply directly to this email to respond to the customer.</p>
  `;
  return {
    subject: hasAttachment ? "Olives chat — screenshot attached" : "Olives chat escalation",
    html: renderEmail({ title: "Support request", bodyHtml: body }),
  };
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = {
  sendEmail,
  orderConfirmationEmail,
  passwordResetEmail,
  verificationCodeEmail,
  walletFundedEmail,
  supportEscalationEmail,
};
