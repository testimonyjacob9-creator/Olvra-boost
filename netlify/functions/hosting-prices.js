// netlify/functions/hosting-prices.js
// GET /.netlify/functions/hosting-prices
//   -> { countries: [...], durations: [...] }                (no query — picker options)
// GET /.netlify/functions/hosting-prices?country=nigeria&product=10days
//   -> { country, product, operators: [{ operator, priceNgn, count }] }
//
// Same shape as numbers-prices.js — see that file for why auth is
// required here even though prices aren't sensitive.

const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const fivesim = require("./_lib/fivesim");
const { FIVESIM_COUNTRIES, HOSTING_DURATIONS, FIVESIM_API_KEY } = require("./_lib/config");
const { getRentNumberPricing } = require("./_lib/rent-number-pricing");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    await requireAuth(event);

    const { country, product } = event.queryStringParameters || {};

    if (!country || !product) {
      return ok({ countries: FIVESIM_COUNTRIES, durations: HOSTING_DURATIONS });
    }

    const apiKey = FIVESIM_API_KEY;
    if (!apiKey) {
      throw Object.assign(new Error("Number rental isn't configured yet."), { statusCode: 503 });
    }

    const raw = await fivesim.getPrices(apiKey, { country, product });
    const byOperator = raw?.[country]?.[product] || {};
    const pricing = await getRentNumberPricing();

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
