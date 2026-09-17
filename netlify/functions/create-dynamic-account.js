// netlify/functions/create-dynamic-account.js
//
// Creates a ONE-TIME Flutterwave v3 dynamic virtual account (Zenith Bank)
// for a single wallet-funding request — different from
// create-permanent-account.js's reusable static account. Same v3 API
// WoodPayVTU uses for this (after real NIBSS-registration failures on v4
// there — v3's virtual-account-numbers product doesn't have that gap).
//
// Unlike a static account's reused reference, this reference is unique
// per request, so the webhook can match it directly by document ID — see
// the dynamic_fundings lookup added to flutterwave-webhook.js.
//
// Body: { amount }
// Returns: { orderId... } no wait: { reference, accountNumber, bankName, amount, note }

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");

const FLW_V3_BASE = "https://api.flutterwave.com/v3";
const ISSUING_BANK_CODE = "057"; // Zenith Bank — must match create-permanent-account.js

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    const uid = decoded.uid;

    let body;
    try { body = JSON.parse(event.body || "{}"); } catch {
      throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 });
    }
    const amount = Number(body.amount || 0);
    if (!amount || amount < 100) {
      throw Object.assign(new Error("Minimum funding amount is ₦100."), { statusCode: 400 });
    }

    const secretKey = process.env.FLW_SECRET_KEY;
    if (!secretKey) {
      throw Object.assign(new Error("Bank transfer funding isn't configured yet."), { statusCode: 503 });
    }

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) throw Object.assign(new Error("User not found."), { statusCode: 404 });
    const userData = userSnap.data();
    const email = userData.email || decoded.email;
    const name = userData.full_name || userData.name || "Olvra Boost Customer";
    const [first, ...rest] = String(name).trim().split(" ");
    const last = rest.join(" ") || first;

    const reference = `OLVDYN${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    const vaRes = await fetch(`${FLW_V3_BASE}/virtual-account-numbers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        tx_ref: reference,
        amount,
        currency: "NGN",
        bank_code: ISSUING_BANK_CODE,
        phonenumber: userData.phone || "",
        firstname: first || "Olvra",
        lastname: last || "Customer",
        narration: name,
      }),
    });
    const vaData = await vaRes.json();

    if (!vaRes.ok || vaData.status !== "success" || !vaData.data || !vaData.data.account_number) {
      console.error("create-dynamic-account: Flutterwave error:", vaData);
      throw Object.assign(new Error(vaData.message || "Couldn't generate a transfer account right now."), { statusCode: 502 });
    }

    // Pending record the webhook matches against by reference (this doc's
    // ID) — unlike the static account, this reference is never reused,
    // so matching is a direct lookup, no reused-tx_ref ambiguity.
    await db.collection("dynamic_fundings").doc(reference).set({
      uid,
      amount,
      status: "pending",
      account_number: vaData.data.account_number,
      bank_name: vaData.data.bank_name,
      flw_ref: vaData.data.flw_ref || null,
      order_ref: vaData.data.order_ref || null,
      created_at: FieldValue.serverTimestamp(),
    });

    return ok({
      reference,
      accountNumber: vaData.data.account_number,
      bankName: vaData.data.bank_name,
      amount,
      note: vaData.data.note || null,
    });
  } catch (err) {
    return fail(err);
  }
};
