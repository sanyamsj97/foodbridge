'use strict';
// Two-stage handover OTPs (pickup + delivery).
// SMS gateways are paid services, so codes are shown in-app to the "holder" (donor for pickup,
// volunteer for delivery) who reads it out to the "verifier" at the physical handover.
// Codes are encrypted at rest, expire, have attempt limits and are single-use.
const { getDb, C } = require('../db');
const { AppError, forbidden, notFound, conflict } = require('../lib/errors');
const { generateCode, hashCode, encrypt, decrypt, safeEqual } = require('../lib/otpCrypto');
const { audit } = require('../lib/audit');
const settings = require('./settings');

const otpId = (donationId, stage) => `${donationId}_${stage}`;
const PASS_VALID_MS = 10 * 60 * 1000;

/** Issue a fresh OTP inside a transaction. */
async function issue(t, { donationId, stage, holderId, verifierId }) {
  const s = await settings.get();
  const code = generateCode();
  const salt = `${donationId}:${stage}:${Date.now()}`;
  const ts = new Date();
  t.set(C.otps, otpId(donationId, stage), {
    donationId, stage, holderId, verifierId, salt,
    hash: hashCode(code, salt), enc: encrypt(code),
    createdAt: ts.toISOString(),
    expiresAt: new Date(ts.getTime() + s.otpTtlMinutes * 60000).toISOString(),
    attempts: 0, maxAttempts: s.otpMaxAttempts, regenerations: 0,
    verifiedAt: null, verifiedBy: null, consumedAt: null,
  });
}

function invalidate(t, donationId, stage) {
  t.set(C.otps, otpId(donationId, stage), { donationId, stage, consumedAt: new Date().toISOString(), invalidated: true });
}

/** The holder views their code. */
async function reveal(donationId, stage, user) {
  const o = await getDb().get(C.otps, otpId(donationId, stage));
  if (!o || o.invalidated) return null;
  if (o.holderId !== user.id) throw forbidden('Only the OTP holder can view this code');
  const expired = Date.parse(o.expiresAt) < Date.now();
  return {
    stage,
    code: o.consumedAt || expired ? null : decrypt(o.enc),
    expiresAt: o.expiresAt,
    expired,
    used: Boolean(o.consumedAt),
    locked: o.attempts >= o.maxAttempts,
    attemptsLeft: Math.max(0, o.maxAttempts - o.attempts),
  };
}

/** Holder requests a new code (e.g. expired or locked). Limited per donation. */
async function regenerate(donationId, stage, user) {
  const db = getDb();
  const s = await settings.get();
  await db.tx(async (t) => {
    const o = await t.get(C.otps, otpId(donationId, stage));
    if (!o || o.invalidated) throw notFound('OTP');
    if (o.holderId !== user.id) throw forbidden('Only the OTP holder can regenerate this code');
    if (o.consumedAt) throw conflict('This OTP has already been used');
    if ((o.regenerations || 0) >= s.otpMaxRegenerations) throw conflict('Regeneration limit reached. Contact the FoodBridge admin.');
    const code = generateCode();
    const salt = `${donationId}:${stage}:${Date.now()}`;
    t.update(C.otps, o.id, {
      salt, hash: hashCode(code, salt), enc: encrypt(code), attempts: 0,
      expiresAt: new Date(Date.now() + s.otpTtlMinutes * 60000).toISOString(),
      regenerations: (o.regenerations || 0) + 1, verifiedAt: null, verifiedBy: null,
    });
    audit(t, user, 'otp.regenerated', 'food_donation', donationId, { stage });
  });
  return reveal(donationId, stage, user);
}

/**
 * Verifier submits the code. Wrong attempts are persisted (so brute force is capped);
 * success issues a short-lived "pass" consumed by the pickup/receipt transaction.
 */
async function check(donationId, stage, user, code) {
  const db = getDb();
  const r = await db.tx(async (t) => {
    const o = await t.get(C.otps, otpId(donationId, stage));
    if (!o || o.invalidated) throw notFound('OTP');
    if (o.verifierId !== user.id) throw forbidden('You are not the verifier for this OTP');
    if (o.consumedAt) throw conflict('This OTP has already been used');
    if (Date.parse(o.expiresAt) < Date.now()) return { error: 'OTP has expired. Ask the holder to generate a new code.' };
    if (o.attempts >= o.maxAttempts) return { error: 'Too many wrong attempts. Ask the holder to generate a new code.' };
    if (!safeEqual(hashCode(String(code || '').trim(), o.salt), o.hash)) {
      const attempts = o.attempts + 1;
      t.update(C.otps, o.id, { attempts });
      audit(t, user, 'otp.failed', 'food_donation', donationId, { stage, attempts });
      return { error: `Incorrect OTP. ${Math.max(0, o.maxAttempts - attempts)} attempt(s) left.` };
    }
    t.update(C.otps, o.id, { verifiedAt: new Date().toISOString(), verifiedBy: user.id });
    return { ok: true };
  });
  if (r.error) throw new AppError(400, r.error, 'otp_invalid');
  return true;
}

/** Inside the completing transaction: require a fresh pass and mark the OTP used. */
async function consume(t, donationId, stage, user) {
  const o = await t.get(C.otps, otpId(donationId, stage));
  if (!o || o.invalidated || o.consumedAt) throw conflict('OTP is no longer valid');
  if (o.verifiedBy !== user.id || !o.verifiedAt || Date.now() - Date.parse(o.verifiedAt) > PASS_VALID_MS) {
    throw new AppError(400, 'OTP verification required', 'otp_invalid');
  }
  const ts = new Date().toISOString();
  t.update(C.otps, o.id, { consumedAt: ts });
  return ts;
}

module.exports = { issue, invalidate, reveal, regenerate, check, consume };
