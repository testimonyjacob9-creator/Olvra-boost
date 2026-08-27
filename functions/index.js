// index.js
// Entry point for all Cloud Functions.

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const { PLATFORMS, MARKUP, PAGE_SIZE } = require("./config");
const bigisub = require("./bigisub");

initializeApp();
const db = getFirestore();

// Store your BigiSub token as a Firebase secret, never in code:
//   firebase functions:secrets:set BIGISUB_TOKEN
const BIGISUB_TOKEN = defineSecret("BIGISUB_TOKEN");

// ---------------------------------------------------------------------------
// 1. SCHEDULED SYNC — pulls live services from BigiSub, applies markup, writes
//    to Firestore. Runs every 6 hours. Your app reads from Firestore, never
//    hits BigiSub directly from the client.
// ---------------------------------------------------------------------------
exports.syncServices = onSchedule(
  {
    schedule: "every 6 hours",
    secrets: [BIGISUB_TOKEN],
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    const token = BIGISUB_TOKEN.value();
    let totalSynced = 0;

    for (const platform of PLATFORMS) {
      console.log(`Syncing platform: ${platform}`);
      const services = await bigisub.fetchAllServicesForPlatform(token, platform, PAGE_SIZE);

      // Batch writes — Firestore caps batches at 500 ops, so chunk it.
      const chunks = chunk(services, 400);
      for (const group of chunks) {
        const batch = db.batch();
        for (const svc of group) {
          const costPrice = parseFloat(svc.price);
          const sellPrice = round2(costPrice * (1 + MARKUP));

          const ref = db.collection("services").doc(String(svc.service_id));
          batch.set(
            ref,
            {
              service_id: svc.service_id,
              name: svc.name,
              platform: svc.platform,
              country: svc.country,
              category: svc.category,
              description: svc.description || "",
              cost_price: costPrice,
              sell_price: sellPrice,
              pricing_model: svc.pricing_model,
              min_quantity: svc.min_quantity,
              max_quantity: svc.max_quantity,
              is_active: svc.is_active,
              service_type: svc.service_type,
              has_dripfeed: !!svc.has_dripfeed,
              has_refill: !!svc.has_refill,
              has_cancel: !!svc.has_cancel,
              synced_at: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
        await batch.commit();
        totalSynced += group.length;
      }
    }

    console.log(`Sync complete. Total services synced: ${totalSynced}`);
    return null;
  }
);

// ---------------------------------------------------------------------------
// 2. PLACE ORDER — callable from the app. Re-validates price server-side
//    (never trusts a client-sent amount), deducts wallet atomically, then
//    calls BigiSub to place the order.
// ---------------------------------------------------------------------------
exports.placeOrder = onCall({ secrets: [BIGISUB_TOKEN] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "You must be signed in to place an order.");
  }

  const { serviceId, link, quantity, username } = request.data || {};
  if (!serviceId || !quantity) {
    throw new HttpsError("invalid-argument", "serviceId and quantity are required.");
  }

  const serviceRef = db.collection("services").doc(String(serviceId));
  const userRef = db.collection("users").doc(uid);

  // Read service + user, validate, deduct wallet — all inside one transaction
  // so two simultaneous orders can't double-spend the same balance.
  const { totalCost, service } = await db.runTransaction(async (tx) => {
    const serviceSnap = await tx.get(serviceRef);
    if (!serviceSnap.exists) {
      throw new HttpsError("not-found", "Service not found.");
    }
    const svc = serviceSnap.data();

    if (!svc.is_active) {
      throw new HttpsError("failed-precondition", "This service is currently unavailable.");
    }
    if (quantity < svc.min_quantity || quantity > svc.max_quantity) {
      throw new HttpsError(
        "invalid-argument",
        `Quantity must be between ${svc.min_quantity} and ${svc.max_quantity}.`
      );
    }

    // sell_price is per-unit (matches BigiSub's per_1000/per_unit model already
    // stored during sync) — adjust this math if you store price per 1000 instead.
    const totalCost = round2(svc.sell_price * quantity);

    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) {
      throw new HttpsError("not-found", "User wallet not found.");
    }
    const wallet = userSnap.data().wallet_balance || 0;

    if (wallet < totalCost) {
      throw new HttpsError("failed-precondition", "Insufficient wallet balance.");
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

    bigisubOrder = await bigisub.createOrder(BIGISUB_TOKEN.value(), orderBody);
  } catch (err) {
    // BigiSub call failed AFTER wallet was deducted — refund immediately.
    await userRef.update({ wallet_balance: FieldValue.increment(totalCost) });
    console.error("BigiSub order failed, wallet refunded:", err.message);
    throw new HttpsError("internal", "Order failed with provider. Your wallet has been refunded.");
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

  return {
    orderId: orderRef.id,
    trackingId: bigisubOrder.tran_id,
    status: bigisubOrder.status,
    totalCharged: totalCost,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
