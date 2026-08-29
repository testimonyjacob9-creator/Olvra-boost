// netlify/functions/_lib/order-status-sync-core.js
// Polls BigiSub for the live status of orders that are still "in flight"
// (not yet completed/failed/cancelled/refunded in Firestore) and writes
// back whatever BigiSub reports. Uses bigisub.getOrderStatus() — that
// function already existed in _lib/bigisub.js but nothing ever called it,
// so orders only ever changed status when an admin manually edited them
// from admin.html. This is what was missing: BigiSub itself marks an
// order "completed" and this app never found out.
//
// Shared by the scheduled function (sync-order-status.js, runs on a
// timer) and the manual-trigger function (sync-order-status-manual.js,
// for testing / forcing an immediate check) — same reasoning as
// sync-services-core.js.

const { db, FieldValue } = require("./firebase-admin");
const bigisub = require("./bigisub");

// Once an order reaches one of these, we stop checking it — no more
// BigiSub calls or Firestore reads spent on it. "partial" counts as done
// (BigiSub delivered what it could and won't change further); the
// leftover-refund for a partial delivery is handled below, once, the
// first time we see it go partial — not on every subsequent poll.
const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "refunded", "partial"];

// How BigiSub's raw status strings map onto this app's own status field.
// Keys are lowercased before lookup. Anything not listed here passes
// through unchanged (stored as-is, treated as still in-flight) so an
// unexpected new BigiSub status value never gets silently miscategorized
// as done — it'll just keep getting polled and show up in logs.
const STATUS_MAP = {
  pending: "processing",
  processing: "processing",
  in_progress: "processing",
  inprogress: "processing",
  completed: "completed",
  complete: "completed",
  partial: "partial",
  canceled: "cancelled",
  cancelled: "cancelled",
  failed: "failed",
  error: "failed",
  refunded: "refunded",
};

function mapStatus(rawStatus) {
  if (!rawStatus) return null;
  const key = String(rawStatus).toLowerCase().trim();
  return STATUS_MAP[key] || key;
}

// Statuses that mean "the order didn't (fully) go through" and should
// trigger an automatic wallet refund, same bookkeeping as the admin's
// manual refund action in admin-actions.js (writes a wallet_topups
// record of type "order_refund" and credits the user's wallet_balance).
const REFUNDABLE_STATUSES = ["failed", "cancelled", "refunded"];

async function refundOrder(order, orderId, note) {
  if (!order.uid || !order.total_amount) return false;
  const userRef = db.collection("users").doc(order.uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return;
    const current = snap.data().wallet_balance || 0;
    tx.update(userRef, { wallet_balance: current + Number(order.total_amount) });
  });
  await db.collection("wallet_topups").add({
    uid: order.uid,
    type: "order_refund",
    gross_amount: order.total_amount,
    fee: 0,
    net_credit: order.total_amount,
    status: "credited",
    note,
    adjusted_by: "auto_sync",
    credited_at: FieldValue.serverTimestamp(),
  });
  return true;
}

/**
 * Checks up to `limit` in-flight orders against BigiSub and updates
 * Firestore for any whose status changed. Oldest-created first, so a
 * long-stuck order gets priority over one placed a minute ago. `limit`
 * bounds both the Firestore read (one query, at most `limit` docs) and
 * the number of BigiSub API calls made per run — keep this modest on a
 * frequent schedule so a traffic spike in orders can't itself become a
 * new quota/rate-limit problem.
 */
async function runOrderStatusSync({ limit = 25 } = {}) {
  const token = process.env.BIGISUB_TOKEN;
  if (!token) {
    throw new Error("BIGISUB_TOKEN env var is missing.");
  }

  const snap = await db
    .collection("orders")
    .where("status", "not-in", TERMINAL_STATUSES)
    .orderBy("status") // Firestore requires the first orderBy to match a not-in field
    .orderBy("created_at", "asc")
    .limit(limit)
    .get();

  let checked = 0;
  let updated = 0;
  let refunded = 0;
  const errors = [];

  for (const docSnap of snap.docs) {
    const order = docSnap.data();
    const orderId = docSnap.id;
    if (!order.bigisub_order_id) continue; // nothing to check against

    checked += 1;
    try {
      const live = await bigisub.getOrderStatus(token, order.bigisub_order_id);
      const mapped = mapStatus(live.status);
      if (!mapped || mapped === order.status) continue; // unchanged, nothing to write

      const patch = {
        status: mapped,
        bigisub_status_raw: live.status,
        status_synced_at: FieldValue.serverTimestamp(),
      };
      await docSnap.ref.update(patch);
      updated += 1;

      if (REFUNDABLE_STATUSES.includes(mapped) && !order.refunded_at_sync) {
        const didRefund = await refundOrder(order, orderId, `Auto-refund — BigiSub reported "${live.status}" for order ${orderId}`);
        if (didRefund) {
          await docSnap.ref.update({ refunded_at_sync: FieldValue.serverTimestamp() });
          refunded += 1;
        }
      }

      // Best-effort notification so the user isn't just staring at a
      // Firestore field that changed with no signal in the app.
      if (order.uid) {
        try {
          await db.collection("users").doc(order.uid).collection("notifications").add({
            type: "order_status_changed",
            title: mapped === "completed" ? "Order completed" : `Order ${mapped}`,
            body: `${order.service_name || "Your order"} is now ${mapped}.`,
            order_id: orderId,
            read: false,
            created_at: FieldValue.serverTimestamp(),
          });
        } catch (notifErr) {
          console.error(`Notification write failed for order ${orderId}:`, notifErr.message);
        }
      }
    } catch (err) {
      errors.push({ orderId, message: err.message });
      console.error(`Order status check failed for ${orderId}:`, err.message);
    }
  }

  return { checked, updated, refunded, errors };
}

module.exports = { runOrderStatusSync, mapStatus, TERMINAL_STATUSES };
