// netlify/functions/place-order.js
// HTTP FUNCTION — called from the app with:
//   POST /.netlify/functions/place-order
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body: { serviceId, quantity, link?, username? }
//
// Re-validates price server-side (never trusts a client-sent amount),
// deducts wallet atomically, then calls BigiSub.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const bigisub = require("./_lib/bigisub");
const { sendEmail, orderConfirmationEmail } = require("./_lib/brevo");

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

    const { serviceId, link, quantity, username } = body;
    if (!serviceId || !quantity) {
      throw Object.assign(new Error("serviceId and quantity are required."), { statusCode: 400 });
    }

    const serviceRef = db.collection("services").doc(String(serviceId));
    const userRef = db.collection("users").doc(uid);

    // Read service + user, validate, deduct wallet — all inside one transaction
    // so two simultaneous orders can't double-spend the same balance.
    const { totalCost, service } = await db.runTransaction(async (tx) => {
      const serviceSnap = await tx.get(serviceRef);
      if (!serviceSnap.exists) {
        throw Object.assign(new Error("Service not found."), { statusCode: 404 });
      }
      const svc = serviceSnap.data();

      if (!svc.is_active) {
        throw Object.assign(new Error("This service is currently unavailable."), { statusCode: 409 });
      }
      if (quantity < svc.min_quantity || quantity > svc.max_quantity) {
        throw Object.assign(
          new Error(`Quantity must be between ${svc.min_quantity} and ${svc.max_quantity}.`),
          { statusCode: 400 }
        );
      }

      const totalCost = round2(svc.sell_price * quantity);

      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw Object.assign(new Error("User wallet not found."), { statusCode: 404 });
      }
      const wallet = userSnap.data().wallet_balance || 0;

      if (wallet < totalCost) {
        throw Object.assign(new Error("Insufficient wallet balance."), { statusCode: 402 });
      }

      tx.update(userRef, { wallet_balance: FieldValue.increment(-totalCost) });

      return { totalCost, service: svc };
    });

    // Wallet already deducted at this point. Now call BigiSub.
    let bigisubOrder;
    try {
      const orderBody = { service_id: service.service_id, quantity };
      if (link) orderBody.link = link;
      if (username) orderBody.username = username;

      bigisubOrder = await bigisub.createOrder(process.env.BIGISUB_TOKEN, orderBody);
    } catch (err) {
      // BigiSub call failed AFTER wallet was deducted — refund immediately.
      await userRef.update({ wallet_balance: FieldValue.increment(totalCost) });
      console.error("BigiSub order failed, wallet refunded:", err.message);
      throw Object.assign(
        new Error("Order failed with provider. Your wallet has been refunded."),
        { statusCode: 502 }
      );
    }

    // Record the order in Firestore for the user's order history.
    const orderRef = await db.collection("orders").add({
      uid,
      service_id: service.service_id,
      service_name: service.name,
      platform: service.platform,
      link: link || null,
      username: username || null,
      quantity,
      unit_price: service.sell_price,
      total_amount: totalCost,
      status: bigisubOrder.status || "processing",
      bigisub_order_id: bigisubOrder.id,
      bigisub_tran_id: bigisubOrder.tran_id,
      created_at: FieldValue.serverTimestamp(),
    });

    // Best-effort order confirmation email — a failure here shouldn't fail the order.
    try {
      if (decoded.email) {
        const { subject, html } = orderConfirmationEmail({
          serviceName: service.name,
          quantity,
          totalCharged: totalCost,
          orderId: orderRef.id,
        });
        await sendEmail({ to: decoded.email, subject, html });
      }
    } catch (emailErr) {
      console.error("Order confirmation email failed:", emailErr.message);
    }

    return ok({
      orderId: orderRef.id,
      trackingId: bigisubOrder.tran_id,
      status: bigisubOrder.status,
      totalCharged: totalCost,
    });
  } catch (err) {
    return fail(err);
  }
};

function round2(n) {
  return Math.round(n * 100) / 100;
}
