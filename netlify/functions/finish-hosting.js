// netlify/functions/finish-hosting.js
// POST /.netlify/functions/finish-hosting
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body: { orderId }
//
// Releases a hosting number early. No wallet change — the charge already
// happened at purchase time in buy-hosting.js, and hosting numbers aren't
// refundable regardless (you paid for the time slot, not a guaranteed code).

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

    const orderRef = db.collection("hosting_orders").doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) {
      throw Object.assign(new Error("Order not found."), { statusCode: 404 });
    }
    const order = snap.data();
    if (order.uid !== uid) {
      throw Object.assign(new Error("Not your order."), { statusCode: 403 });
    }

    const apiKey = FIVESIM_API_KEY;
    if (!apiKey) {
      throw Object.assign(new Error("Number rental isn't configured yet."), { statusCode: 503 });
    }

    let result;
    try {
      result = await fivesim.finishOrder(apiKey, order.fivesim_order_id);
    } catch (err) {
      const providerReason = err.response?.data?.message || err.message || "unknown error";
      throw Object.assign(new Error(`Couldn't close this order — ${providerReason}`), { statusCode: 409 });
    }

    await orderRef.update({ status: "FINISHED", updated_at: FieldValue.serverTimestamp() });

    return ok({ status: result.status || "FINISHED" });
  } catch (err) {
    return fail(err);
  }
};
