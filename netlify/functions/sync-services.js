// netlify/functions/sync-services.js
// SCHEDULED FUNCTION — pulls live services from BigiSub, applies markup, writes
// to Firestore. Runs every 6 hours (see schedule in netlify.toml). The app
// reads from Firestore, never hits BigiSub directly from the client.
//
// Netlify scheduled functions ignore whatever you return to the caller —
// there is no caller, it's cron — so we just log and swallow the result.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { PLATFORMS, MARKUP, PAGE_SIZE } = require("./_lib/config");
const bigisub = require("./_lib/bigisub");

exports.handler = async () => {
  const token = process.env.BIGISUB_TOKEN;
  if (!token) {
    console.error("BIGISUB_TOKEN env var is missing.");
    return { statusCode: 500, body: "Missing BIGISUB_TOKEN" };
  }

  let totalSynced = 0;

  try {
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
    return { statusCode: 200, body: `Synced ${totalSynced} services` };
  } catch (err) {
    console.error("Sync failed:", err.message);
    return { statusCode: 500, body: err.message };
  }
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
