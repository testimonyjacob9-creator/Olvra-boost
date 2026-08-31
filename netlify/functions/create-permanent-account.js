// netlify/functions/create-permanent-account.js
//
// Creates a Flutterwave v3 STATIC virtual account (Sterling Bank) for the
// signed-in user, after they submit their NIN. Unlike a one-off checkout
// charge, a static account:
//   - never expires
//   - is reused for every future top-up
//   - accepts any amount transferred to it
//
// Flutterwave v3 requires a BVN or NIN to create a static account
// (identity verification requirement). We use NIN here.
//
// Matching incoming transfers back to this account: flutterwave-webhook.js
// matches primarily on `tx_ref` — Flutterwave reuses this exact reference
// on every charge into a static account (it does NOT include a destination
// account number in the webhook payload), so tx_ref is the reliable match.
//
// POST /.netlify/functions/create-permanent-account
// Headers: Authorization: Bearer <Firebase ID token>
// Body:    { nin, ninName }
// Returns: { accountNumber, accountName, bankName }

const { db } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");

const FLW_V3_BASE = "https://api.flutterwave.com/v3";
const ISSUING_BANK_CODE = "232"; // Sterling Bank PLC — WoodPayVTU already uses Wema (035), so Olvra Boost uses Sterling instead
const NIN_REGEX = /^[1-9][0-9]{10}$/; // Flutterwave's own validation pattern for nin/bvn

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

    const { nin, ninName } = body;
    if (!nin || !ninName) {
      throw Object.assign(new Error("nin and ninName are required."), { statusCode: 400 });
    }
    if (!NIN_REGEX.test(String(nin))) {
      throw Object.assign(new Error("NIN must be exactly 11 digits."), { statusCode: 400 });
    }

    const cleanName = String(ninName).trim().replace(/\s+/g, " ");
    if (cleanName.length < 3 || !cleanName.includes(" ")) {
      throw Object.assign(new Error("Enter a full name (first and last)."), { statusCode: 400 });
    }

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw Object.assign(new Error("User not found."), { statusCode: 404 });
    }
    const userData = userSnap.data();

    // Already has a working static account on file — don't create a second one.
    const existing = userData.permanent_account;
    if (existing && existing.account_number) {
      return ok({
        accountNumber: existing.account_number,
        accountName: existing.account_name || cleanName,
        bankName: existing.bank_name,
      });
    }

    const email = userData.email || decoded.email;
    const [first, ...rest] = cleanName.split(" ");
    const last = rest.join(" ") || first;

    const reference = `OLVRASTATIC${uid.slice(0, 12)}${Date.now().toString(36).toUpperCase()}`;

    const vaRes = await fetch(`${FLW_V3_BASE}/virtual-account-numbers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        tx_ref: reference,
        currency: "NGN",
        is_permanent: true,
        bank_code: ISSUING_BANK_CODE,
        phonenumber: userData.phone || "",
        firstname: first || "Olvra",
        lastname: last || "Customer",
        narration: cleanName,
        nin: String(nin),
      }),
    });
    const vaData = await vaRes.json();

    if (!vaRes.ok || vaData.status !== "success" || !vaData.data || !vaData.data.account_number) {
      console.error("flw v3 static account create error:", vaData);
      const msg =
        (vaData && (vaData.message || (vaData.error && vaData.error.message))) ||
        "Could not verify NIN or create account.";
      throw Object.assign(new Error(msg), { statusCode: 502 });
    }

    // Deliberately NOT storing the raw NIN — it's only ever passed through
    // to Flutterwave for the account-creation call.
    await userRef.update({
      name: cleanName,
      permanent_account: {
        account_number: vaData.data.account_number,
        account_name: cleanName,
        bank_name: vaData.data.bank_name,
        flw_ref: vaData.data.flw_ref || null,
        order_ref: vaData.data.order_ref || null,
        // Flutterwave reuses this exact tx_ref on every future
        // charge.completed webhook for this static account — the only
        // reliable way to match an incoming transfer back to this user.
        reference,
        created_at: new Date().toISOString(),
      },
    });

    return ok({
      accountNumber: vaData.data.account_number,
      accountName: cleanName,
      bankName: vaData.data.bank_name,
    });
  } catch (err) {
    return fail(err);
  }
};
