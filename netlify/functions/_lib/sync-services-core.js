// netlify/functions/_lib/sync-services-core.js
// The actual BigiSub → Firestore sync logic, extracted so both the
// scheduled function (sync-services.js, runs every 6 hours per
// netlify.toml) and the manual-trigger function (sync-services-manual.js,
// for testing/forcing an immediate sync) share one implementation instead
// of drifting out of sync with each other.

const { db, FieldValue } = require("./firebase-admin");
const { PLATFORMS, MARKUP, CATEGORY_MARKUP_OVERRIDES, PLATFORM_CATEGORY_MARKUP_OVERRIDES, PAGE_SIZE } = require("./config");
const bigisub = require("./bigisub");

async function runSync() {
  const token = process.env.BIGISUB_TOKEN;
  if (!token) {
    throw new Error("BIGISUB_TOKEN env var is missing.");
  }

  let totalSynced = 0;
  const perPlatform = {};
  const activePlatforms = [];

  for (const platform of PLATFORMS) {
    console.log(`Syncing platform: ${platform}`);
    const services = await bigisub.fetchAllServicesForPlatform(token, platform, PAGE_SIZE);
    perPlatform[platform] = services.length;
    if (services.some((svc) => svc.is_active)) activePlatforms.push(platform);

    const chunks = chunk(services, 400);
    for (const group of chunks) {
      const batch = db.batch();
      for (const svc of group) {
        const costPrice = parseFloat(svc.price);
        const sellPrice = round2(costPrice * (1 + markupFor(svc.platform, svc.category)));

        // BigiSub's real API returns the service identifier as `id`, not
        // `service_id` (confirmed against a live response 2026-08-28) —
        // we still store/consume it as `service_id` everywhere downstream
        // (place-order.js, services.html, index.html), so map it here.
        const ref = db.collection("services").doc(String(svc.id));
        batch.set(
          ref,
          {
            service_id: svc.id,
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

  // Write a single small summary doc listing which platforms currently
  // have at least one active service. Lets the client do ONE read to
  // decide which non-curated platform tiles to show on the home screen,
  // instead of running a separate Firestore query PER platform PER
  // visitor (10 platforms × every single home-screen load — this was a
  // major driver of the Spark plan's daily read quota getting exhausted).
  // See public/index.html's initPlatformGrid()/platformHasServices().
  await db.collection("catalog_meta").doc("active_platforms").set({
    platforms: activePlatforms,
    updated_at: FieldValue.serverTimestamp(),
  });

  return { totalSynced, perPlatform, activePlatforms };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Same normalization public/index.html uses on the client for category
// matching ("Post Like" -> "post_like"), so the lookup keys line up with
// what's in CATEGORY_MARKUP_OVERRIDES.
// Same normalization public/index.html uses on the client for category
// matching ("Post Like" -> "post_like"), so the lookup keys line up with
// what's in CATEGORY_MARKUP_OVERRIDES.
function markupFor(platform, category) {
  const catKey = category && String(category).toLowerCase().trim().replace(/\s+/g, "_");
  const platKey = platform && String(platform).toLowerCase().trim().replace(/\s+/g, "_");

  // Platform + category override wins first (e.g. TikTok followers at 2%).
  if (platKey && catKey && PLATFORM_CATEGORY_MARKUP_OVERRIDES[platKey]) {
    const platOverrides = PLATFORM_CATEGORY_MARKUP_OVERRIDES[platKey];
    if (Object.prototype.hasOwnProperty.call(platOverrides, catKey)) {
      return platOverrides[catKey];
    }
  }

  if (catKey && Object.prototype.hasOwnProperty.call(CATEGORY_MARKUP_OVERRIDES, catKey)) {
    return CATEGORY_MARKUP_OVERRIDES[catKey];
  }
  return MARKUP;
}

module.exports = { runSync };
