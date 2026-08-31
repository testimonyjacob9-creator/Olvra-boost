// netlify/functions/debug-email-config.js
//
// TEMPORARY DIAGNOSTIC ENDPOINT — visit this URL directly in your browser:
//   https://yoursite.netlify.app/.netlify/functions/debug-email-config
//
// Confirms BREVO_API_KEY / BREVO_SENDER_EMAIL are set on Netlify, and does
// a live (harmless) auth check against Brevo's account endpoint — it never
// sends an email or exposes the actual API key. Delete this file once
// email delivery is confirmed working; it doesn't belong in a shipped app.

const axios = require("axios");

exports.handler = async () => {
  const report = { steps: [] };
  function step(name, ok, detail) {
    report.steps.push({ name, ok, detail });
  }

  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;

  step("BREVO_API_KEY present", !!apiKey, apiKey ? `length ${apiKey.length}` : "not set on Netlify");
  step("BREVO_SENDER_EMAIL present", !!senderEmail, senderEmail || "not set on Netlify");

  if (!apiKey) {
    return respond(report, false);
  }

  try {
    const res = await axios.get("https://api.brevo.com/v3/account", {
      headers: { "api-key": apiKey, Accept: "application/json" },
      timeout: 10000,
    });
    step("Brevo API key is valid", true, `account: ${res.data?.email || "verified"}`);
  } catch (err) {
    const status = err.response?.status;
    step(
      "Brevo API key is valid",
      false,
      status === 401
        ? "Key was rejected by Brevo (401) — it's wrong, revoked, or truncated."
        : `Brevo returned ${status || err.message}`
    );
  }

  if (senderEmail) {
    try {
      const res = await axios.get("https://api.brevo.com/v3/senders", {
        headers: { "api-key": apiKey, Accept: "application/json" },
        timeout: 10000,
      });
      const senders = (res.data?.senders || []).map((s) => s.email);
      const isVerified = senders.includes(senderEmail);
      step(
        "BREVO_SENDER_EMAIL is a verified sender on this Brevo account",
        isVerified,
        isVerified ? "verified" : `Not found in verified senders list: ${senders.join(", ") || "(none)"}`
      );
    } catch (err) {
      step("BREVO_SENDER_EMAIL is a verified sender on this Brevo account", false, "Couldn't check — see key validity above.");
    }
  }

  const allOk = report.steps.every((s) => s.ok);
  return respond(report, allOk);
};

function respond(report, allOk) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...report, overall: allOk ? "OK — email sending should work." : "ISSUE FOUND — see steps above." }, null, 2),
  };
}
