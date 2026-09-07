// netlify/functions/_lib/sync-services-core.js
// The actual BigiSub → Firestore sync logic, extracted so both the
// scheduled function (sync-services.js, runs every 6 hours per
// netlify.toml) and the manual-trigger function (sync-services-manual.js,
// for testing/forcing an immediate sync) share one implementation instead
// of drifting out of sync with each other.

const { db, FieldValue } = require("./firebase-admin");
const {
  PLATFORMS, MARKUP, CATEGORY_MARKUP_OVERRIDES, PLATFORM_CATEGORY_MARKUP_OVERRIDES, PAGE_SIZE,
  OWLET_MARKUP, OWLET_PLATFORM_ALIASES, OWLET_SOURCES,
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

    // Same fix as Owlet got below: only write what actually changed,
    // instead of unconditionally rewriting every service on every 6-hour
    // run. One bulk query per platform reads what's already synced, then
    // each service is compared before deciding to write — trades some
    // reads for far fewer writes, worth it since Firestore's Spark plan
    // gives reads 2.5x more daily headroom (50K) than writes (20K).
    // (2026-09-04.)
    const existingBigisubSnap = await db
      .collection("services")
      .where("provider", "==", "bigisub")
      .where("platform", "==", platform)
      .get();
    const existingBigisubById = new Map();
    existingBigisubSnap.forEach((d) => existingBigisubById.set(d.id, d.data()));

    const bigisubToWrite = [];
    for (const svc of services) {
      const costPrice = parseFloat(svc.price);
      const sellPrice = round2(costPrice * (1 + markupFor(svc.platform, svc.category)));
      const docId = String(svc.id);
      const existing = existingBigisubById.get(docId);
      const unchanged = existing
        && existing.cost_price === costPrice
        && existing.sell_price === sellPrice
        && existing.min_quantity === svc.min_quantity
        && existing.max_quantity === svc.max_quantity
        && existing.is_active === svc.is_active
        && existing.has_refill === !!svc.has_refill
        && existing.has_cancel === !!svc.has_cancel
        && existing.name === svc.name;
      if (!unchanged) bigisubToWrite.push({ svc, docId, costPrice, sellPrice });
    }

    const chunks = chunk(bigisubToWrite, 400);
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
  } // end includeBigisub

  // ---- Owlet-family ("Global Source" / Source 2) ----
  // Loops over every account in OWLET_SOURCES (config.js) — currently 2,
  // pooled into the same "Global Source" the user picks (Testimony's
  // call, 2026-09-03: wider stock, not a 3rd picker card). Only runs if
  // includeOwlet is true — split out onto its own daily schedule (see
  // sync-services-owlet.js) rather than running every 6 hours like
  // BigiSub: the combined catalog is enormous (~21K raw services across
  // both accounts as of 2026-09-03), so syncing that often was a
  // meaningful chunk of daily Firestore write quota for a catalog that
  // doesn't need that much freshness.
  let owletSynced = 0;
  const owletActivePlatforms = new Set();
  if (includeOwlet) {
    for (const source of OWLET_SOURCES) {
      const sourceKey = process.env[source.envKey];
      if (!sourceKey) {
        console.warn(`${source.envKey} not set — skipping Owlet source "${source.id}".`);
        continue;
      }
      try {
        const allOwletServices = await owlet.fetchAllServices(source.baseUrl, sourceKey);
        const matched = allOwletServices
          .map((svc) => ({ ...svc, platform: detectOwletPlatform(svc) }))
          .filter((svc) => svc.platform && PLATFORMS.includes(svc.platform));
        matched.forEach((svc) => owletActivePlatforms.add(svc.platform));

        // Only write what actually changed. Was writing every matched
        // service unconditionally, every single sync — with ~21K raw
        // services across 2 accounts, that's a lot of writes for data
        // that mostly hasn't moved since yesterday (SMM panel pricing
        // doesn't churn daily for most of a catalog this size). ONE bulk
        // query reads everything already synced for this source, then
        // each service is compared before deciding to write.
        //
        // This trades writes for reads, which is worth doing specifically
        // because Firestore's Spark plan gives reads 2.5x more daily
        // headroom (50K) than writes (20K) — writes were the tighter
        // constraint, so shifting load onto the roomier quota helps even
        // though the total operation count technically goes up.
        // (2026-09-04 — this was a real contributor to hitting the daily
        // quota.)
        const existingSnap = await db
          .collection("services")
          .where("provider", "==", "owlet")
          .where("owlet_account", "==", source.id)
          .get();
        const existingById = new Map();
        existingSnap.forEach((d) => existingById.set(d.id, d.data()));

        const toWrite = [];
        for (const svc of matched) {
          const costPrice = round2(parseFloat(svc.rate) / 1000);
          const sellPrice = round2(costPrice * (1 + OWLET_MARKUP));
          const docId = `owlet_${source.id}_${svc.service}`;
          const existing = existingById.get(docId);
          const unchanged = existing
            && existing.cost_price === costPrice
            && existing.sell_price === sellPrice
            && existing.min_quantity === svc.min
            && existing.max_quantity === svc.max
            && existing.has_refill === !!svc.refill
            && existing.has_cancel === !!svc.cancel
            && existing.name === svc.name
            // Catches schema migrations too — a doc synced before
            // owlet_account existed (or with the wrong account id after
            // a copy/rename) would otherwise be silently skipped forever,
            // since none of the price/name fields above would look
            // "changed". Confirmed live 2026-09-07: exactly this caused
            // every Owlet order to fail with "Unknown Owlet source
            // account 'undefined'" on services synced before multi-
            // account support existed.
            && existing.owlet_account === source.id;
          if (!unchanged) toWrite.push({ svc, docId, costPrice, sellPrice });
        }

        const owletChunks = chunk(toWrite, 400);
        for (const group of owletChunks) {
          const batch = db.batch();
          for (const { svc, docId, costPrice, sellPrice } of group) {
            // Prefixed with the account id too — two different Owlet
            // accounts could plausibly reuse overlapping service IDs,
            // this guarantees no collision between accounts OR with
            // BigiSub's own numeric IDs.
            const ref = db.collection("services").doc(docId);
            batch.set(
              ref,
              {
                service_id: svc.service,
                provider: "owlet",
                owlet_account: source.id, // which account/key to order against — see place-order.js
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
        console.error(`Owlet sync failed for source "${source.id}":`, err.message);
      }
    }
  } else {
    console.warn("includeOwlet is false — skipping Owlet-family sync this run.");
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
