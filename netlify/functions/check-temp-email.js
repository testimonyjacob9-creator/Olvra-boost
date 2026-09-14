// netlify/functions/check-temp-email.js
// GET /.netlify/functions/check-temp-email?orderId=xxx
//   Headers: Authorization: Bearer <Firebase ID token>

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const mailtm = require("./_lib/mailtm");

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

    const orderRef = db.collection("email_orders").doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) throw Object.assign(new Error("Inbox not found."), { statusCode: 404 });
    const order = snap.data();
    if (order.uid !== uid) throw Object.assign(new Error("Not your inbox."), { statusCode: 403 });

    if (order.status === "CLOSED") {
      return ok({ status: "CLOSED", address: order.address, messages: order.messages || [] });
    }

    if (new Date(order.expires_at).getTime() < Date.now()) {
      await orderRef.update({ status: "EXPIRED" });
      // Best-effort cleanup on Mail.tm's side — never block the response on this.
      mailtm.getToken({ address: order.address, password: order.password })
        .then((token) => mailtm.deleteAccount(token, order.account_id))
        .catch(() => {});
      return ok({ status: "EXPIRED", address: order.address, messages: order.messages || [] });
    }

    const token = await mailtm.getToken({ address: order.address, password: order.password });
    const summaries = await mailtm.listMessages(token);

    const known = new Set((order.messages || []).map((m) => m.id));
    const newOnes = summaries.filter((s) => !known.has(s.id));
    const fetchedNew = await Promise.all(
      newOnes.map(async (s) => {
        try {
          const full = await mailtm.getMessage(token, s.id);
          return {
            id: s.id,
            from: full.from?.address || s.from?.address || "unknown",
            subject: full.subject || s.subject || "",
            text: (full.text || s.intro || "").trim(),
            receivedAt: full.createdAt || s.createdAt || new Date().toISOString(),
          };
        } catch {
          return { id: s.id, from: s.from?.address || "unknown", subject: s.subject || "", text: (s.intro || "").trim(), receivedAt: s.createdAt || new Date().toISOString() };
        }
      })
    );

    const allMessages = [...(order.messages || []), ...fetchedNew].sort(
      (a, b) => new Date(a.receivedAt) - new Date(b.receivedAt)
    );

    if (fetchedNew.length > 0) {
      await orderRef.update({ messages: allMessages, updated_at: FieldValue.serverTimestamp() });
      try {
        await db.collection("users").doc(uid).collection("notifications").add({
          type: "email_otp_received",
          title: "New email received",
          body: `${order.address} got a new message${fetchedNew.length > 1 ? "s" : ""}.`,
          order_id: orderId,
          read: false,
          created_at: FieldValue.serverTimestamp(),
        });
      } catch {}
    }

    return ok({ status: "ACTIVE", address: order.address, messages: allMessages });
  } catch (err) {
    return fail(err);
  }
};
