// netlify/functions/numbers-search-products.js
// GET /.netlify/functions/numbers-search-products?q=netflix
//   Headers: Authorization: Bearer <Firebase ID token>
//
// The main "Choose a service" grid only shows ~11 curated services
// (config.js's FIVESIM_PRODUCTS) for a clean first screen, but 5sim
// actually supports 700+. This searches the full catalog by name so
// someone can rent a number for literally any supported website/app,
// not just the ones pinned to the grid.

const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const fivesim = require("./_lib/fivesim");
const { FIVESIM_API_KEY } = require("./_lib/config");

// 5sim's product slugs are lowercase_with_underscores — turn one into a
// readable label without needing a hand-maintained name for all 700+.
function labelFromSlug(slug) {
  return slug
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAnd\b/g, "and");
}

let cachedCatalog = null; // survives warm Lambda invocations only — not persisted anywhere
let cachedAt = 0;
const CACHE_MS = 30 * 60 * 1000; // 30 min — this catalog barely changes minute to minute

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    await requireAuth(event);

    const { q } = event.queryStringParameters || {};
    if (!q || q.trim().length < 2) {
      throw Object.assign(new Error("Type at least 2 characters to search."), { statusCode: 400 });
    }

    const apiKey = FIVESIM_API_KEY;
    if (!apiKey) {
      throw Object.assign(new Error("Number rental isn't configured yet."), { statusCode: 503 });
    }

    if (!cachedCatalog || Date.now() - cachedAt > CACHE_MS) {
      cachedCatalog = await fivesim.getProducts(apiKey);
      cachedAt = Date.now();
    }

    const needle = q.trim().toLowerCase();
    const matches = Object.entries(cachedCatalog)
      .filter(([slug, info]) => info.Category === "activation" && slug.toLowerCase().includes(needle))
      .map(([slug, info]) => ({ product: slug, label: labelFromSlug(slug), qty: info.Qty || 0 }))
      .filter((p) => p.qty > 0)
      .sort((a, b) => {
        // Exact/starts-with matches first, then by availability.
        const aStarts = a.product.toLowerCase().startsWith(needle) ? 0 : 1;
        const bStarts = b.product.toLowerCase().startsWith(needle) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return b.qty - a.qty;
      })
      .slice(0, 20);

    return ok({ query: q, results: matches });
  } catch (err) {
    return fail(err);
  }
};
