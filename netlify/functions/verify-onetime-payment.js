// netlify/functions/verify-onetime-payment.js
//
// Called from fund.html right after Flutterwave's inline checkout modal
// reports success. The client NEVER credits its own wallet — it only tells
// us which transaction to check, and this function re-verifies the amount
// and status directly against Flutterwave's API before crediting anything.
// This is what stops someone from faking a "successful" browser callback.
//
// POST /.netlify/functions/verify-onetime-payment
// Headers: Authorization: Bearer <Firebase ID token>
// Body:    { transactionId, expectedTxRef }
// Returns: { credited, newBalance }

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const { sendEmail, walletFundedEmail } = require("./_lib/brevo");

const FLW_V3_BASE = "https://api.flutterwave.com/v3";

// One-time card/checkout payments carry Flutterwave's own processing fee
// already baked into their side — we still apply the same flat platform
// charge as static-account transfers, for consistency across funding methods.
const FEE_FLAT = 50; // ₦50 flat, per funding

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    const uid = decoded.uid;

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 });
    }

    const { transactionId, expectedTxRef } = body;
    if (!transactionId) {
      throw Object.assign(new Error("transactionId is required."), { statusCode: 400 });
    }

    const verifyRes = await fetch(`${FLW_V3_BASE}/transactions/${transactionId}/verify`, {
      headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` },
    });
    const verifyData = await verifyRes.json();

    if (!verifyRes.ok || verifyData.status !== "success" || !verifyData.data) {
      throw Object.assign(new Error("Could not verify transaction with Flutterwave."), { statusCode: 502 });
    }

    const tx = verifyData.data;

    if (tx.status !== "successful") {
      throw Object.assign(new Error(`Payment status is "${tx.status}", not successful.`), { statusCode: 402 });
    }
    if (tx.currency !== "NGN") {
      throw Object.assign(new Error("Unexpected currency on transaction."), { statusCode: 400 });
    }
    // tx_ref is set by the client when opening checkout — cross-check it
    // matches what this user's session actually initiated, as a second
    // guard against replaying someone else's transactionId.
    if (expectedTxRef && tx.tx_ref !== expectedTxRef) {
      throw Object.assign(new Error("Transaction reference mismatch."), { statusCode: 400 });
    }

    const grossAmount = Number(tx.amount || 0);
    const netCredit = round2(grossAmount - FEE_FLAT);

    if (netCredit <= 0) {
      throw Object.assign(new Error("Amount too small after the ₦50 funding fee."), { statusCode: 400 });
    }

    const userRef = db.collection("users").doc(uid);
    // Idempotency — keyed on Flutterwave's numeric transaction id, so a
    // double-tap or a retried verify call can never credit twice.
    const topupRef = db.collection("wallet_topups").doc(String(transactionId));

    const result = await db.runTransaction(async (t) => {
      const already = await t.get(topupRef);
      if (already.exists) {
        return { alreadyProcessed: true };
      }

      const userSnap = await t.get(userRef);
      if (!userSnap.exists) {
        throw Object.assign(new Error("User not found."), { statusCode: 404 });
      }

      t.update(userRef, { wallet_balance: FieldValue.increment(netCredit) });
      t.set(topupRef, {
        uid,
        method: "onetime_checkout",
        gross_amount: grossAmount,
        fee: FEE_FLAT,
        net_credit: netCredit,
        currency: "NGN",
        tx_ref: tx.tx_ref,
        transaction_id: transactionId,
        status: "credited",
        credited_at: FieldValue.serverTimestamp(),
      });

      const newBalance = (userSnap.data().wallet_balance || 0) + netCredit;
      return { alreadyProcessed: false, newBalance };
    });

    if (!result.alreadyProcessed && decoded.email) {
      try {
        const { subject, html } = walletFundedEmail({ amount: netCredit, newBalance: result.newBalance });
        await sendEmail({ to: decoded.email, subject, html });
      } catch (emailErr) {
        console.error("Wallet funded email failed:", emailErr.message);
      }
    }

    return ok({
      credited: !result.alreadyProcessed,
      newBalance: result.newBalance,
    });
  } catch (err) {
    return fail(err);
  }
};

function round2(n) {
  return Math.round(n * 100) / 100;
}
