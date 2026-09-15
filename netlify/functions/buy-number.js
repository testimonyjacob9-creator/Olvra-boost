// netlify/functions/buy-number.js
// HTTP FUNCTION — called from the app with:
//   POST /.netlify/functions/buy-number
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body: { country, product, operator? }   (operator optional — defaults to cheapest available)
//
// Unlike place-order.js, there's no pre-synced Firestore price to trust —
// 5sim's prices/availability move live, so this fetches the current price
// itself, deducts the wallet for THAT quoted price, then buys using the
// exact same operator it just quoted. If 5sim's actual charge differs
// slightly from the quote by the time the buy call lands, that drift only
// eats into margin — the user is never charged more than what they were
// quoted, same risk tolerance place-order.js already accepts for BigiSub
// price staleness.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const fivesim = require("./_lib/fivesim");
const { FIVESIM_COUNTRIES, FIVESIM_PRODUCTS, FIVESIM_API_KEY } = require("./_lib/config");
const { getRentNumberPricing } = require("./_lib/rent-number-pricing");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    const uid = decoded.uid;

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 });
    }

    const { country, product, operator: requestedOperator } = body;
    if (!country || !product) {
      throw Object.assign(new Error("country and product are required."), { statusCode: 400 });
    }
    if (!FIVESIM_COUNTRIES.some((c) => c.country === country)) {
      throw Object.assign(new Error("Unsupported country."), { statusCode: 400 });
    }
    // No FIVESIM_PRODUCTS check here on purpose — Rent Number now also
    // accepts any product found via numbers-search-products.js (5sim's
    // full 700+ catalog), not just the curated grid. An invalid/unknown
    // product slug naturally falls through to the "no numbers available"
    // error a few lines down, since getPrices() would return nothing for it.

    const apiKey = FIVESIM_API_KEY;
    if (!apiKey) {
      throw Object.assign(new Error("Number rental isn't configured yet."), { statusCode: 503 });
    }

    // Quote a live price for a SPECIFIC operator (never "any") so the price
    // we deduct is the price we then buy at.
    const raw = await fivesim.getPrices(apiKey, { country, product });
    const byOperator = raw?.[country]?.[product] || {};
    let operator = requestedOperator;
    let costUsd;
    if (operator) {
      const info = byOperator[operator];
      if (!info || !info.count) {
        throw Object.assign(new Error("That operator has no numbers available right now."), { statusCode: 409 });
      }
      costUsd = info.cost;
    } else {
      const cheapest = Object.entries(byOperator)
        .filter(([, info]) => info.count > 0)
        .sort((a, b) => a[1].cost - b[1].cost)[0];
      if (!cheapest) {
        throw Object.assign(new Error("No numbers currently available for this country/service — try another."), { statusCode: 409 });
      }
      operator = cheapest[0];
      costUsd = cheapest[1].cost;
    }

    const pricing = await getRentNumberPricing();
    const sellPriceNgn = fivesim.sellPriceNgn(costUsd, pricing);
    const userRef = db.collection("users").doc(uid);

    // Same wallet-then-olives spend + ledger pattern as place-order.js.
    const { olivesUsed } = await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw Object.assign(new Error("User wallet not found."), { statusCode: 404 });
      }
      const wallet = userSnap.data().wallet_balance || 0;
      const olives = userSnap.data().olive_balance || 0;
      const oliveValue = round2(olives * 2);

      if (wallet + oliveValue < sellPriceNgn) {
        throw Object.assign(new Error("Insufficient wallet balance."), { statusCode: 402 });
      }

      const walletUsed = Math.min(wallet, sellPriceNgn);
      const remainder = round2(sellPriceNgn - walletUsed);
      let olivesUsed = 0;
      let changeToWallet = 0;
      if (remainder > 0) {
        olivesUsed = Math.ceil(remainder / 2);
        changeToWallet = round2(olivesUsed * 2 - remainder);
      }

      const walletDelta = changeToWallet - walletUsed;
      tx.update(userRef, {
        wallet_balance: FieldValue.increment(walletDelta),
        ...(olivesUsed > 0 ? { olive_balance: FieldValue.increment(-olivesUsed) } : {}),
        last_activity_at: FieldValue.serverTimestamp(),
      });
      tx.set(db.collection("wallet_transactions").doc(), {
        uid,
        type: "number_rental_charge",
        amount: walletDelta,
        balance_after: round2(wallet + walletDelta),
        note: `Rent Number — ${product} (${country}/${operator})${olivesUsed > 0 ? ` (+${olivesUsed} olives)` : ""}`,
        created_at: FieldValue.serverTimestamp(),
      });

      return { olivesUsed };
    });

    // Wallet already deducted. Now actually buy the number.
    let purchase;
    try {
      purchase = await fivesim.buyActivation(apiKey, { country, product, operator });
    } catch (err) {
      // Buy failed after deduction — refund immediately, same shape as
      // place-order.js's provider-failure refund path.
      const refundAmount = sellPriceNgn - (olivesUsed > 0 ? olivesUsed * 2 : 0);
      await userRef.update({
        wallet_balance: FieldValue.increment(refundAmount),
        ...(olivesUsed > 0 ? { olive_balance: FieldValue.increment(olivesUsed) } : {}),
      });
      const providerReason = err.response?.data?.message || err.message || "unknown error";
      console.error("5sim buy failed, wallet refunded:", providerReason, "| country/product/operator:", country, product, operator);

      await db.collection("wallet_topups").add({
        uid,
        type: "order_refund_auto",
        gross_amount: refundAmount,
        fee: 0,
        net_credit: refundAmount,
        status: "credited",
        note: `Auto-refund: number rental failed with provider (${providerReason})`,
        credited_at: FieldValue.serverTimestamp(),
      }).catch(() => {});

      try {
        await db.collection("users").doc(uid).collection("notifications").add({
          type: "number_failed",
          title: "Number rental failed — refunded",
          body: `Couldn't get a ${product} number (${providerReason}). ₦${refundAmount.toLocaleString()} was refunded to your wallet.`,
          read: false,
          created_at: FieldValue.serverTimestamp(),
        });
      } catch {}

      throw Object.assign(new Error("Couldn't get a number right now. Your wallet has been refunded."), { statusCode: 502 });
    }

    const orderRef = await db.collection("number_orders").add({
      uid,
      country,
      product,
      operator,
      phone: purchase.phone,
      fivesim_order_id: purchase.id,
      status: purchase.status || "PENDING",
      sms: purchase.sms || [],
      cost_usd: costUsd,
      price_ngn: sellPriceNgn,
      ...(olivesUsed > 0 ? { olives_used: olivesUsed } : {}),
      expires_at: purchase.expires || null,
      created_at: FieldValue.serverTimestamp(),
    });

    try {
      await db.collection("users").doc(uid).collection("notifications").add({
        type: "number_rented",
        title: "Number ready",
        body: `${purchase.phone} — waiting for your ${product} code.`,
        order_id: orderRef.id,
        read: false,
        created_at: FieldValue.serverTimestamp(),
      });
    } catch {}

    return ok({
      orderId: orderRef.id,
      phone: purchase.phone,
      status: purchase.status || "PENDING",
      expires: purchase.expires || null,
      priceCharged: sellPriceNgn,
    });
  } catch (err) {
    return fail(err);
  }
};

function round2(n) {
  return Math.round(n * 100) / 100;
}
