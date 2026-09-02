// netlify/functions/debug-owlet-test.js
//
// TEMPORARY DIAGNOSTIC ENDPOINT — visit directly in your browser:
//   https://olvraboost.netlify.app/.netlify/functions/debug-owlet-test
//
// Calls Owlet's API server-to-server (so CORS never applies — that only
// restricts browser JS calling a different origin, not this Netlify
// Function calling out to Owlet itself) and returns the raw response so
// we can see the real field names before building the actual integration.
//
// DELETE THIS FILE once we've confirmed the response shape — it has a
// live API key in it, which doesn't belong in a shipped app.

const axios = require("axios");

const OWLET_URL = "https://olvrahub.mysocials.store/api/store-v2";
const OWLET_KEY = "msk_Wk2au2Tdvn34cJccHhCZs-f8RZAAaqlW";

async function call(action, extra = {}) {
  try {
    const res = await axios.post(OWLET_URL, { key: OWLET_KEY, action, ...extra }, { timeout: 15000 });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return {
      ok: false,
      status: err.response?.status || null,
      error: err.message,
      data: err.response?.data || null,
    };
  }
}

exports.handler = async () => {
  const balance = await call("balance");
  const services = await call("services");

  // Services lists can be huge — trim to the first 3 so the response is
  // actually readable, but note the true count.
  let servicesTrimmed = services;
  let cheapestServiceId = null;
  if (services.ok && Array.isArray(services.data)) {
    servicesTrimmed = {
      ...services,
      data: services.data.slice(0, 3),
      total_count: services.data.length,
    };
    if (services.data.length) cheapestServiceId = services.data[0].service;
  } else if (services.ok && services.data?.data && Array.isArray(services.data.data)) {
    servicesTrimmed = {
      ...services,
      data: { ...services.data, data: services.data.data.slice(0, 3) },
      total_count: services.data.data.length,
    };
    if (services.data.data.length) cheapestServiceId = services.data.data[0].service;
  }

  // Safe to test — balance is ₦0, so this should fail with an
  // insufficient-funds-style error rather than actually placing an order.
  // Still tells us the error response's field names.
  const addAttempt = cheapestServiceId
    ? await call("add", { service: cheapestServiceId, link: "https://instagram.com/test", quantity: 100 })
    : { ok: false, error: "No service id available to test with" };

  // No real order exists yet, so this should also come back as an error —
  // but the error shape itself is useful (matches BigiSub's res.data.success pattern or not).
  const statusAttempt = await call("status", { order: "0" });

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ balance, services: servicesTrimmed, addAttempt, statusAttempt }, null, 2),
  };
};
