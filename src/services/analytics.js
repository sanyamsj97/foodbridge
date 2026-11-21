'use strict';
const { getDb, C } = require('../db');
const settings = require('./settings');

let cache = null;
let cachedAt = 0;
const round = (n) => Math.round(n * 10) / 10;

function compute(list, s) {
  const sum = (arr, f) => arr.reduce((a, d) => a + (Number(f(d)) || 0), 0);
  const notRejected = list.filter((d) => !['rejected', 'cancelled'].includes(d.status));
  const delivered = list.filter((d) => d.receivedKg != null && ['received', 'distributed', 'completed'].includes(d.status));
  const completed = list.filter((d) => d.status === 'completed');
  const byStatus = {};
  for (const d of list) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  const areas = {};
  for (const d of list) {
    const key = `${d.pickup?.area || 'Unknown'}, ${d.pickup?.city || ''}`.replace(/, $/, '');
    const a = (areas[key] ||= { area: key, donations: 0, donatedKg: 0, deliveredKg: 0, completed: 0 });
    a.donations += 1;
    if (!['rejected', 'cancelled'].includes(d.status)) a.donatedKg += Number(d.quantityKg) || 0;
    if (d.receivedKg != null) a.deliveredKg += Number(d.receivedKg) || 0;
    if (d.status === 'completed') a.completed += 1;
  }
  const deliveredKg = sum(delivered, (d) => d.receivedKg);
  return {
    totalDonatedKg: round(sum(notRejected, (d) => d.quantityKg)),
    totalDeliveredKg: round(deliveredKg),
    estimatedMeals: Math.floor(deliveredKg / s.servingSizeKg),
    servingSizeKg: s.servingSizeKg,
    peopleServedReported: sum(completed, (d) => d.peopleServed),
    foodWastePreventedKg: round(sum(completed, (d) => d.distributedKg)),
    totalDonations: list.length,
    successfulDonations: completed.length,
    rejectedDonations: (byStatus.rejected || 0) + (byStatus.unsafe_rejected || 0),
    unsafeRejected: byStatus.unsafe_rejected || 0,
    expiredDonations: byStatus.expired || 0,
    byStatus,
    areas: Object.values(areas).map((a) => ({ ...a, donatedKg: round(a.donatedKg), deliveredKg: round(a.deliveredKg) })).sort((a, b) => b.donatedKg - a.donatedKg),
  };
}

async function dashboard({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < 60000) return cache;
  const db = getDb();
  const s = await settings.get();
  const [list, ngos, volunteers, donors, pendingUsers, openComplaints] = await Promise.all([
    db.find(C.donations, {}),
    db.count(C.users, { role: 'ngo', status: 'active' }),
    db.count(C.users, { role: 'volunteer', status: 'active' }),
    db.count(C.users, { role: 'donor', status: 'active' }),
    db.count(C.users, { status: 'pending' }),
    db.count(C.complaints, { status: 'open' }),
  ]);
  cache = { ...compute(list, s), verifiedNgos: ngos, activeVolunteers: volunteers, totalDonors: donors, pendingVerifications: pendingUsers, openComplaints, generatedAt: new Date().toISOString() };
  cachedAt = Date.now();
  return cache;
}

async function publicStats() {
  const d = await dashboard();
  return { totalDeliveredKg: d.totalDeliveredKg, estimatedMeals: d.estimatedMeals, successfulDonations: d.successfulDonations, verifiedNgos: d.verifiedNgos, activeVolunteers: d.activeVolunteers };
}

function invalidate() { cache = null; }

module.exports = { dashboard, publicStats, compute, invalidate };
