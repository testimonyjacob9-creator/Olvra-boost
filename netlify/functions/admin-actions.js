// netlify/functions/admin-actions.js
//
// POST /.netlify/functions/admin-actions
// Headers: Authorization: Bearer <Firebase ID token>
// Body:    { action: "<name>", ...action-specific fields }
//
// Single consolidated endpoint for every write the admin dashboard needs
// to make. Firestore rules block ALL client writes to users/orders/
// wallet_topups/services/settings (see firestore.rules) — this function,
// using the Admin SDK, is the only path for admins to change any of that.
// Every action re-checks admins/{uid} itself; nothing here trusts the
// client beyond "this is a verified, signed-in Firebase user."
//
// Supported actions:
//   adjustWallet     { targetUid, amount, reason }
//   updateOrderStatus{ orderId, status, refund? }
//   toggleService     { serviceId, isActive }
//   updateSettings    { maintenance_mode?, signup_locked?, announcement? }
//   setUserDisabled   { targetUid, disabled }

const { db, auth, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");

async function assertAdmin(uid) {
  const snap = await db.collection("admins").doc(uid).get();
  if (!snap.exists) {
    throw Object.assign(new Error("Admin access required."), { statusCode: 403 });
  }
}

async function adjustWallet(adminUid, { targetUid, amount, reason }) {
  if (!targetUid || typeof amount !== "number" || !amount) {
    throw Object.assign(new Error("targetUid and a non-zero amount are required."), { statusCode: 400 });
  }
  const userRef = db.collection("users").doc(targetUid);
  const newBalance = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw Object.assign(new Error("User not found."), { statusCode: 404 });
    const current = snap.data().wallet_balance || 0;
    const updated = current + amount;
    if (updated < 0) throw Object.assign(new Error("This would take the user's wallet negative."), { statusCode: 400 });
    tx.update(userRef, { wallet_balance: updated });
    return updated;
  });
  await db.collection("wallet_topups").add({
    uid: targetUid,
    type: "admin_adjustment",
    gross_amount: amount,
    fee: 0,
    net_credit: amount,
    status: "credited",
    note: reason || "Manual admin adjustment",
    adjusted_by: adminUid,
    credited_at: FieldValue.serverTimestamp(),
  });
  return { newBalance };
}

async function updateOrderStatus(adminUid, { orderId, status, refund }) {
  const ALLOWED = ["processing", "completed", "failed", "cancelled"];
  if (!orderId || !ALLOWED.includes(status)) {
    throw Object.assign(new Error("orderId and a valid status are required."), { statusCode: 400 });
  }
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw Object.assign(new Error("Order not found."), { statusCode: 404 });
  const order = orderSnap.data();

  await orderRef.update({
    status,
    status_updated_by: adminUid,
    status_updated_at: FieldValue.serverTimestamp(),
  });

  let refunded = false;
  if (refund && order.uid && order.total_amount) {
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
      note: `Refund for order ${orderId}`,
      adjusted_by: adminUid,
      credited_at: FieldValue.serverTimestamp(),
    });
    refunded = true;
  }

  return { refunded };
}

async function toggleService(adminUid, { serviceId, isActive }) {
  if (!serviceId || typeof isActive !== "boolean") {
    throw Object.assign(new Error("serviceId and isActive are required."), { statusCode: 400 });
  }
  await db.collection("services").doc(String(serviceId)).update({ is_active: isActive });
  return { serviceId, isActive };
}

async function updateSettings(adminUid, body) {
  const { maintenance_mode, signup_locked, announcement } = body;
  const patch = { updated_by: adminUid, updated_at: FieldValue.serverTimestamp() };
  if (typeof maintenance_mode === "boolean") patch.maintenance_mode = maintenance_mode;
  if (typeof signup_locked === "boolean") patch.signup_locked = signup_locked;
  if (typeof announcement === "string") patch.announcement = announcement;
  await db.collection("settings").doc("global").set(patch, { merge: true });
  return { success: true };
}

async function setUserDisabled(adminUid, { targetUid, disabled }) {
  if (!targetUid || typeof disabled !== "boolean") {
    throw Object.assign(new Error("targetUid and disabled are required."), { statusCode: 400 });
  }
  await auth.updateUser(targetUid, { disabled });
  await db.collection("users").doc(targetUid).update({
    suspended: disabled,
    suspended_by: adminUid,
    suspended_at: disabled ? FieldValue.serverTimestamp() : FieldValue.delete(),
  });
  return { targetUid, disabled };
}

const ACTIONS = {
  adjustWallet,
  updateOrderStatus,
  toggleService,
  updateSettings,
  setUserDisabled,
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    await assertAdmin(decoded.uid);

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 });
    }

    const fn = ACTIONS[body.action];
    if (!fn) {
      throw Object.assign(new Error(`Unknown action: ${body.action}`), { statusCode: 400 });
    }

    const result = await fn(decoded.uid, body);
    return ok({ success: true, ...result });
  } catch (err) {
    return fail(err);
  }
};
