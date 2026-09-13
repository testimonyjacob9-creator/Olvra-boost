// netlify/functions/cancel-number.js
// POST /.netlify/functions/cancel-number
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body: { orderId }
//
// 5sim only allows cancelling within a short window right after purchase
// (before a code has arrived). Unlike finish-number.js, this DOES touch the
// wallet — the user is refunded exactly what they were charged in
// buy-number.js, olives included, same split-refund shape buy-number.js
// already uses on its own auto-refund path.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const fivesim = require("./_lib/fivesim");
const { FIVESIM_API_KEY } = require("./_lib/config");

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
    const { orderId } = body;
    if (!orderId) {
      throw Object.assign(new Error("orderId is required."), { statusCode: 400 });
    }

    const orderRef = db.collection("number_orders").doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) {
      throw Object.assign(new Error("Order not found."), { statusCode: 404 });
    }
    const order = snap.data();
    if (order.uid !== uid) {
      throw Object.assign(new Error("Not your order."), { statusCode: 403 });
    }
    if (["FINISHED", "CANCELED", "TIMEOUT", "BANNED"].includes(order.status)) {
      throw Object.assign(new Error("This order is already closed."), { statusCode: 409 });
    }
    // A code already arrived — 5sim won't let this be cancelled for a
    // refund at this point, and finishing (not cancelling) is the correct
    // next step once the number's actually been used.
    if ((order.sms || []).length > 0) {
      throw Object.assign(new Error("A code has already been received — this number can no longer be cancelled."), { statusCode: 409 });
    }

    const apiKey = FIVESIM_API_KEY;
    if (!apiKey) {
      throw Object.assign(new Error("Number rental isn't configured yet."), { statusCode: 503 });
    }

    let result;
    try {
      result = await fivesim.cancelOrder(apiKey, order.fivesim_order_id);
    } catch (err) {
      const providerReason = err.response?.data?.message || err.message || "unknown error";
      throw Object.assign(new Error(`Couldn't cancel this order — ${providerReason}`), { statusCode: 409 });
    }

    // Refund exactly what was charged at purchase time — wallet portion in
    // Naira, olives portion back as olives — same split buy-number.js
    // itself refunds on its own provider-failure path.
    const olivesUsed = order.olives_used || 0;
    const walletRefund = order.price_ngn - (olivesUsed > 0 ? olivesUsed * 2 : 0);
    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      const walletBefore = userSnap.exists ? (userSnap.data().wallet_balance || 0) : 0;

      tx.update(userRef, {
        wallet_balance: FieldValue.increment(walletRefund),
        ...(olivesUsed > 0 ? { olive_balance: FieldValue.increment(olivesUsed) } : {}),
        last_activity_at: FieldValue.serverTimestamp(),
      });
      tx.set(db.collection("wallet_transactions").doc(), {
        uid,
        type: "number_rental_refund",
        amount: walletRefund,
        balance_after: walletBefore + walletRefund,
        note: `Rent Number cancelled — ${order.product} (${order.country}/${order.operator})${olivesUsed > 0 ? ` (+${olivesUsed} olives)` : ""}`,
        created_at: FieldValue.serverTimestamp(),
      });
      tx.update(orderRef, {
        status: "CANCELED",
        updated_at: FieldValue.serverTimestamp(),
      });
    });

    try {
      await db.collection("users").doc(uid).collection("notifications").add({
        type: "number_cancelled",
        title: "Number cancelled — refunded",
        body: `${order.phone} was cancelled. ₦${walletRefund.toLocaleString()} was refunded to your wallet.`,
        order_id: orderId,
        read: false,
        created_at: FieldValue.serverTimestamp(),
      });
    } catch {}

    return ok({ status: result.status || "CANCELED", refunded: walletRefund, olivesRefunded: olivesUsed });
  } catch (err) {
    return fail(err);
  }
};
