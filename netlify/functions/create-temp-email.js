// netlify/functions/create-temp-email.js
// POST /.netlify/functions/create-temp-email
//   Headers: Authorization: Bearer <Firebase ID token>
//
// Charges a flat ₦10 activation fee per inbox from the wallet. Mail.tm
// itself is still free/no-API-key — this fee is Olvra Boost's own charge
// on top, not anything Mail.tm bills. NOTE: Mail.tm's terms say not to
// build a paid product that just wraps their API, so this is a
// deliberate risk accepted for now, pending their reply to a direct
// email about it — if they say no, swap the backend to a provider whose
// terms actually allow it (OpenInbox was already scoped for that).

const crypto = require("crypto");
const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const mailtm = require("./_lib/mailtm");

const INBOX_LIFETIME_MS = 20 * 60 * 1000; // 20 min — plenty for a signup/verification flow
const ACTIVATION_FEE_NGN = 10;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    const uid = decoded.uid;
    const userRef = db.collection("users").doc(uid);

    // Charge first — no point creating a Mail.tm account for someone who
    // can't pay the activation fee.
    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw Object.assign(new Error("User wallet not found."), { statusCode: 404 });
      }
      const wallet = userSnap.data().wallet_balance || 0;
      if (wallet < ACTIVATION_FEE_NGN) {
        throw Object.assign(new Error(`Insufficient wallet balance — Email OTP costs ₦${ACTIVATION_FEE_NGN} per inbox.`), { statusCode: 402 });
      }
      tx.update(userRef, {
        wallet_balance: FieldValue.increment(-ACTIVATION_FEE_NGN),
        last_activity_at: FieldValue.serverTimestamp(),
      });
      tx.set(db.collection("wallet_transactions").doc(), {
        uid,
        type: "email_otp_activation",
        amount: -ACTIVATION_FEE_NGN,
        balance_after: wallet - ACTIVATION_FEE_NGN,
        note: "Email OTP — temp inbox activation fee",
        created_at: FieldValue.serverTimestamp(),
      });
    });

    let account, address, password, domain;
    try {
      const domains = await mailtm.getDomains();
      if (!domains.length) {
        throw Object.assign(new Error("No temp-email domains available right now — try again shortly."), { statusCode: 503 });
      }
      domain = domains[0].domain;
      const local = `olvra${crypto.randomBytes(5).toString("hex")}`;
      address = `${local}@${domain}`;
      password = crypto.randomBytes(16).toString("hex");
      account = await mailtm.createAccount({ address, password });
    } catch (err) {
      // Inbox creation failed after the fee was charged — refund it.
      await userRef.update({ wallet_balance: FieldValue.increment(ACTIVATION_FEE_NGN) });
      await db.collection("wallet_transactions").add({
        uid,
        type: "email_otp_activation_refund",
        amount: ACTIVATION_FEE_NGN,
        note: "Email OTP — inbox creation failed, fee refunded",
        created_at: FieldValue.serverTimestamp(),
      });
      throw Object.assign(new Error("Couldn't create an inbox — you weren't charged. Try again."), { statusCode: 502 });
    }

    const expiresAt = new Date(Date.now() + INBOX_LIFETIME_MS).toISOString();

    const orderRef = await db.collection("email_orders").add({
      uid,
      address,
      password,
      account_id: account.id,
      status: "ACTIVE",
      price_ngn: ACTIVATION_FEE_NGN,
      messages: [],
      created_at: FieldValue.serverTimestamp(),
      expires_at: expiresAt,
    });

    return ok({ orderId: orderRef.id, address, expires: expiresAt });
  } catch (err) {
    return fail(err);
  }
};
