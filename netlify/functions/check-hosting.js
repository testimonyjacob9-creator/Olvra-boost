// netlify/functions/check-hosting.js
// GET /.netlify/functions/check-hosting?orderId=xxx
//   Headers: Authorization: Bearer <Firebase ID token>
//
// Uses 5sim's dedicated inbox endpoint (rented numbers only) instead of
// the single-snapshot /user/check/$id activation numbers use — a hosting
// number can receive many messages from many senders over its rental
// period, so this returns everything received so far, not just the
// latest one.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const fivesim = require("./_lib/fivesim");
const { FIVESIM_API_KEY } = require("./_lib/config");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    const uid = decoded.uid;
    const { orderId } = event.queryStringParameters || {};
    if (!orderId) {
      throw Object.assign(new Error("orderId is required."), { statusCode: 400 });
    }

    const orderRef = db.collection("hosting_orders").doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) throw Object.assign(new Error("Order not found."), { statusCode: 404 });
    const order = snap.data();
    if (order.uid !== uid) throw Object.assign(new Error("Not your order."), { statusCode: 403 });

    const CLOSED = new Set(["FINISHED", "CANCELED", "TIMEOUT", "BANNED"]);
    if (CLOSED.has(order.status)) {
      return ok({ status: order.status, phone: order.phone, sms: order.sms || [] });
    }

    const apiKey = FIVESIM_API_KEY;
    if (!apiKey) {
      throw Object.assign(new Error("Number rental isn't configured yet."), { statusCode: 503 });
    }

    let inbox;
    try {
      inbox = await fivesim.getInbox(apiKey, order.fivesim_order_id);
    } catch (err) {
      // Inbox endpoint failing is non-fatal — fall back to whatever's
      // already cached in Firestore rather than erroring the whole poll.
      console.error(`check-hosting: inbox fetch failed for ${orderId}:`, err.message);
      return ok({ status: order.status, phone: order.phone, sms: order.sms || [] });
    }

    const freshSms = inbox?.Data || inbox?.sms || (Array.isArray(inbox) ? inbox : order.sms || []);
    const prevCount = (order.sms || []).length;

    // Also check expiry — a hosting number naturally lapses to expired
    // once its rented period is up, at which point it's just done, no
    // refund (this is a time rental, not a pay-per-code product).
    const isExpired = order.expires_at && new Date(order.expires_at).getTime() < Date.now();
    const newStatus = isExpired ? "FINISHED" : order.status;

    if (freshSms.length !== prevCount || newStatus !== order.status) {
      await orderRef.update({ sms: freshSms, status: newStatus, updated_at: FieldValue.serverTimestamp() });
      if (freshSms.length > prevCount) {
        try {
          await db.collection("users").doc(uid).collection("notifications").add({
            type: "hosting_sms_received",
            title: "New message on your long-term number",
            body: `${order.phone} received a new message.`,
            order_id: orderId,
            read: false,
            created_at: FieldValue.serverTimestamp(),
          });
        } catch {}
      }
    }

    return ok({ status: newStatus, phone: order.phone, sms: freshSms });
  } catch (err) {
    return fail(err);
  }
};
