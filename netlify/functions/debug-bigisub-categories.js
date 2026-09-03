// netlify/functions/debug-bigisub-categories.js
//
// TEMPORARY DIAGNOSTIC ENDPOINT — visit directly in your browser:
//   https://olvraboost.netlify.app/.netlify/functions/debug-bigisub-categories
//
// The markup overrides in _lib/config.js (CATEGORY_MARKUP_OVERRIDES,
// PLATFORM_CATEGORY_MARKUP_OVERRIDES) aren't matching real orders — every
// order is landing at the flat 5% default instead of the intended 15%
// (likes/views) or 2% (TikTok followers). This pulls BigiSub's REAL raw
// category strings for tiktok + facebook so the normalization logic in
// sync-services-core.js can be fixed against what BigiSub actually sends,
// not a guess.
//
// DELETE THIS FILE once the fix is confirmed — no secret in this one,
// but it's not something a shipped app needs either.

const bigisub = require("./_lib/bigisub");

exports.handler = async () => {
  const token = process.env.BIGISUB_TOKEN;
  if (!token) {
    return { statusCode: 200, body: JSON.stringify({ error: "BIGISUB_TOKEN not set" }) };
  }

  try {
    const [tiktok, facebook] = await Promise.all([
      bigisub.fetchAllServicesForPlatform(token, "tiktok"),
      bigisub.fetchAllServicesForPlatform(token, "facebook"),
    ]);

    function summarize(services) {
      const uniqueCategories = [...new Set(services.map((s) => s.category))];
      // A couple of real full examples per category so we see name +
      // category + price together, not just the bare category string.
      const samples = uniqueCategories.slice(0, 15).map((cat) => {
        const example = services.find((s) => s.category === cat);
        return { category: cat, example_name: example?.name, example_price: example?.price };
      });
      return { total: services.length, unique_category_count: uniqueCategories.length, samples };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tiktok: summarize(tiktok), facebook: summarize(facebook) }, null, 2),
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ error: err.message }) };
  }
};
