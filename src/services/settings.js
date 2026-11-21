'use strict';
const { getDb, C } = require('../db');
const { parse, z } = require('../lib/validate');
const { audit } = require('../lib/audit');

const DEFAULTS = {
  servingSizeKg: 0.4, // assumption used to ESTIMATE meals (not verified beneficiaries)
  matchRadiusKm: 25,
  maxOffers: 5,
  otpTtlMinutes: 120,
  otpMaxAttempts: 5,
  otpMaxRegenerations: 5,
  gpsToleranceKm: 1,
};
let cached = null;
let cachedAt = 0;

async function get() {
  if (cached && Date.now() - cachedAt < 30000) return cached;
  const doc = await getDb().get(C.settings, 'global');
  const { id, ...rest } = doc || {};
  cached = { ...DEFAULTS, ...rest };
  cachedAt = Date.now();
  return cached;
}

const schema = z.object({
  servingSizeKg: z.coerce.number().min(0.1).max(2),
  matchRadiusKm: z.coerce.number().min(1).max(500),
  maxOffers: z.coerce.number().int().min(1).max(20),
  otpTtlMinutes: z.coerce.number().int().min(10).max(24 * 60),
  otpMaxAttempts: z.coerce.number().int().min(3).max(10),
  otpMaxRegenerations: z.coerce.number().int().min(1).max(20),
  gpsToleranceKm: z.coerce.number().min(0.1).max(50),
}).partial();

async function update(actor, body) {
  const patch = parse(schema, body);
  const next = { ...(await get()), ...patch, updatedAt: new Date().toISOString(), updatedBy: actor.id };
  delete next.id;
  await getDb().set(C.settings, 'global', next);
  await audit(getDb(), actor, 'settings.updated', 'settings', 'global', patch);
  cached = null;
  return get();
}

function reset() { cached = null; }

module.exports = { get, update, reset, DEFAULTS };
