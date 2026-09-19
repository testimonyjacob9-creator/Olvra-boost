// netlify/functions/hosting-prices.js
// GET /.netlify/functions/hosting-prices
//   -> { countries: [...] }                                      (no query — country picker)
// GET /.netlify/functions/hosting-prices?country=nigeria
//   -> { country, durations: [{ product, label, count, priceNgn }] }   (real, live durations for this country)
// GET /.netlify/functions/hosting-prices?country=nigeria&product=10days
//   -> { country, product, operators: [{ operator, priceNgn, count }] }
//
// The duration step no longer offers a hardcoded guess list — it calls
// 5sim's own /v1/guest/products/$country/any (Category==="hosting") to
// find which duration slugs actually exist and have stock for that
// specific country, then only queries guest/prices with slugs already
// confirmed valid. Passing a slug 5sim doesn't recognize for a country
// straight to guest/prices is what produced "400 product is incorrect"
// before (2026-09-18).
//
// Same shape as numbers-prices.js — see that file for why auth is
// required here even though prices aren't sensitive.

const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const fivesim = require("./_lib/fivesim");
const { FIVESIM_COUNTRIES, HOSTING_DURATIONS, FIVESIM_API_KEY } = require("./_lib/config");
const { getRentNumberPricing } = require("./_lib/rent-number-pricing");

const DURATION_LABELS = Object.fromEntries(HOSTING_DURATIONS.map((d) => [d.product, d.label]));

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    await requireAuth(event);

    const { country, product } = event.queryStringParameters || {};

    if (!country) {
      return ok({ countries: FIVESIM_COUNTRIES });
    }

    const apiKey = FIVESIM_API_KEY;
    if (!apiKey) {
      throw Object.assign(new Error("Number rental isn't configured yet."), { statusCode: 503 });
    }

    const pricing = await getRentNumberPricing();

    if (!product) {
      // Discover the real, live duration options for this country instead
      // of assuming a fixed list — this is the step that used to 400.
      const raw = await fivesim.getProducts(apiKey, { country, operator: "any" });
      const durations = Object.entries(raw || {})
        .filter(([, info]) => info.Category === "hosting" && (info.Qty || 0) > 0)
        .map(([key, info]) => ({
          product: key,
          label: DURATION_LABELS[key] || key,
          count: info.Qty || 0,
          priceNgn: fivesim.sellPriceNgn(info.Price || 0, pricing),
        }))
        .sort((a, b) => a.priceNgn - b.priceNgn);
      return ok({ country, durations });
    }

    const raw = await fivesim.getPrices(apiKey, { country, product });
    const byOperator = raw?.[country]?.[product] || {};

    const operators = Object.entries(byOperator)
      .map(([operator, info]) => ({
        operator,
        count: info.count || 0,
        priceNgn: fivesim.sellPriceNgn(info.cost || 0, pricing),
      }))
      .filter((o) => o.count > 0)
      .sort((a, b) => a.priceNgn - b.priceNgn);

    return ok({ country, product, operators });
  } catch (err) {
    return fail(err);
  }
};
