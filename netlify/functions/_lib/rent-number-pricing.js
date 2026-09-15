// _lib/rent-number-pricing.js
// Lets the admin change Rent Number's margin from the dashboard
// (settings/global doc) instead of needing a code deploy. Falls back to
// config.js's hardcoded defaults for any field the admin hasn't set yet.
//
// Cached in-memory per warm Lambda instance for 2 minutes — admin pricing
// changes aren't time-critical, and this avoids a settings read on every
// single numbers-prices.js call.

const { db } = require("./firebase-admin");
const { FIVESIM_USD_TO_NGN, FIVESIM_MARKUP, FIVESIM_MIN_MARGIN_NGN } = require("./config");

let cached = null;
let cachedAt = 0;
const CACHE_MS = 2 * 60 * 1000;

async function getRentNumberPricing() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;

  let overrides = {};
  try {
    const snap = await db.collection("settings").doc("global").get();
    if (snap.exists) {
      const data = snap.data();
      overrides = {
        usdToNgn: typeof data.fivesim_usd_to_ngn === "number" ? data.fivesim_usd_to_ngn : undefined,
        markup: typeof data.fivesim_markup === "number" ? data.fivesim_markup : undefined,
        minMarginNgn: typeof data.fivesim_min_margin_ngn === "number" ? data.fivesim_min_margin_ngn : undefined,
      };
    }
  } catch (err) {
    console.error("getRentNumberPricing: settings read failed, using config.js defaults:", err.message);
  }

  cached = {
    usdToNgn: overrides.usdToNgn ?? FIVESIM_USD_TO_NGN,
    markup: overrides.markup ?? FIVESIM_MARKUP,
    minMarginNgn: overrides.minMarginNgn ?? FIVESIM_MIN_MARGIN_NGN,
  };
  cachedAt = Date.now();
  return cached;
}

module.exports = { getRentNumberPricing };
