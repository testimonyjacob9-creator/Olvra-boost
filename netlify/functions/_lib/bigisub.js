// _lib/bigisub.js
// Thin wrapper around the BigiSub Marketing Hub API.
// The API token is read from Netlify env vars — never hardcode it.

const axios = require("axios");
const { BIGISUB_BASE_URL } = require("./config");

function client(token) {
  return axios.create({
    baseURL: BIGISUB_BASE_URL,
    headers: { Authorization: `Token ${token}` },
    timeout: 15000,
  });
}

/**
 * Fetch one page of services from BigiSub, optionally filtered by platform.
 */
async function fetchServicesPage(token, { platform, page = 1, pageSize = 100 } = {}) {
  const api = client(token);
  const params = { page, page_size: pageSize };
  if (platform) params.platform = platform;

  const res = await api.get("/api/v2/marketinghub/services/", { params });
  // Unlike platforms/countries/order endpoints, /services/ returns the
  // paginated payload unwrapped — { count, next, previous, results }
  // directly on res.data, with no { success, data: {...} } envelope
  // (confirmed against a live response 2026-08-28, which had no `success`
  // key at all — the old check on res.data.success rejected every page).
  if (!res.data || !Array.isArray(res.data.results)) {
    throw new Error(`BigiSub services fetch failed: ${JSON.stringify(res.data)}`);
  }
  return res.data; // { count, next, previous, results }
}

/**
 * Fetch ALL services for a platform, paging through until `next` is null.
 */
async function fetchAllServicesForPlatform(token, platform, pageSize = 100) {
  let page = 1;
  let all = [];
  while (true) {
    const data = await fetchServicesPage(token, { platform, page, pageSize });
    all = all.concat(data.results || []);
    if (!data.next || (data.results || []).length === 0) break;
    page += 1;
  }
  return all;
}

/**
 * Place an order with BigiSub. `body` shape depends on service variant —
 * caller is responsible for building the right payload.
 */
async function createOrder(token, body) {
  const api = client(token);
  const res = await api.post("/api/v2/marketinghub/order/create/", body);
  if (!res.data?.success) {
    throw new Error(`BigiSub order create failed: ${JSON.stringify(res.data)}`);
  }
  return res.data.data.order;
}

async function getOrderStatus(token, orderId) {
  const api = client(token);
  const res = await api.get("/api/v2/marketinghub/order/status/", {
    params: { order_id: orderId },
  });
  if (!res.data?.success) {
    throw new Error(`BigiSub order status fetch failed: ${JSON.stringify(res.data)}`);
  }
  return res.data.data.order;
}

module.exports = {
  fetchServicesPage,
  fetchAllServicesForPlatform,
  createOrder,
  getOrderStatus,
};
