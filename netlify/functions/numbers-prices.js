// netlify/functions/numbers-prices.js
// GET /.netlify/functions/numbers-prices
//   -> { countries: [...], products: [...] }               (no query — picker options)
// GET /.netlify/functions/numbers-prices?country=nigeria&product=whatsapp
//   -> { country, product, operators: [{ operator, priceNgn, count }] }
//
// Auth required (same as every other in-app endpoint) purely to keep this
// off the open internet — prices themselves aren't sensitive, this just
// avoids random bots hammering 5sim through our function.

const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const fivesim = require("./_lib/fivesim");
const { FIVESIM_COUNTRIES, FIVESIM_PRODUCTS } = require("./_lib/config");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    await requireAuth(event);

    const { country, product } = event.queryStringParameters || {};

    if (!country || !product) {
      return ok({ countries: FIVESIM_COUNTRIES, products: FIVESIM_PRODUCTS });
    }

    const apiKey = process.env.FIVESIM_API_KEY;
    if (!apiKey) {
      throw Object.assign(new Error("Number rental isn't configured yet."), { statusCode: 503 });
    }

    const raw = await fivesim.getPrices(apiKey, { country, product });
    // Shape: { [country]: { [product]: { [operator]: { cost, count } } } }
    const byOperator = raw?.[country]?.[product] || {};

    const operators = Object.entries(byOperator)
      .map(([operator, info]) => ({
        operator,
        count: info.count || 0,
        priceNgn: fivesim.sellPriceNgn(info.cost || 0),
      }))
      .filter((o) => o.count > 0)
      .sort((a, b) => a.priceNgn - b.priceNgn);

    return ok({ country, product, operators });
  } catch (err) {
    return fail(err);
  }
};
