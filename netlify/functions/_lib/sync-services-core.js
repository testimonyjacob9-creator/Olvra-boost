// netlify/functions/_lib/sync-services-core.js
// The actual BigiSub → Firestore sync logic, extracted so both the
// scheduled function (sync-services.js, runs every 6 hours per
// netlify.toml) and the manual-trigger function (sync-services-manual.js,
// for testing/forcing an immediate sync) share one implementation instead
// of drifting out of sync with each other.

const { db, FieldValue } = require("./firebase-admin");
const {
  PLATFORMS, MARKUP, CATEGORY_MARKUP_OVERRIDES, PLATFORM_CATEGORY_MARKUP_OVERRIDES, PAGE_SIZE,
  OWLET_MARKUP, OWLET_PLATFORM_ALIASES,
} = require("./config");
const bigisub = require("./bigisub");
const owlet = require("./owlet");

async function runSync({ includeBigisub = true, includeOwlet = true } = {}) {
  const token = process.env.BIGISUB_TOKEN;
  if (includeBigisub && !token) {
    throw new Error("BIGISUB_TOKEN env var is missing.");
  }

  let totalSynced = 0;
  const perPlatform = {};
  const activePlatforms = [];

  if (includeBigisub) {
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
  } // end includeBigisub

  // ---- Owlet ("Global Source" / Source 2) ----
  // Only runs if OWLET_API_KEY is set AND includeOwlet is true — split out
  // onto its own daily schedule (see sync-services-owlet.js) rather than
  // running every 6 hours like BigiSub: its catalog is roughly 10x the
  // size, so syncing it 4x/day was a meaningfully large chunk of daily
  // Firestore write quota for a catalog that doesn't need that much
  // freshness (2026-09-03 — this was the main driver behind hitting the
  // daily Firestore quota).
  let owletSynced = 0;
  const owletActivePlatforms = new Set();
  const owletKey = process.env.OWLET_API_KEY;
  if (includeOwlet && owletKey) {
    try {
      const allOwletServices = await owlet.fetchAllServices(owletKey);
      const matched = allOwletServices
        .map((svc) => ({ ...svc, platform: detectOwletPlatform(svc) }))
        .filter((svc) => svc.platform && PLATFORMS.includes(svc.platform));
      matched.forEach((svc) => owletActivePlatforms.add(svc.platform));

      const owletChunks = chunk(matched, 400);
      for (const group of owletChunks) {
        const batch = db.batch();
        for (const svc of group) {
          // Owlet's "rate" is price per 1000 units (the near-universal
          // SMM-panel convention) — BigiSub's `price` above is already
          // per-unit, so this is a DIFFERENT conversion, not a copy-paste
          // of the BigiSub math. Confirmed via a live test order attempt
          // 2026-09-02 (insufficient-funds error came back correctly
          // priced against this assumption, at least at the request-
          // validation stage — full confirmation needs one real funded
          // order).
          const costPrice = round2(parseFloat(svc.rate) / 1000);
          const sellPrice = round2(costPrice * (1 + OWLET_MARKUP));

          // Prefixed doc ID — Owlet's service IDs are a different id
          // space than BigiSub's, this just guarantees no collision.
          const ref = db.collection("services").doc(`owlet_${svc.service}`);
          batch.set(
            ref,
            {
              service_id: svc.service,
              provider: "owlet",
              name: svc.name,
              platform: svc.platform,
              country: null,
              category: svc.category,
              description: "",
              cost_price: costPrice,
              sell_price: sellPrice,
              pricing_model: "rate_per_1000",
              min_quantity: svc.min,
              max_quantity: svc.max,
              is_active: true,
              service_type: svc.type || "Default",
              has_dripfeed: false,
              has_refill: !!svc.refill,
              has_cancel: !!svc.cancel,
              synced_at: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
        await batch.commit();
        owletSynced += group.length;
      }
    } catch (err) {
      console.error("Owlet sync failed:", err.message);
    }
  } else if (includeOwlet) {
    console.warn("OWLET_API_KEY not set — skipping Owlet sync.");
  }

  // Write a single small summary doc listing which platforms currently
  // have at least one active service. Lets the client do ONE read to
  // decide which non-curated platform tiles to show on the home screen,
  // instead of running a separate Firestore query PER platform PER
  // visitor (10 platforms × every single home-screen load — this was a
  // major driver of the Spark plan's daily read quota getting exhausted).
  // See public/index.html's initPlatformGrid()/platformHasServices().
  //
  // MERGED with whatever's already there, not overwritten — BigiSub and
  // Owlet now sync on separate schedules (BigiSub every 6h, Owlet once
  // daily), so any single run of this function only knows about ONE
  // provider's platforms. A plain overwrite would erase the other
  // provider's contribution every time its schedule fires. Trade-off: a
  // platform that genuinely goes inactive on one provider stays listed
  // until the OTHER provider's next run also confirms it's gone — safer
  // than a real tile flickering in and out depending on which schedule
  // happened to run most recently.
  const metaRef = db.collection("catalog_meta").doc("active_platforms");
  const existingMetaSnap = await metaRef.get();
  const existingPlatforms = existingMetaSnap.exists ? (existingMetaSnap.data().platforms || []) : [];
  const mergedPlatforms = [...new Set([...existingPlatforms, ...activePlatforms, ...owletActivePlatforms])];
  await metaRef.set({
    platforms: mergedPlatforms,
    updated_at: FieldValue.serverTimestamp(),
  });

  return { totalSynced: totalSynced + owletSynced, perPlatform, activePlatforms: mergedPlatforms, owletSynced };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Owlet has no clean `platform` field — just a messy free-text
// `category` (often with emoji/tags) plus the service `name`. Detected
// by substring match against both, lowercased, using OWLET_PLATFORM_ALIASES
// from config.js. Returns null (skip this service) if nothing matches —
// deliberate, keeps the import scoped to platforms Boost already
// supports rather than pulling in Owlet's full unrelated catalog.
function detectOwletPlatform(svc) {
  const text = `${svc.name || ""} ${svc.category || ""}`.toLowerCase();
  for (const [platform, aliases] of Object.entries(OWLET_PLATFORM_ALIASES)) {
    if (aliases.some((alias) => text.includes(alias))) return platform;
  }
  return null;
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
