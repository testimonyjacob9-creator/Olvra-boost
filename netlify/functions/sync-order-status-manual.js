// netlify/functions/sync-order-status-manual.js
// Same sync as sync-order-status.js, but callable on-demand by visiting
// its URL with a secret — same reasoning and same secret as
// sync-services-manual.js (reuses SYNC_TRIGGER_SECRET, no new env var
// needed).
//
// Usage: visit
//   https://<your-site>.netlify.app/.netlify/functions/sync-order-status-manual?secret=YOUR_SECRET
// Optionally add &limit=50 to check more than the default 25 orders in
// one run (useful the first time, if a backlog built up while this
// didn't exist yet).

const { runOrderStatusSync } = require("./_lib/order-status-sync-core");

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const providedSecret = params.secret;
  const expectedSecret = process.env.SYNC_TRIGGER_SECRET;

  if (!expectedSecret) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "SYNC_TRIGGER_SECRET is not set in Netlify env vars." }),
    };
  }
  if (!providedSecret || providedSecret !== expectedSecret) {
    return { statusCode: 403, body: JSON.stringify({ error: "Invalid or missing secret." }) };
  }

  const limit = params.limit ? parseInt(params.limit, 10) : 25;

  try {
    const result = await runOrderStatusSync({ limit });
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, ...result }),
    };
  } catch (err) {
    console.error("Manual order status sync failed:", err.message);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
