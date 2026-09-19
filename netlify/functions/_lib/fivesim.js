// _lib/fivesim.js
// Thin wrapper around the 5sim.net API (virtual numbers for receiving SMS —
// "Rent Number" feature). The API key is read from Netlify env vars — never
// hardcode it.
//
// 5sim's "vendor" endpoints (documented separately in their docs) are for
// people who supply physical SIM cards INTO 5sim's network — not what this
// app does. This wrapper only uses the plain USER endpoints: buy a number,
// poll for the SMS code, then finish/cancel it. See _lib/config.js for the
// curated product/country lists and pricing knobs.

const axios = require("axios");
const { FIVESIM_BASE_URL } = require("./config");

function client(apiKey) {
  return axios.create({
    baseURL: FIVESIM_BASE_URL,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    timeout: 15000,
  });
}

/**
 * Live guest prices for one country+product — no auth required. Shape from
 * 5sim: { [country]: { [product]: { [operator]: { cost, count, rate } } } }.
 * Callers should pick the cheapest operator with count > 0 (or just use
 * operator "any" at buy time and let 5sim pick).
 */
async function getPrices(apiKey, { country, product }) {
  const api = client(apiKey);
  const res = await api.get("/v1/guest/prices", { params: { country, product } });
  return res.data;
}

/**
 * Buy an activation number. operator defaults to "any" (5sim auto-picks the
 * cheapest available) unless a specific one is requested.
 */
async function buyActivation(apiKey, { country, product, operator = "any" }) {
  const api = client(apiKey);
  const res = await api.get(`/v1/user/buy/activation/${country}/${operator}/${product}`);
  if (!res.data || !res.data.id) {
    throw new Error(`5sim buy failed: ${JSON.stringify(res.data)}`);
  }
  return res.data; // { id, phone, operator, product, price, status, expires, sms: [], created_at, country }
}

/** Poll an order for its current status and any received SMS codes. */
async function checkOrder(apiKey, orderId) {
  const api = client(apiKey);
  const res = await api.get(`/v1/user/check/${orderId}`);
  return res.data;
}

/** Mark an order finished (code used, releases the number normally). */
async function finishOrder(apiKey, orderId) {
  const api = client(apiKey);
  const res = await api.get(`/v1/user/finish/${orderId}`);
  return res.data;
}

/** Cancel an order — 5sim only allows this in a short window right after purchase. */
async function cancelOrder(apiKey, orderId) {
  const api = client(apiKey);
  const res = await api.get(`/v1/user/cancel/${orderId}`);
  return res.data;
}

/**
 * Converts a 5sim USD cost into the Naira price we charge the user —
 * USD→NGN at the hand-set rate, then markup, then the flat minimum margin
 * floor (see config.js comments for why the floor exists). Shared by
 * numbers-prices.js (what the picker shows) and buy-number.js (what's
 * actually charged) so the two can never drift apart.
 */
function sellPriceNgn(usdCost, overrides) {
  const { FIVESIM_USD_TO_NGN, FIVESIM_MARKUP, FIVESIM_MIN_MARGIN_NGN } = require("./config");
  const usdToNgn = overrides?.usdToNgn ?? FIVESIM_USD_TO_NGN;
  const markup = overrides?.markup ?? FIVESIM_MARKUP;
  const minMarginNgn = overrides?.minMarginNgn ?? FIVESIM_MIN_MARGIN_NGN;
  const costNgn = usdCost * usdToNgn;
  const markedUp = costNgn * (1 + markup);
  const floor = costNgn + minMarginNgn;
  return Math.round(Math.max(markedUp, floor));
}

/**
 * Every product 5sim has for activation, across all countries/operators
 * by default (guest endpoint — country/operator "any" gives the broadest
 * catalog). Used by numbers-search-products.js so users can find a
 * service outside the curated FIVESIM_PRODUCTS list in config.js, and by
 * hosting-prices.js (with a real country) to discover which duration
 * slugs are ACTUALLY valid/available for that country before ever
 * querying guest/prices with one — querying guest/prices with a duration
 * string 5sim doesn't recognize for that country is what was producing
 * "400 product is incorrect" for Long-Term Numbers.
 */
async function getProducts(apiKey, { country = "any", operator = "any" } = {}) {
  const api = client(apiKey);
  const res = await api.get(`/v1/guest/products/${country}/${operator}`);
  return res.data; // { [productSlug]: { Category: "activation"|"hosting", Qty, Price } }
}

/**
 * Buy a hosting (long-term) number — same shape as activation, but the
 * "product" here is a DURATION slug (e.g. "3hours", "1day", "10days",
 * "1month"), not a service name. A hosting number stays assigned to the
 * user for that whole period and can receive SMS from any sender, not
 * just one service — see getInbox() below for reading everything it's
 * received, and note hosting orders CANNOT be cancelled (5sim's own
 * cancel/ban endpoints explicitly reject with "hosting order").
 */
async function buyHosting(apiKey, { country, product, operator = "any" }) {
  const api = client(apiKey);
  const res = await api.get(`/v1/user/buy/hosting/${country}/${operator}/${product}`);
  if (!res.data || !res.data.id) {
    throw new Error(`5sim hosting buy failed: ${JSON.stringify(res.data)}`);
  }
  return res.data; // { id, phone, product, price, status, expires, sms: [], created_at, country }
}

/**
 * Full accumulated SMS inbox for a hosting number — /user/check/$id only
 * ever shows the latest snapshot, but a hosting number can receive many
 * messages from many senders over its rental period, so this dedicated
 * endpoint (rented numbers only, per 5sim's docs) is what actually lists
 * everything it's gotten.
 */
async function getInbox(apiKey, orderId) {
  const api = client(apiKey);
  const res = await api.get(`/v1/user/sms/inbox/${orderId}`);
  return res.data;
}

/**
 * 5sim's field casing isn't fully consistent across endpoints (confirmed
 * on the hosting inbox endpoint returning "Data" instead of "sms") — this
 * tries every casing seen so far rather than assuming one, since assuming
 * wrong silently drops every code that ever arrives.
 */
function extractSms(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const val = raw.sms ?? raw.Sms ?? raw.SMS ?? raw.Data ?? raw.data;
  if (Array.isArray(val)) return val;
  return [];
}

module.exports = { getPrices, getProducts, buyActivation, buyHosting, checkOrder, getInbox, finishOrder, cancelOrder, sellPriceNgn, extractSms };
