// netlify/functions/buy-hosting.js
// POST /.netlify/functions/buy-hosting
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body: { country, product, operator? }   (product = duration slug, e.g. "10days")
//
// Same charge-then-buy-then-refund-on-failure shape as buy-number.js.
// Writes to hosting_orders (separate collection from number_orders) since
// hosting numbers behave differently downstream — no cancel/refund path
// (5sim rejects cancelling a hosting order outright), and polling reads
// the full accumulated inbox instead of a single latest-SMS snapshot.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const fivesim = require("./_lib/fivesim");
const { FIVESIM_COUNTRIES, FIVESIM_API_KEY } = require("./_lib/config");
const { getRentNumberPricing } = require("./_lib/rent-number-pricing");
const { requirePinIfSet } = require("./_lib/pin");

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

    const { country, product, operator: requestedOperator, pin } = body;
    if (!country || !product) {
      throw Object.assign(new Error("country and product (duration) are required."), { statusCode: 400 });
    }
    if (!FIVESIM_COUNTRIES.some((c) => c.country === country)) {
      throw Object.assign(new Error("Unsupported country."), { statusCode: 400 });
    }

    const apiKey = FIVESIM_API_KEY;
    if (!apiKey) {
      throw Object.assign(new Error("Number rental isn't configured yet."), { statusCode: 503 });
    }

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
        throw Object.assign(new Error("No numbers currently available for this country/duration — try another."), { statusCode: 409 });
      }
      operator = cheapest[0];
      costUsd = cheapest[1].cost;
    }

    const pricing = await getRentNumberPricing();
    const sellPriceNgn = fivesim.sellPriceNgn(costUsd, pricing);
    const userRef = db.collection("users").doc(uid);

    const { olivesUsed } = await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw Object.assign(new Error("User wallet not found."), { statusCode: 404 });
      }
      requirePinIfSet(userSnap.data(), pin);
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
        type: "hosting_number_charge",
        amount: walletDelta,
        balance_after: round2(wallet + walletDelta),
        note: `Long-Term Number — ${product} (${country}/${operator})${olivesUsed > 0 ? ` (+${olivesUsed} olives)` : ""}`,
        created_at: FieldValue.serverTimestamp(),
      });

      return { olivesUsed };
    });

    let purchase;
    try {
      purchase = await fivesim.buyHosting(apiKey, { country, product, operator });
    } catch (err) {
      const refundAmount = sellPriceNgn - (olivesUsed > 0 ? olivesUsed * 2 : 0);
      await userRef.update({
        wallet_balance: FieldValue.increment(refundAmount),
        ...(olivesUsed > 0 ? { olive_balance: FieldValue.increment(olivesUsed) } : {}),
      });
      const providerReason = err.response?.data?.message || err.message || "unknown error";
      console.error("5sim hosting buy failed, wallet refunded:", providerReason, "| country/duration/operator:", country, product, operator);

      await db.collection("wallet_topups").add({
        uid,
        type: "order_refund_auto",
        gross_amount: refundAmount,
        fee: 0,
        net_credit: refundAmount,
        status: "credited",
        note: `Auto-refund: long-term number failed with provider (${providerReason})`,
        credited_at: FieldValue.serverTimestamp(),
      }).catch(() => {});

      try {
        await db.collection("users").doc(uid).collection("notifications").add({
          type: "hosting_failed",
          title: "Long-term number failed — refunded",
          body: `Couldn't get a ${product} number (${providerReason}). ₦${refundAmount.toLocaleString()} was refunded to your wallet.`,
          read: false,
          created_at: FieldValue.serverTimestamp(),
        });
      } catch {}

      throw Object.assign(new Error("Couldn't get a number right now. Your wallet has been refunded."), { statusCode: 502 });
    }

    const orderRef = await db.collection("hosting_orders").add({
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
        type: "hosting_rented",
        title: "Long-term number ready",
        body: `${purchase.phone} is yours for ${product} — it can receive SMS from anywhere during that time.`,
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
