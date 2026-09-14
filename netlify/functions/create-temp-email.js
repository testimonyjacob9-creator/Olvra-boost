// netlify/functions/create-temp-email.js
// POST /.netlify/functions/create-temp-email
//   Headers: Authorization: Bearer <Firebase ID token>
//
// Free Email OTP feature — Mail.tm needs no API key, so unlike Rent
// Number there is no price, no wallet deduction, and no refund path here.
// The account's password is stored in Firestore only for re-authenticating
// on later polls (check-temp-email.js) — it never goes to the client.

const crypto = require("crypto");
const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const mailtm = require("./_lib/mailtm");

const INBOX_LIFETIME_MS = 20 * 60 * 1000; // 20 min — plenty for a signup/verification flow

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    const uid = decoded.uid;

    const domains = await mailtm.getDomains();
    if (!domains.length) {
      throw Object.assign(new Error("No temp-email domains available right now — try again shortly."), { statusCode: 503 });
    }
    const domain = domains[0].domain;
    const local = `olvra${crypto.randomBytes(5).toString("hex")}`;
    const address = `${local}@${domain}`;
    const password = crypto.randomBytes(16).toString("hex");

    const account = await mailtm.createAccount({ address, password });
    const expiresAt = new Date(Date.now() + INBOX_LIFETIME_MS).toISOString();

    const orderRef = await db.collection("email_orders").add({
      uid,
      address,
      password,
      account_id: account.id,
      status: "ACTIVE",
      messages: [],
      created_at: FieldValue.serverTimestamp(),
      expires_at: expiresAt,
    });

    return ok({ orderId: orderRef.id, address, expires: expiresAt });
  } catch (err) {
    return fail(err);
  }
};
