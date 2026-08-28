// netlify/functions/flutterwave-webhook.js
//
// Receives Flutterwave v3 "charge.completed" webhooks for the Wema static
// virtual accounts created in create-permanent-account.js, and credits the
// matching user's wallet once a transfer is confirmed.
//
// IMPORTANT — before this goes live:
// 1. In your Flutterwave dashboard: Settings > Webhooks, set this
//    function's URL as your webhook URL, e.g.
//    https://<your-site>.netlify.app/.netlify/functions/flutterwave-webhook
// 2. Set a Secret Hash there — any long random string you choose (NOT the
//    URL above — a separate random string).
// 3. Add that exact string as FLW_WEBHOOK_SECRET_HASH in Netlify env vars.
//    v3 does NOT HMAC-sign the payload — it just sends your secret hash
//    back verbatim in a `verif-hash` header, which we directly
//    string-compare, timing-safe, against our own copy.
//
// A transfer into a static virtual account fires this shape:
//   {
//     "event": "charge.completed",
//     "data": {
//       "id": 2028146660,          // numeric charge id — unique per charge, never reused
//       "tx_ref": "...",           // the reference we set at account creation — REUSED every charge
//       "amount": 500,
//       "currency": "NGN",
//       "status": "successful",    // lowercase
//       "payment_type": "bank_transfer",
//       "customer": { ... }        // the SENDER, not us
//     }
//   }
//
// There is no destination account number anywhere in this payload, so the
// only reliable match for a static account is `data.tx_ref` against
// permanent_account.reference.

const crypto = require("crypto");
const { db, FieldValue } = require("./_lib/firebase-admin");
const { ok, fail } = require("./_lib/respond");
const { sendEmail, walletFundedEmail } = require("./_lib/brevo");

// Flutterwave charges a fee on incoming bank transfers into a virtual
// account. This is passed on to the user as a flat charge per funding,
// deducted from what they sent, rather than absorbed by Olvra Boost.
const FEE_FLAT = 50; // ₦50 flat, per funding

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  const rawBody = event.body || "";
  const signature = event.headers["verif-hash"] || event.headers["Verif-Hash"] || "";

  if (!isValidSignature(signature)) {
    return { statusCode: 401, body: "Invalid signature" };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // Always return 200 once the signature checks out, even for events we
  // ignore — Flutterwave retries on non-2xx, and we don't want retries for
  // events we intentionally don't act on.
  if (payload.event !== "charge.completed") {
    return { statusCode: 200, body: "Ignored — not a charge.completed event" };
  }

  const data = payload.data || {};
  if (data.payment_type && data.payment_type !== "bank_transfer") {
    return { statusCode: 200, body: "Ignored — not a bank_transfer charge" };
  }

  const reference = data.tx_ref;
  const chargeId = data.id;
  const status = data.status;
  const amount = Number(data.amount || 0);

  if (!reference) {
    return { statusCode: 200, body: "No reference — ignored" };
  }
  if (status !== "successful") {
    return { statusCode: 200, body: `Ignored — status is ${status}` };
  }

  try {
    // Match the user by the reused static-account creation reference.
    const userQuery = await db
      .collection("users")
      .where("permanent_account.reference", "==", reference)
      .limit(1)
      .get();

    if (userQuery.empty) {
      console.warn("flutterwave-webhook: no user found for reference", reference);
      return { statusCode: 200, body: "No matching user" };
    }

    const userDoc = userQuery.docs[0];
    const uid = userDoc.id;
    const userRef = db.collection("users").doc(uid);

    // Idempotency — keyed on chargeId (unique per charge), never on
    // reference (Flutterwave reuses that same tx_ref for every top-up
    // into a static account, so keying on it would only ever credit once).
    const txRef = db.collection("wallet_topups").doc(String(chargeId || reference + "-" + amount));
    const result = await db.runTransaction(async (tx) => {
      const already = await tx.get(txRef);
      if (already.exists) {
        return { alreadyProcessed: true, netCredit: 0 };
      }

      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw Object.assign(new Error("User not found for wallet credit."), { statusCode: 404 });
      }

      // Flat ₦50 charge per funding — deducted from what the user sent,
      // not absorbed by the platform.
      const fee = FEE_FLAT;
      const netCredit = round2(amount - fee);

      if (netCredit <= 0) {
        tx.set(txRef, {
          uid,
          gross_amount: amount,
          fee,
          net_credit: 0,
          currency: data.currency || "NGN",
          reference,
          charge_id: chargeId || null,
          status: "amount_too_small",
          credited_at: FieldValue.serverTimestamp(),
        });
        return { alreadyProcessed: false, netCredit: 0, tooSmall: true };
      }

      tx.update(userRef, { wallet_balance: FieldValue.increment(netCredit) });
      tx.set(txRef, {
        uid,
        gross_amount: amount,
        fee,
        net_credit: netCredit,
        currency: data.currency || "NGN",
        reference,
        charge_id: chargeId || null,
        status: "credited",
        credited_at: FieldValue.serverTimestamp(),
      });

      return { alreadyProcessed: false, netCredit };
    });

    if (!result.alreadyProcessed && !result.tooSmall) {
      try {
        const userSnap = await userRef.get();
        const email = userSnap.data().email;
        const newBalance = (userSnap.data().wallet_balance || 0);

        await userRef.collection("notifications").add({
          type: "wallet_funded",
          title: "Wallet funded",
          body: `₦${result.netCredit.toLocaleString()} credited to your wallet.`,
          amount: result.netCredit,
          read: false,
          created_at: FieldValue.serverTimestamp(),
        });

        if (email) {
          const { subject, html } = walletFundedEmail({ amount: result.netCredit, newBalance });
          await sendEmail({ to: email, subject, html });
        }
      } catch (emailErr) {
        console.error("Wallet funded email/notification failed:", emailErr.message);
      }
    }

    return ok({ received: true, credited: !result.alreadyProcessed, amount });
  } catch (err) {
    console.error("flutterwave-webhook error:", err.message);
    return { statusCode: 200, body: "Error logged" };
  }
};

function isValidSignature(signatureHeader) {
  const secret = process.env.FLW_WEBHOOK_SECRET_HASH || "";
  if (!secret || !signatureHeader) return false;
  const expected = Buffer.from(secret);
  const got = Buffer.from(String(signatureHeader));
  if (expected.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(expected, got);
  } catch {
    return false;
  }
}
