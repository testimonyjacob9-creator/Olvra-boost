// netlify/functions/refund-expired-numbers.js
// SCHEDULED FUNCTION (see schedule in netlify.toml) — 5sim times an
// activation number out automatically after 5 minutes with no SMS
// received. That closes 5sim's own side of the order, but our Naira
// wallet charge (taken up front in buy-number.js) doesn't undo itself —
// this is what actually refunds the user.
//
// Only touches orders our own Firestore still has as PENDING, and only
// once they're past their expiry — so on a quiet day this reads a small,
// already-filtered slice of number_orders, not the whole collection.
// A user who stays on the active-number screen gets this faster via
// check-number.js's polling; this cron is the safety net for anyone who
// closed the app before their number expired.

const { db, FieldValue } = require("./_lib/firebase-admin");
const fivesim = require("./_lib/fivesim");
const { FIVESIM_API_KEY } = require("./_lib/config");

const CLOSED_NO_SMS = new Set(["CANCELED", "TIMEOUT", "BANNED"]);
// Safety net for the rare order with no expires_at on file — 5sim's own
// docs list 15 minutes as the outer bound on any activation order.
const FALLBACK_MAX_AGE_MS = 20 * 60 * 1000;

exports.handler = async () => {
  if (!FIVESIM_API_KEY) {
    console.log("refund-expired-numbers: FIVESIM_API_KEY not set, skipping run.");
    return { statusCode: 200, body: "skipped — no API key" };
  }

  const snap = await db.collection("number_orders").where("status", "==", "PENDING").get();
  if (snap.empty) {
    return { statusCode: 200, body: "0 pending orders" };
  }

  const now = Date.now();
  let refunded = 0;
  let synced = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const order = doc.data();
    const expiresMs = order.expires_at ? new Date(order.expires_at).getTime() : null;
    const createdMs = order.created_at?.toDate ? order.created_at.toDate().getTime() : null;
    const isPastExpiry = expiresMs ? now > expiresMs : (createdMs ? now - createdMs > FALLBACK_MAX_AGE_MS : false);
    if (!isPastExpiry) { skipped++; continue; }

    let fresh;
    try {
      fresh = await fivesim.checkOrder(FIVESIM_API_KEY, order.fivesim_order_id);
    } catch (err) {
      console.error(`refund-expired-numbers: check failed for order ${doc.id}:`, err.message);
      continue;
    }

    if (fresh.status === "PENDING" || fresh.status === "RECEIVED") {
      // Still open on 5sim's side (or a code showed up right at the
      // boundary) — sync what we have and leave the refund decision to
      // its next real close, not to our expiry guess.
      if (fresh.status !== order.status || (fresh.sms || []).length !== (order.sms || []).length) {
        await doc.ref.update({ status: fresh.status, sms: fresh.sms || [] });
        synced++;
      }
      continue;
    }

    if (fresh.status === "FINISHED") {
      await doc.ref.update({ status: "FINISHED", sms: fresh.sms || [] });
      synced++;
      continue;
    }

    if (!CLOSED_NO_SMS.has(fresh.status)) { continue; }

    // Closed with no SMS ever delivered — refund exactly what was
    // charged, same wallet/olive split buy-number.js and cancel-number.js
    // already use.
    const olivesUsed = order.olives_used || 0;
    const walletRefund = order.price_ngn - (olivesUsed > 0 ? olivesUsed * 2 : 0);
    const userRef = db.collection("users").doc(order.uid);

    try {
      await db.runTransaction(async (tx) => {
        const userSnap = await tx.get(userRef);
        const walletBefore = userSnap.exists ? (userSnap.data().wallet_balance || 0) : 0;
        tx.update(userRef, {
          wallet_balance: FieldValue.increment(walletRefund),
          ...(olivesUsed > 0 ? { olive_balance: FieldValue.increment(olivesUsed) } : {}),
        });
        tx.set(db.collection("wallet_transactions").doc(), {
          uid: order.uid,
          type: "number_rental_refund",
          amount: walletRefund,
          balance_after: walletBefore + walletRefund,
          note: `Rent Number ${fresh.status.toLowerCase()} — ${order.product} (${order.country}/${order.operator}), no code received${olivesUsed > 0 ? ` (+${olivesUsed} olives)` : ""}`,
          created_at: FieldValue.serverTimestamp(),
        });
        tx.update(doc.ref, { status: fresh.status, sms: fresh.sms || [] });
      });

      await db.collection("users").doc(order.uid).collection("notifications").add({
        type: "number_timeout_refunded",
        title: fresh.status === "TIMEOUT" ? "No code received — refunded" : "Number closed — refunded",
        body: `${order.phone} didn't receive a code in time. ₦${walletRefund.toLocaleString()} was refunded to your wallet.`,
        order_id: doc.id,
        read: false,
        created_at: FieldValue.serverTimestamp(),
      }).catch(() => {});

      refunded++;
    } catch (err) {
      console.error(`refund-expired-numbers: refund failed for order ${doc.id}:`, err.message);
    }
  }

  const summary = `Checked ${snap.size} pending order(s): ${refunded} refunded, ${synced} synced, ${skipped} not yet expired.`;
  console.log("refund-expired-numbers:", summary);
  return { statusCode: 200, body: summary };
};
