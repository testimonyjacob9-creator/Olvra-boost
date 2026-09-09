// _lib/wallet-ledger.js
//
// Single ledger for every wallet_balance change, across every code path
// that touches it. Before this, only funding-style credits were ever
// recorded anywhere (in wallet_topups, written by flutterwave-webhook.js
// / verify-onetime-payment.js / admin-actions.js) — a DEBIT from placing
// an order left no trace at all beyond the order doc itself. If a user
// disputed "why did my balance drop", there was nothing to check it
// against except manually re-deriving it from their order history.
//
// This collection is additive-only and never read back to compute a
// balance — users.wallet_balance stays the one source of truth — so it's
// safe to introduce without touching any existing balance-mutation logic.
// It logs BOTH debits and credits (signed `amount`), so it's a complete
// audit trail even though wallet_topups also separately logs credits for
// its own (funding-focused) admin UI.

const { db, FieldValue } = require("./firebase-admin");

/**
 * Call from INSIDE a Firestore transaction (uses tx.set, no await needed
 * by the caller beyond the transaction's own commit).
 */
function logWalletTxn(tx, { uid, type, amount, balance_after, note, ref_id }) {
  const ref = db.collection("wallet_transactions").doc();
  tx.set(ref, {
    uid,
    type, // "order_charge" | "order_refund" | "admin_adjustment" | "topup"
    amount, // signed: negative = debit, positive = credit
    balance_after: balance_after ?? null,
    note: note || null,
    ref_id: ref_id || null,
    created_at: FieldValue.serverTimestamp(),
  });
}

/**
 * Call OUTSIDE a transaction (standalone write, e.g. after a refund that
 * already happened via FieldValue.increment). Best-effort — callers
 * should wrap in try/catch same as any other non-critical write, since a
 * ledger-write failure should never block the user-facing balance change
 * that already succeeded.
 */
async function logWalletTxAsync({ uid, type, amount, balance_after, note, ref_id }) {
  await db.collection("wallet_transactions").add({
    uid,
    type,
    amount,
    balance_after: balance_after ?? null,
    note: note || null,
    ref_id: ref_id || null,
    created_at: FieldValue.serverTimestamp(),
  });
}

module.exports = { logWalletTxn, logWalletTxAsync };
