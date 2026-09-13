// netlify/functions/check-number.js
// GET /.netlify/functions/check-number?orderId=<firestore doc id>
//   Headers: Authorization: Bearer <Firebase ID token>
//
// The client polls this every few seconds while waiting for the SMS code.
// Once an order is in a closed state (finished/cancelled/expired/failed) it
// stops calling 5sim at all and just returns what's already stored — no
// point spending an API call polling a number that's already done.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const fivesim = require("./_lib/fivesim");
const { FIVESIM_API_KEY } = require("./_lib/config");

const CLOSED_STATUSES = new Set(["FINISHED", "CANCELED", "TIMEOUT", "BANNED"]);

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

    const orderRef = db.collection("number_orders").doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) {
      throw Object.assign(new Error("Order not found."), { statusCode: 404 });
    }
    const order = snap.data();
    if (order.uid !== uid) {
      throw Object.assign(new Error("Not your order."), { statusCode: 403 });
    }

    if (CLOSED_STATUSES.has(order.status)) {
      return ok({ status: order.status, phone: order.phone, sms: order.sms || [] });
    }

    const apiKey = FIVESIM_API_KEY;
    if (!apiKey) {
      throw Object.assign(new Error("Number rental isn't configured yet."), { statusCode: 503 });
    }

    const fresh = await fivesim.checkOrder(apiKey, order.fivesim_order_id);
    const prevSmsCount = (order.sms || []).length;
    const newSms = fresh.sms || [];

    if (fresh.status !== order.status || newSms.length !== prevSmsCount) {
      await orderRef.update({
        status: fresh.status,
        sms: newSms,
        updated_at: FieldValue.serverTimestamp(),
      });
    }

    // First time a code shows up — notify, same as any other order event.
    if (newSms.length > prevSmsCount) {
      try {
        const code = newSms[newSms.length - 1]?.code;
        await db.collection("users").doc(uid).collection("notifications").add({
          type: "number_code",
          title: "Code received",
          body: code ? `${order.product}: ${code}` : `A new code arrived for ${order.phone}.`,
          order_id: orderId,
          read: false,
          created_at: FieldValue.serverTimestamp(),
        });
      } catch {}
    }

    return ok({ status: fresh.status, phone: order.phone, sms: newSms });
  } catch (err) {
    return fail(err);
  }
};
