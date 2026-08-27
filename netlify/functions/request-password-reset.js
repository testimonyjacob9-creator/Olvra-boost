// netlify/functions/request-password-reset.js
// HTTP FUNCTION — called from the app's "forgot password" form:
//   POST /.netlify/functions/request-password-reset
//   Body: { email }
//
// No auth required (the whole point is the user is logged out), but we
// always return a generic success message so this can't be used to check
// which emails have accounts.

const { auth } = require("./_lib/firebase-admin");
const { ok, fail } = require("./_lib/respond");
const { sendEmail, passwordResetEmail } = require("./_lib/brevo");

const GENERIC_RESPONSE = {
  message: "If an account exists for that email, a reset link has been sent.",
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const { email } = JSON.parse(event.body || "{}");
    if (!email) {
      throw Object.assign(new Error("email is required."), { statusCode: 400 });
    }

    try {
      const resetLink = await auth.generatePasswordResetLink(email, {
        // Where Firebase's reset link ultimately redirects after handling the action.
        url: process.env.APP_URL || "https://olvraboost.netlify.app",
      });

      const { subject, html } = passwordResetEmail({ resetLink });
      await sendEmail({ to: email, subject, html });
    } catch (err) {
      // Don't leak whether the email exists — log it, but still return the generic response.
      console.error("Password reset generation failed (likely unknown email):", err.message);
    }

    return ok(GENERIC_RESPONSE);
  } catch (err) {
    return fail(err);
  }
};
