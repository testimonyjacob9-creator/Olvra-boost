// netlify/functions/sync-order-status.js
// SCHEDULED FUNCTION — checks BigiSub's live status for orders that are
// still in-flight (not completed/failed/cancelled/refunded/partial yet)
// and writes back whatever BigiSub reports, refunding the user's wallet
// automatically if BigiSub says the order failed/was cancelled/refunded.
// Runs every 10 minutes (see schedule in netlify.toml). Same pattern as
// sync-services.js — see _lib/order-status-sync-core.js for the logic.
//
// Same note as sync-services.js: this does NOT run immediately after a
// deploy, only at its next cron tick. Use sync-order-status-manual.js to
// force an immediate run.

const { runOrderStatusSync } = require("./_lib/order-status-sync-core");

exports.handler = async () => {
  try {
    const result = await runOrderStatusSync({ limit: 25 });
    console.log(
      `Order status sync complete. Checked ${result.checked}, updated ${result.updated}, refunded ${result.refunded}.`
    );
    if (result.errors.length) {
      console.error("Order status sync errors:", JSON.stringify(result.errors));
    }
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error("Order status sync failed:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
