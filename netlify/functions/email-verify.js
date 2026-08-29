// netlify/functions/email-verify.js
//
// Sends and confirms a 6-digit email verification code after signup.
// Codes live in Firestore (collection: emailVerifyCodes) with a 10-minute TTL.
// Ported from the same pattern used in WoodPayVTU's email-verify.js, wired
// up to this project's own _lib helpers (firebase-admin, brevo, respond).
//
// POST /.netlify/functions/email-verify
// Body (send):    { action: "send",    uid, email, name }
// Body (confirm): { action: "confirm", uid, code }
// Returns: { ok: true } or { error }  (uses this project's ok()/fail() shape)

const { db, auth } = require("./_lib/firebase-admin");
const { sendEmail, verificationCodeEmail } = require("./_lib/brevo");
const { ok, fail } = require("./_lib/respond");

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return fail(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }));
  }

  const { action, uid, email, name, code } = body;
  if (!action || !uid) {
    return fail(Object.assign(new Error("Missing action or uid."), { statusCode: 400 }));
  }

  try {
    if (action === "send") {
      if (!email) {
        throw Object.assign(new Error("Missing email."), { statusCode: 400 });
      }

      const newCode = genCode();
      const expiresAt = Date.now() + CODE_TTL_MS;

      await db.collection("emailVerifyCodes").doc(uid).set({ code: newCode, expiresAt, email });

      const { subject, html } = verificationCodeEmail({ name, code: newCode });
      let emailSent = true;
      let emailError = null;
      try {
        await sendEmail({ to: email, toName: name, subject, html });
      } catch (emailErr) {
        // Don't fail the whole request just because the email provider hiccuped —
        // the code is still stored so a retry can work — but DO tell the
        // client the truth, so it can show a real error instead of leaving
        // someone staring at a code screen with no code ever coming.
        console.error("email-verify send error:", emailErr.message);
        emailSent = false;
        emailError = "Verification email could not be sent right now.";
      }

      return ok({ ok: true, emailSent, error: emailError });
    }

    if (action === "confirm") {
      if (!code) {
        throw Object.assign(new Error("Missing code."), { statusCode: 400 });
      }

      const docRef = db.collection("emailVerifyCodes").doc(uid);
      const docSnap = await docRef.get();

      if (!docSnap.exists) {
        return ok({ ok: false, error: "No verification code found. Please request a new one." });
      }

      const stored = docSnap.data();
      if (Date.now() > stored.expiresAt) {
        return ok({ ok: false, error: "Code expired. Please request a new one." });
      }
      if (stored.code !== String(code).trim()) {
        return ok({ ok: false, error: "Incorrect code." });
      }

      await Promise.all([
        auth.updateUser(uid, { emailVerified: true }),
        docRef.delete(),
      ]);

      return ok({ ok: true });
    }

    return fail(Object.assign(new Error(`Unknown action: ${action}`), { statusCode: 400 }));
  } catch (err) {
    return fail(err);
  }
};
