// netlify/functions/_lib/sync-services-core.js
// The actual BigiSub → Firestore sync logic, extracted so both the
// scheduled function (sync-services.js, runs every 6 hours per
// netlify.toml) and the manual-trigger function (sync-services-manual.js,
// for testing/forcing an immediate sync) share one implementation instead
// of drifting out of sync with each other.

const { db, FieldValue } = require("./firebase-admin");
const { PLATFORMS, MARKUP, PAGE_SIZE } = require("./config");
const bigisub = require("./bigisub");

async function runSync() {
  const token = process.env.BIGISUB_TOKEN;
  if (!token) {
    throw new Error("BIGISUB_TOKEN env var is missing.");
  }

  let totalSynced = 0;
  const perPlatform = {};

  for (const platform of PLATFORMS) {
    console.log(`Syncing platform: ${platform}`);
    const services = await bigisub.fetchAllServicesForPlatform(token, platform, PAGE_SIZE);
    perPlatform[platform] = services.length;

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

  return { totalSynced, perPlatform };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { runSync };
