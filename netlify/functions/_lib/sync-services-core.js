// netlify/functions/_lib/sync-services-core.js
// The actual BigiSub → Firestore sync logic, extracted so both the
// scheduled function (sync-services.js, runs once daily per netlify.toml)
// and the manual-trigger function (sync-services-manual.js, for
// testing/forcing an immediate sync) share one implementation instead of
// drifting out of sync with each other.
//
// 2026-09-07: Owlet ("Global Source") removed entirely per Testimony's
// request — back to BigiSub as the only provider.

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
    let services;
    try {
      services = await bigisub.fetchAllServicesForPlatform(token, platform, PAGE_SIZE);
    } catch (err) {
      // One platform BigiSub doesn't recognize (or a transient error on
      // just that call) used to take down the ENTIRE sync loop — every
      // platform after it in the list never got synced either. Now it's
      // just skipped and logged, so widening PLATFORMS is safe even
      // before confirming BigiSub actually supports every new entry.
      console.error(`BigiSub fetch failed for platform "${platform}", skipping it this run:`, err.message);
      continue;
    }
    perPlatform[platform] = services.length;
    if (services.some((svc) => svc.is_active)) activePlatforms.push(platform);

    // Only write what actually changed, instead of unconditionally
    // rewriting every service on every run. One bulk query per platform
    // reads what's already synced, then each service is compared before
    // deciding to write — trades some reads for far fewer writes, worth
    // it since Firestore's Spark plan gives reads 2.5x more daily
    // headroom (50K) than writes (20K). (2026-09-04.)
    const existingSnap = await db
      .collection("services")
      .where("provider", "==", "bigisub")
      .where("platform", "==", platform)
      .get();
    const existingById = new Map();
    existingSnap.forEach((d) => existingById.set(d.id, d.data()));

    const toWrite = [];
    for (const svc of services) {
      const costPrice = parseFloat(svc.price);
      const sellPrice = round2(costPrice * (1 + markupFor(svc.platform, svc.category)));
      const docId = String(svc.id);
      const existing = existingById.get(docId);
      const unchanged = existing
        && existing.cost_price === costPrice
        && existing.sell_price === sellPrice
        && existing.min_quantity === svc.min_quantity
        && existing.max_quantity === svc.max_quantity
        && existing.is_active === svc.is_active
        && existing.has_refill === !!svc.has_refill
        && existing.has_cancel === !!svc.has_cancel
        && existing.name === svc.name;
      if (!unchanged) toWrite.push({ svc, docId, costPrice, sellPrice });
    }

    const chunks = chunk(toWrite, 400);
    for (const group of chunks) {
      const batch = db.batch();
      for (const { svc, docId, costPrice, sellPrice } of group) {
        // BigiSub's real API returns the service identifier as `id`, not
        // `service_id` (confirmed against a live response 2026-08-28) —
        // we still store/consume it as `service_id` everywhere downstream
        // (place-order.js, services.html, index.html), so map it here.
        const ref = db.collection("services").doc(docId);
        batch.set(
          ref,
          {
            service_id: svc.id,
            provider: "bigisub",
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
  // visitor (this was a major driver of the Spark plan's daily read
  // quota getting exhausted). See public/index.html's
  // initPlatformGrid()/platformHasServices().
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
