// netlify/functions/set-pin.js
// POST /.netlify/functions/set-pin
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body: { newPin, currentPin? }   currentPin required only if a PIN is already set

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const { hashPin, verifyPinHash } = require("./_lib/pin");

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
    const { newPin, currentPin } = body;

    if (!newPin || !/^\d{4,6}$/.test(String(newPin))) {
      throw Object.assign(new Error("PIN must be 4-6 digits."), { statusCode: 400 });
    }

    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) throw Object.assign(new Error("User not found."), { statusCode: 404 });
    const existingHash = snap.data().pin_hash;

    if (existingHash) {
      if (!currentPin || !verifyPinHash(currentPin, existingHash)) {
        throw Object.assign(new Error("Current PIN is incorrect."), { statusCode: 401 });
      }
    }

    await userRef.update({
      pin_hash: hashPin(newPin),
      pin_updated_at: FieldValue.serverTimestamp(),
    });

    return ok({ success: true });
  } catch (err) {
    return fail(err);
  }
};
