// netlify/functions/pin-reset.js
//
// Reset a forgotten Transaction PIN via a code emailed to the user's
// registered address — same shape as email-verify.js's send/confirm
// pattern. This intentionally does NOT require the current PIN (that's
// the whole point of a reset path), but does require proving control of
// the account's email, which only the real owner can do.
//
// POST /.netlify/functions/pin-reset
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body (send):    { action: "send" }
//   Body (confirm): { action: "confirm", code, newPin }

const crypto = require("crypto");
const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const { sendEmail, pinResetCodeEmail } = require("./_lib/brevo");
const { hashPin } = require("./_lib/pin");

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    const uid = decoded.uid;

    let body;
    try { body = JSON.parse(event.body || "{}"); } catch {
      throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 });
    }
    const { action } = body;

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw Object.assign(new Error("User not found."), { statusCode: 404 });
    const userData = userSnap.data();
    const email = userData.email || decoded.email;
    if (!email) throw Object.assign(new Error("No email on file for this account."), { statusCode: 400 });

    if (action === "send") {
      const code = genCode();
      const codeHash = crypto.createHash("sha256").update(code).digest("hex");
      await db.collection("pinResetCodes").doc(uid).set({
        code_hash: codeHash,
        expires_at: Date.now() + CODE_TTL_MS,
      });

      const { subject, html } = pinResetCodeEmail({ name: userData.full_name || userData.name, code });
      let emailSent = true;
      try {
        await sendEmail({ to: email, toName: userData.full_name || userData.name, subject, html });
      } catch (emailErr) {
        console.error("pin-reset send error:", emailErr.message);
        emailSent = false;
      }

      // Mask the email so the UI can show "code sent to t***@gmail.com"
      // without fully revealing it.
      const [local, domain] = email.split("@");
      const masked = `${local.slice(0, 1)}***@${domain || ""}`;
      return ok({ emailSent, maskedEmail: masked });
    }

    if (action === "confirm") {
      const { code, newPin } = body;
      if (!code || !newPin) {
        throw Object.assign(new Error("code and newPin are required."), { statusCode: 400 });
      }
      if (!/^\d{4,6}$/.test(String(newPin))) {
        throw Object.assign(new Error("PIN must be 4-6 digits."), { statusCode: 400 });
      }

      const codeRef = db.collection("pinResetCodes").doc(uid);
      const codeSnap = await codeRef.get();
      if (!codeSnap.exists) {
        throw Object.assign(new Error("No reset code found — request a new one."), { statusCode: 400 });
      }
      const stored = codeSnap.data();
      if (Date.now() > stored.expires_at) {
        throw Object.assign(new Error("Code expired — request a new one."), { statusCode: 400 });
      }
      const suppliedHash = crypto.createHash("sha256").update(String(code).trim()).digest("hex");
      if (suppliedHash !== stored.code_hash) {
        throw Object.assign(new Error("Incorrect code."), { statusCode: 400 });
      }

      await Promise.all([
        userRef.update({ pin_hash: hashPin(newPin), pin_updated_at: FieldValue.serverTimestamp() }),
        codeRef.delete(),
      ]);

      return ok({ success: true });
    }

    throw Object.assign(new Error(`Unknown action: ${action}`), { statusCode: 400 });
  } catch (err) {
    return fail(err);
  }
};
