// netlify/functions/place-order.js
// HTTP FUNCTION — called from the app with:
//   POST /.netlify/functions/place-order
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body: { serviceId, quantity, link?, username?, ...variant extra fields }
//
// Re-validates price server-side (never trusts a client-sent amount),
// deducts wallet atomically, then calls BigiSub.
//
// Handoff doc gap #1: order-fields.js on the client now collects the extra
// fields BigiSub's non-Default variants need (custom_text, hashtag, media,
// groups, country/device/type_of_traffic/google_keyword, old_posts/posts/
// delay). This function forwards whichever of those keys are present —
// whitelisted below — rather than trusting/forwarding the entire body.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const bigisub = require("./_lib/bigisub");
const owlet = require("./_lib/owlet");
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

    // Extra fields required by BigiSub's non-Default order-create variants
    // (see handoff doc gap #1). Only whitelisted keys are ever forwarded —
    // never the raw client body — so this can't become an arbitrary
    // passthrough to BigiSub.
    const EXTRA_FIELD_KEYS = [
      "custom_text", "hashtag", "media", "groups",
      "country", "device", "type_of_traffic", "google_keyword",
      "old_posts", "posts", "delay",
    ];
    const extraFields = {};
    for (const key of EXTRA_FIELD_KEYS) {
      if (body[key] !== undefined && body[key] !== null && body[key] !== "") {
        extraFields[key] = body[key];
      }
    }

    if (!serviceId || !quantity) {
      throw Object.assign(new Error("serviceId and quantity are required."), { statusCode: 400 });
    }

    const serviceRef = db.collection("services").doc(String(serviceId));
    const userRef = db.collection("users").doc(uid);

    // Read service + user, validate, deduct wallet — all inside one transaction
    // so two simultaneous orders can't double-spend the same balance.
    const { totalCost, service, olivesUsed } = await db.runTransaction(async (tx) => {
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
      const olives = userSnap.data().olive_balance || 0;
      const oliveValue = round2(olives * 2); // 1 Olive = ₦2, referral-earned, not withdrawable

      if (wallet + oliveValue < totalCost) {
        throw Object.assign(new Error("Insufficient wallet balance."), { statusCode: 402 });
      }

      // Spend wallet first, then Olives for whatever's left. Olives only
      // come in whole units (₦2 each), so if the remainder isn't an exact
      // multiple of 2 we round UP the Olives spent and credit the few kobo
      // of overshoot straight back to the wallet as change — the user is
      // never short-changed by the rounding.
      const walletUsed = Math.min(wallet, totalCost);
      const remainder = round2(totalCost - walletUsed);
      let olivesUsed = 0;
      let changeToWallet = 0;
      if (remainder > 0) {
        olivesUsed = Math.ceil(remainder / 2);
        changeToWallet = round2(olivesUsed * 2 - remainder);
      }

      const walletDelta = changeToWallet - walletUsed;
      tx.update(userRef, {
        wallet_balance: FieldValue.increment(walletDelta),
        ...(olivesUsed > 0 ? { olive_balance: FieldValue.increment(-olivesUsed) } : {}),
      });

      return { totalCost, service: svc, olivesUsed };
    });

    // Wallet already deducted at this point. Now call the RIGHT provider —
    // each service is tagged `provider: "bigisub"` or `"owlet"` at sync
    // time (see sync-services-core.js). Normalized into a common shape
    // afterward so the rest of this function (order doc, refund, email)
    // doesn't need to know which provider was used.
    const provider = service.provider || "bigisub"; // services synced before this existed are all BigiSub
    let providerOrderId, providerTranId, providerStatus, providerRaw;
    try {
      if (provider === "owlet") {
        const owletKey = process.env.OWLET_API_KEY;
        if (!owletKey) throw new Error("Owlet is not configured (OWLET_API_KEY missing).");
        const result = await owlet.createOrder(owletKey, {
          service: service.service_id,
          link: link || username,
          quantity: Number(quantity),
        });
        providerOrderId = result.orderId;
        providerTranId = result.orderId; // Owlet's docs show one order identifier, not a separate tran_id like BigiSub
        providerStatus = result.status;
        providerRaw = result.raw;
      } else {
        // BigiSub's own /services/ listing endpoint uses `id` as the
        // service identifier field, not `service_id` (see
        // sync-services-core.js). Most SMM-panel-style APIs (the
        // widespread "v2" convention) expect the order-create field to
        // be named `service`, not `service_id` — sending both covers
        // either convention without risk, since REST APIs ignore fields
        // they don't recognize.
        const orderBody = {
          service_id: service.service_id,
          service: service.service_id,
          quantity: Number(quantity),
          ...extraFields,
        };
        if (link) orderBody.link = link;
        if (username) orderBody.username = username;
        const bigisubOrder = await bigisub.createOrder(process.env.BIGISUB_TOKEN, orderBody);
        providerOrderId = bigisubOrder.id;
        providerTranId = bigisubOrder.tran_id;
        providerStatus = bigisubOrder.status;
        providerRaw = bigisubOrder;
      }
    } catch (err) {
      // Provider call failed AFTER wallet/Olives were deducted — refund both immediately.
      await userRef.update({
        wallet_balance: FieldValue.increment(totalCost - (olivesUsed > 0 ? olivesUsed * 2 : 0)),
        ...(olivesUsed > 0 ? { olive_balance: FieldValue.increment(olivesUsed) } : {}),
      });
      console.error(
        `${provider} order failed, wallet refunded:`,
        err.message,
        "| service:", service.service_id
      );
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
      provider,
      link: link || null,
      username: username || null,
      ...(Object.keys(extraFields).length ? { extra_fields: extraFields } : {}),
      quantity,
      unit_price: service.sell_price,
      total_amount: totalCost,
      ...(olivesUsed > 0 ? { olives_used: olivesUsed } : {}),
      status: providerStatus || "processing",
      // Kept as BOTH the legacy BigiSub-specific fields (existing code —
      // order-status-sync-core.js, orders.html — already reads these) AND
      // the new provider-neutral ones, so nothing downstream breaks.
      bigisub_order_id: provider === "bigisub" ? providerOrderId : null,
      bigisub_tran_id: provider === "bigisub" ? providerTranId : null,
      owlet_order_id: provider === "owlet" ? providerOrderId : null,
      ...(provider === "owlet" ? { owlet_raw_response: providerRaw } : {}),
      created_at: FieldValue.serverTimestamp(),
    });

    // Best-effort in-app notification — a failure here shouldn't fail the order.
    try {
      await db.collection("users").doc(uid).collection("notifications").add({
        type: "order_placed",
        title: "Order placed",
        body: `${quantity} × ${service.name} — ₦${totalCost.toLocaleString()}`,
        order_id: orderRef.id,
        read: false,
        created_at: FieldValue.serverTimestamp(),
      });
    } catch (notifErr) {
      console.error("Order notification write failed:", notifErr.message);
    }

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
      trackingId: providerTranId || providerOrderId,
      status: providerStatus,
      totalCharged: totalCost,
    });
  } catch (err) {
    return fail(err);
  }
};

function round2(n) {
  return Math.round(n * 100) / 100;
}
