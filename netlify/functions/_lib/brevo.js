// _lib/brevo.js
// Thin wrapper around Brevo's transactional email API (v3).

const axios = require("axios");

const BREVO_BASE_URL = "https://api.brevo.com/v3";

async function sendEmail({ to, toName, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) {
    throw new Error("Missing BREVO_API_KEY or BREVO_SENDER_EMAIL env var.");
  }

  await axios.post(
    `${BREVO_BASE_URL}/smtp/email`,
    {
      sender: { email: senderEmail, name: "Olvra Boost" },
      to: [{ email: to, name: toName || to }],
      subject,
      htmlContent: html,
    },
    {
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 15000,
    }
  );
}

function orderConfirmationEmail({ serviceName, quantity, totalCharged, orderId }) {
  return {
    subject: `Order confirmed — ${serviceName}`,
    html: `
      <p>Your order has been placed successfully.</p>
      <ul>
        <li><strong>Order ID:</strong> ${orderId}</li>
        <li><strong>Service:</strong> ${serviceName}</li>
        <li><strong>Quantity:</strong> ${quantity}</li>
        <li><strong>Total charged:</strong> ₦${totalCharged}</li>
      </ul>
      <p>You can track its status from your Olvra Boost dashboard.</p>
    `,
  };
}

function passwordResetEmail({ resetLink }) {
  return {
    subject: "Reset your Olvra Boost password",
    html: `
      <p>We received a request to reset your password.</p>
      <p><a href="${resetLink}">Click here to reset your password</a>. This link expires in 1 hour.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  };
}

module.exports = { sendEmail, orderConfirmationEmail, passwordResetEmail };
