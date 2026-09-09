// netlify/functions/place-order.js
// HTTP FUNCTION — called from the app with:
//   POST /.netlify/functions/place-order
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body: { serviceId, quantity, link?, username?, ...variant extra fields }
//
// Re-validates price server-side (never trusts a client-sent amount),
// deducts wallet atomically, then calls BigiSub.
//
// Handoff doc gap #1: order-fields.js on the client now collects the extra
// fields BigiSub's non-Default variants need (custom_text, hashtag, media,
// groups, country/device/type_of_traffic/google_keyword, old_posts/posts/
// delay). This function forwards whichever of those keys are present —
// whitelisted below — rather than trusting/forwarding the entire body.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const bigisub = require("./_lib/bigisub");
const { sendEmail, orderConfirmationEmail } = require("./_lib/brevo");
const { logWalletTxn, logWalletTxAsync } = require("./_lib/wallet-ledger");

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

    const { serviceId, link, quantity, username } = body;

    // Extra fields required by BigiSub's non-Default order-create variants
    // (see handoff doc gap #1). Only whitelisted keys are ever forwarded —
    // never the raw client body — so this can't become an arbitrary
    // passthrough to BigiSub.
    const EXTRA_FIELD_KEYS = [
      "custom_text", "hashtag", "media", "groups",
      "country", "device", "type_of_traffic", "google_keyword",
      "old_posts", "posts", "delay",
    ];
    const extraFields = {};
    for (const key of EXTRA_FIELD_KEYS) {
      if (body[key] !== undefined && body[key] !== null && body[key] !== "") {
        extraFields[key] = body[key];
      }
    }

    if (!serviceId || !quantity) {
      throw Object.assign(new Error("serviceId and quantity are required."), { statusCode: 400 });
    }
    // Catch oversized links (long tracking query strings on IG/FB links are
    // the usual culprit) before we touch the wallet at all — BigiSub's own
    // 500-char limit was previously only discovered after a deduct+refund
    // round trip, which is a bad user experience for a purely client-fixable
    // problem.
    if (link && String(link).length > 500) {
      throw Object.assign(
        new Error("That link is too long (max 500 characters). Try a shorter/cleaner version of the URL."),
        { statusCode: 400 }
      );
    }

    const serviceRef = db.collection("services").doc(String(serviceId));
    const userRef = db.collection("users").doc(uid);

    // Read service + user, validate, deduct wallet — all inside one transaction
    // so two simultaneous orders can't double-spend the same balance.
    const { totalCost, service, olivesUsed } = await db.runTransaction(async (tx) => {
      const serviceSnap = await tx.get(serviceRef);
      if (!serviceSnap.exists) {
        throw Object.assign(new Error("Service not found."), { statusCode: 404 });
      }
      const svc = serviceSnap.data();

      if (!svc.is_active) {
        throw Object.assign(new Error("This service is currently unavailable."), { statusCode: 409 });
      }
      if (quantity < svc.min_quantity || quantity > svc.max_quantity) {
        throw Object.assign(
          new Error(`Quantity must be between ${svc.min_quantity} and ${svc.max_quantity}.`),
          { statusCode: 400 }
        );
      }

      const totalCost = round2(svc.sell_price * quantity);

      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw Object.assign(new Error("User wallet not found."), { statusCode: 404 });
      }
      const wallet = userSnap.data().wallet_balance || 0;
      const olives = userSnap.data().olive_balance || 0;
      const oliveValue = round2(olives * 2); // 1 Olive = ₦2, referral-earned, not withdrawable

      if (wallet + oliveValue < totalCost) {
        throw Object.assign(new Error("Insufficient wallet balance."), { statusCode: 402 });
      }

      // Spend wallet first, then Olives for whatever's left. Olives only
      // come in whole units (₦2 each), so if the remainder isn't an exact
      // multiple of 2 we round UP the Olives spent and credit the few kobo
      // of overshoot straight back to the wallet as change — the user is
      // never short-changed by the rounding.
      const walletUsed = Math.min(wallet, totalCost);
      const remainder = round2(totalCost - walletUsed);
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
        last_activity_at: FieldValue.serverTimestamp(), // used by reengage-users.js to find inactive users
      });
      logWalletTxn(tx, {
        uid,
        type: "order_charge",
        amount: walletDelta, // usually negative; can be slightly positive only from olive-rounding change
        balance_after: round2(wallet + walletDelta),
        note: `${quantity} × ${svc.name}${olivesUsed > 0 ? ` (+${olivesUsed} olives)` : ""}`,
      });

      return { totalCost, service: svc, olivesUsed };
    });

    // Wallet already deducted at this point. Now call BigiSub.
    // BigiSub's own /services/ listing endpoint uses `id` as the service
    // identifier field, not `service_id` (see sync-services-core.js).
    // We used to send BOTH `service_id` and `service` on the theory that
    // "APIs ignore fields they don't recognize" — but BigiSub actively
    // VALIDATES `service_id` and was rejecting real, valid services with
    // "Service not found or not available" (2026-09-09 incident: confirmed
    // in function logs). Its order-create endpoint only wants `service`.
    const orderBody = {
      service: service.service_id,
      quantity: Number(quantity),
      ...extraFields,
    };
    if (link) orderBody.link = link;
    if (username) orderBody.username = username;
    let providerOrderId, providerTranId, providerStatus;
    try {
      const bigisubOrder = await bigisub.createOrder(process.env.BIGISUB_TOKEN, orderBody);
      providerOrderId = bigisubOrder.id;
      providerTranId = bigisubOrder.tran_id;
      providerStatus = bigisubOrder.status;
    } catch (err) {
      // BigiSub call failed AFTER wallet/Olives were deducted — refund both immediately.
      const refundAmount = totalCost - (olivesUsed > 0 ? olivesUsed * 2 : 0);
      await userRef.update({
        wallet_balance: FieldValue.increment(refundAmount),
        ...(olivesUsed > 0 ? { olive_balance: FieldValue.increment(olivesUsed) } : {}),
      });
      // err.message alone (e.g. "Request failed with status code 400")
      // never shows WHY the provider rejected it — that's in the response
      // BODY, which axios doesn't include in .message. Logging it
      // explicitly here (2026-09-07) after a stretch of orders failing
      // with no diagnosable reason in the logs.
      const providerReason = extractProviderReason(err);
      console.error(
        "BigiSub order failed, wallet refunded:",
        err.message,
        "| service:", service.service_id,
        "| provider response:", JSON.stringify(err.response?.data || null),
        "| status:", err.response?.status || "n/a"
      );

      // Previously a failed order left NO trace anywhere — the wallet was
      // silently refunded and the only evidence was in Netlify's function
      // logs, invisible to both the user (order history) and admin (orders
      // tab). Record it as a real order doc with status "failed" so both
      // surfaces show it, same as a successful order would. Best-effort:
      // if this write itself fails, the refund above has already happened
      // and the user still gets the 502 error message below either way.
      let failedOrderRef;
      try {
        failedOrderRef = await db.collection("orders").add({
          uid,
          service_id: service.service_id,
          service_name: service.name,
          platform: service.platform,
          link: link || null,
          username: username || null,
          ...(Object.keys(extraFields).length ? { extra_fields: extraFields } : {}),
          quantity,
          unit_price: service.sell_price,
          total_amount: totalCost,
          ...(olivesUsed > 0 ? { olives_used: olivesUsed } : {}),
          status: "failed",
          fail_reason: providerReason,
          refunded: true,
          created_at: FieldValue.serverTimestamp(),
        });
      } catch (writeErr) {
        console.error("Failed-order record write failed:", writeErr.message);
      }

      // Ledger entries for the refund — same wallet_topups convention the
      // admin manual-refund flow already uses (so it shows up in the
      // admin Top-ups tab too), plus the full-audit wallet_transactions
      // ledger used by order charges.
      try {
        await db.collection("wallet_topups").add({
          uid,
          type: "order_refund_auto",
          gross_amount: refundAmount,
          fee: 0,
          net_credit: refundAmount,
          status: "credited",
          note: `Auto-refund: order failed with provider (${providerReason})`,
          credited_at: FieldValue.serverTimestamp(),
        });
        const freshBalance = (await userRef.get()).data()?.wallet_balance;
        await logWalletTxAsync({
          uid,
          type: "order_refund",
          amount: refundAmount,
          balance_after: typeof freshBalance === "number" ? round2(freshBalance) : null,
          note: `Refund for failed order (${providerReason})`,
          ref_id: failedOrderRef?.id || null,
        });
      } catch (ledgerErr) {
        console.error("Refund ledger write failed:", ledgerErr.message);
      }

      // Best-effort in-app notification, same as a successful order.
      try {
        await db.collection("users").doc(uid).collection("notifications").add({
          type: "order_failed",
          title: "Order failed — refunded",
          body: `${quantity} × ${service.name} couldn't be placed (${providerReason}). ₦${totalCost.toLocaleString()} was refunded to your wallet.`,
          read: false,
          created_at: FieldValue.serverTimestamp(),
        });
      } catch (notifErr) {
        console.error("Order-failed notification write failed:", notifErr.message);
      }

      throw Object.assign(
        new Error("Order failed with provider. Your wallet has been refunded."),
        { statusCode: 502 }
      );
    }

    // Record the order in Firestore for the user's order history.
    const orderRef = await db.collection("orders").add({
      uid,
      service_id: service.service_id,
      service_name: service.name,
      platform: service.platform,
      link: link || null,
      username: username || null,
      ...(Object.keys(extraFields).length ? { extra_fields: extraFields } : {}),
      quantity,
      unit_price: service.sell_price,
      total_amount: totalCost,
      ...(olivesUsed > 0 ? { olives_used: olivesUsed } : {}),
      status: providerStatus || "processing",
      bigisub_order_id: providerOrderId,
      bigisub_tran_id: providerTranId,
      created_at: FieldValue.serverTimestamp(),
    });

    // Best-effort in-app notification — a failure here shouldn't fail the order.
    try {
      await db.collection("users").doc(uid).collection("notifications").add({
        type: "order_placed",
        title: "Order placed",
        body: `${quantity} × ${service.name} — ₦${totalCost.toLocaleString()}`,
        order_id: orderRef.id,
        read: false,
        created_at: FieldValue.serverTimestamp(),
      });
    } catch (notifErr) {
      console.error("Order notification write failed:", notifErr.message);
    }

    // Best-effort order confirmation email — a failure here shouldn't fail the order.
    try {
      if (decoded.email) {
        const { subject, html } = orderConfirmationEmail({
          serviceName: service.name,
          quantity,
          totalCharged: totalCost,
          orderId: orderRef.id,
        });
        await sendEmail({ to: decoded.email, subject, html });
      }
    } catch (emailErr) {
      console.error("Order confirmation email failed:", emailErr.message);
    }

    return ok({
      orderId: orderRef.id,
      trackingId: providerTranId || providerOrderId,
      status: providerStatus,
      totalCharged: totalCost,
    });
  } catch (err) {
    return fail(err);
  }
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Turns BigiSub's validation error shape ({"errors":{"link":["too long"]}})
// or its generic {"message":"..."} shape into one short, user-facing string
// instead of a raw JSON blob or axios's uninformative "status code 400".
function extractProviderReason(err) {
  const data = err.response?.data;
  if (data?.errors && typeof data.errors === "object") {
    const parts = Object.entries(data.errors).map(
      ([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(" ") : msgs}`
    );
    if (parts.length) return parts.join("; ");
  }
  if (data?.message) return data.message;
  return err.message || "unknown error";
}
