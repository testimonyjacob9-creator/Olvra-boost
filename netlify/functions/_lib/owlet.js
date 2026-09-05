// _lib/owlet.js
// Thin wrapper around the Owlet-family action-based API (single endpoint
// per account, every call is POST { key, action, ...params }). "Owlet-
// family" because there are now MULTIPLE accounts on this same platform
// pooled together as one "Global Source" the user sees (Testimony's call,
// 2026-09-03 — see OWLET_SOURCES in config.js) — each with its own
// endpoint + key + wallet balance, so every function here takes baseUrl
// explicitly rather than assuming a single hardcoded one.
//
// Confirmed live against the real API 2026-09-02:
//   - balance  -> { balance: "0.00", currency: "NGN" }
//   - services -> bare array, e.g. { service, name, category, type,
//                 rate, min, max, refill, cancel, currency }
//   - errors   -> non-2xx HTTP status + { error: "<message>" }
//
// NOT yet confirmed: the SUCCESS shape of "add" (place order) or "status"
// (check order) — the account used to test this only ever had a ₦0
// balance, so every real attempt failed before reaching a success
// response. createOrder()/getOrderStatus() below try the field names
// Owlet's own docs imply (their esim_buy example returns a top-level
// `order` field) with a couple of sensible fallbacks, and always keep the
// full raw response on the order record — so if a guess is wrong,
// nothing is silently lost; it's visible in Firestore for manual
// reconciliation and an easy fix once a real successful order is seen.

const axios = require("axios");

async function call(baseUrl, key, action, extra = {}) {
  const res = await axios.post(baseUrl, { key, action, ...extra }, { timeout: 20000 });
  return res.data;
}

function unwrapError(err) {
  const msg = err.response?.data?.error || err.message || "Owlet request failed.";
  return Object.assign(new Error(msg), { statusCode: err.response?.status || 500 });
}

/**
 * Fetch the full services list for ONE Owlet-family account. Confirmed to
 * return everything in ONE call (no pagination params in their docs) —
 * as of 2026-09-03 that's ~6,800-14,600 services depending on the
 * account, so callers should filter down (by platform) before doing
 * anything expensive with the result.
 */
async function fetchAllServices(baseUrl, key) {
  try {
    const data = await call(baseUrl, key, "services");
    return Array.isArray(data) ? data : (data?.data || []);
  } catch (err) {
    throw unwrapError(err);
  }
}

async function getBalance(baseUrl, key) {
  try {
    const data = await call(baseUrl, key, "balance");
    return parseFloat(data.balance || 0);
  } catch (err) {
    throw unwrapError(err);
  }
}

/**
 * Places an order. Returns { orderId, status, raw } — orderId/status are
 * best-effort field-name guesses (see file header); `raw` is the full
 * response, always, so nothing is lost if the guess is wrong.
 */
async function createOrder(baseUrl, key, { service, link, quantity }) {
  try {
    const data = await call(baseUrl, key, "add", { service, link, quantity });
    const orderId = data.order ?? data.order_id ?? data.id ?? null;
    const status = data.status ?? data.order_status ?? "processing";
    return { orderId, status, raw: data };
  } catch (err) {
    throw unwrapError(err);
  }
}

/**
 * Checks an order's status. Returns { status, raw } — same caveat as
 * createOrder() on the exact field name.
 */
async function getOrderStatus(baseUrl, key, orderId) {
  try {
    const data = await call(baseUrl, key, "status", { order: orderId });
    const status = data.status ?? data.order_status ?? null;
    return { status, raw: data };
  } catch (err) {
    throw unwrapError(err);
  }
}

module.exports = { fetchAllServices, getBalance, createOrder, getOrderStatus };
