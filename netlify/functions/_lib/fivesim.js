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
function sellPriceNgn(usdCost) {
  const { FIVESIM_USD_TO_NGN, FIVESIM_MARKUP, FIVESIM_MIN_MARGIN_NGN } = require("./config");
  const costNgn = usdCost * FIVESIM_USD_TO_NGN;
  const markedUp = costNgn * (1 + FIVESIM_MARKUP);
  const floor = costNgn + FIVESIM_MIN_MARGIN_NGN;
  return Math.round(Math.max(markedUp, floor));
}

module.exports = { getPrices, buyActivation, checkOrder, finishOrder, cancelOrder, sellPriceNgn };
