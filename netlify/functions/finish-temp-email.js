// netlify/functions/finish-temp-email.js
// POST /.netlify/functions/finish-temp-email
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body: { orderId }

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const mailtm = require("./_lib/mailtm");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    const uid = decoded.uid;
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch {
      throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 });
    }
    const { orderId } = body;
    if (!orderId) throw Object.assign(new Error("orderId is required."), { statusCode: 400 });

    const orderRef = db.collection("email_orders").doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) throw Object.assign(new Error("Inbox not found."), { statusCode: 404 });
    const order = snap.data();
    if (order.uid !== uid) throw Object.assign(new Error("Not your inbox."), { statusCode: 403 });

    if (order.status !== "CLOSED") {
      try {
        const token = await mailtm.getToken({ address: order.address, password: order.password });
        await mailtm.deleteAccount(token, order.account_id);
      } catch (err) {
        console.error(`finish-temp-email: cleanup failed for ${orderId}:`, err.message);
      }
      await orderRef.update({ status: "CLOSED", updated_at: FieldValue.serverTimestamp() });
    }

    return ok({ status: "CLOSED" });
  } catch (err) {
    return fail(err);
  }
};
