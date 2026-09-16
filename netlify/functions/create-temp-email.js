// netlify/functions/create-temp-email.js
// POST /.netlify/functions/create-temp-email
//   Headers: Authorization: Bearer <Firebase ID token>
//
// Charges a flat ₦10 activation fee per inbox from the wallet. Mail.tm
// itself is still free/no-API-key — this fee is Olvra Boost's own charge
// on top, not anything Mail.tm bills.
//
// IMPORTANT ordering: the Mail.tm account is created FIRST, wallet is
// charged ONLY after that succeeds. This function makes two sequential
// external calls (domains, then account creation) before ever touching
// money — doing the charge first and refunding on failure is the wrong
// shape here, because a serverless function timeout kills execution
// mid-flight with no guarantee the refund code ever runs, which would
// charge someone for nothing. Charging last means the worst case of a
// timeout is "nothing happened", not "charged with no inbox".

const crypto = require("crypto");
const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const mailtm = require("./_lib/mailtm");
const { requirePinIfSet } = require("./_lib/pin");

const INBOX_LIFETIME_MS = 20 * 60 * 1000; // 20 min — plenty for a signup/verification flow
const ACTIVATION_FEE_NGN = 10;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    const uid = decoded.uid;
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }
    const { pin } = body;
    const userRef = db.collection("users").doc(uid);

    // Balance CHECK (read-only, no charge yet) so we don't waste a
    // Mail.tm account on someone who can't pay for it.
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw Object.assign(new Error("User wallet not found."), { statusCode: 404 });
    }
    requirePinIfSet(userSnap.data(), pin);
    const walletBefore = userSnap.data().wallet_balance || 0;
    if (walletBefore < ACTIVATION_FEE_NGN) {
      throw Object.assign(new Error(`Insufficient wallet balance — Email OTP costs ₦${ACTIVATION_FEE_NGN} per inbox.`), { statusCode: 402 });
    }

    // Create the inbox BEFORE charging anything.
    const domains = await mailtm.getDomains();
    if (!domains.length) {
      throw Object.assign(new Error("No temp-email domains available right now — try again shortly."), { statusCode: 503 });
    }
    const domain = domains[0].domain;
    const local = `olvra${crypto.randomBytes(5).toString("hex")}`;
    const address = `${local}@${domain}`;
    const password = crypto.randomBytes(16).toString("hex");
    const account = await mailtm.createAccount({ address, password });

    // Inbox exists — now charge, and record the inbox in the same
    // transaction so a charge can never exist without its email_orders row.
    const expiresAt = new Date(Date.now() + INBOX_LIFETIME_MS).toISOString();
    const orderRef = db.collection("email_orders").doc();
    await db.runTransaction(async (tx) => {
      const freshUserSnap = await tx.get(userRef);
      const wallet = freshUserSnap.exists ? (freshUserSnap.data().wallet_balance || 0) : 0;
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
      tx.set(orderRef, {
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
    });

    return ok({ orderId: orderRef.id, address, expires: expiresAt });
  } catch (err) {
    return fail(err);
  }
};
