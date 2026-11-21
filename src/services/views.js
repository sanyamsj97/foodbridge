'use strict';
// Read models for each dashboard. Private data (phone numbers, exact addresses, identity
// documents) is only returned to the parties actively involved in a donation and to admins.
const { getDb, C } = require('../db');
const { notFound, forbidden } = require('../lib/errors');
const { distanceKm } = require('../lib/geo');
const otp = require('./otp');
const donations = require('./donations');
const { S } = donations;

const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));

function summary(d, extra = {}) {
  return {
    id: d.id, foodName: d.foodName, category: d.category, quantityKg: d.quantityKg, vegType: d.vegType,
    status: d.status, preparedAt: d.preparedAt, pickupDeadline: d.pickupDeadline, storage: d.storage,
    allergens: d.allergens || [], estimatedMeals: d.estimatedMeals, donorOrg: d.donorOrg, ngoName: d.ngoName,
    volunteerName: d.volunteerName, area: d.pickup?.area, city: d.pickup?.city, safety: d.safety,
    createdAt: d.createdAt, completedAt: d.completedAt || null, receivedKg: d.receivedKg ?? null,
    peopleServed: d.peopleServed ?? null, ...extra,
  };
}

async function donorList(user) {
  const list = await getDb().find(C.donations, { donorId: user.id });
  return list.sort(byNewest).map((d) => summary(d));
}

async function ngoBoard(user) {
  const db = getDb();
  const ngo = await db.get(C.ngos, user.id);
  const [open, mine, reqs] = await Promise.all([
    db.find(C.donations, { status: S.APPROVED }),
    db.find(C.donations, { ngoId: user.id }),
    db.find(C.donationRequests, { ngoId: user.id }),
  ]);
  const reqBy = Object.fromEntries(reqs.map((r) => [r.donationId, r]));
  const openList = open
    .filter((d) => !(d.vegType === 'non_veg' && ngo?.acceptsNonVeg === false))
    .map((d) => summary(d, { distanceKm: distanceKm(d.pickup, ngo?.location), request: reqBy[d.id] ? { type: reqBy[d.id].type, status: reqBy[d.id].status } : null }))
    .sort((a, b) => (Number(b.request?.type === 'offer' && b.request?.status === 'pending') - Number(a.request?.type === 'offer' && a.request?.status === 'pending')) || ((a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)));
  return {
    offers: openList.filter((d) => d.request?.type === 'offer' && d.request.status === 'pending'),
    open: openList.filter((d) => !(d.request?.type === 'offer' && d.request.status === 'pending')),
    active: mine.filter((d) => !donations.TERMINAL.includes(d.status)).sort(byNewest).map((d) => summary(d)),
    history: mine.filter((d) => donations.TERMINAL.includes(d.status)).sort(byNewest).map((d) => summary(d)),
  };
}

async function volunteerBoard(user) {
  const db = getDb();
  const me = await db.get(C.volunteers, user.id);
  const [mine, available, interest] = await Promise.all([
    db.find(C.donations, { volunteerId: user.id }),
    db.find(C.donations, { status: S.NGO_ACCEPTED }),
    db.find(C.assignments, { volunteerId: user.id, status: 'interested' }),
  ]);
  const completedAssignments = await db.find(C.assignments, { volunteerId: user.id, status: 'completed' });
  const histIds = completedAssignments.map((a) => a.donationId);
  const history = (await Promise.all(histIds.slice(0, 100).map((id) => db.get(C.donations, id)))).filter(Boolean);
  return {
    available: available.map((d) => summary(d, { distanceKm: distanceKm(d.pickup, me?.location), interested: interest.some((i) => i.donationId === d.id) }))
      .sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)),
    active: mine.filter((d) => !donations.TERMINAL.includes(d.status) && ![S.RECEIVED, S.DISTRIBUTED].includes(d.status)).sort(byNewest).map((d) => summary(d)),
    history: history.sort(byNewest).map((d) => summary(d)),
    profile: me ? { available: me.available !== false, completedCount: me.completedCount || 0 } : null,
  };
}

async function adminList({ status } = {}) {
  const list = await getDb().find(C.donations, status ? { status } : {});
  return list.sort(byNewest).slice(0, 1000).map((d) => summary(d, { donorId: d.donorId, flags: d.safety?.flags?.length || 0 }));
}

async function liveBoard() {
  const db = getDb();
  const active = await db.find(C.donations, { status: { in: donations.ACTIVE } });
  const rows = await Promise.all(active.map(async (d) => {
    const pv = d.pickupVerificationId ? await db.get(C.pickups, d.pickupVerificationId) : null;
    const dv = d.deliveryVerificationId ? await db.get(C.deliveries, d.deliveryVerificationId) : null;
    const ngo = d.ngoId ? await db.get(C.ngos, d.ngoId) : null;
    return summary(d, { pickupLocation: d.pickup, pickupGps: pv?.gps || null, deliveryGps: dv?.deliveryGps || null, ngoLocation: ngo?.location || null, updatedAt: d.updatedAt });
  }));
  return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** Who can see the donation, and with what level of detail. */
async function access(user, d) {
  const db = getDb();
  if (user.role === 'admin') return 'full';
  if (user.role === 'donor' && d.donorId === user.id) return 'full';
  if (user.role === 'ngo') {
    if (d.ngoId === user.id) return 'full';
    if (d.status === S.APPROVED) return 'listing';
    const req = await db.get(C.donationRequests, `${d.id}_${user.id}`);
    return req ? 'listing' : null;
  }
  if (user.role === 'volunteer') {
    if (d.volunteerId === user.id) return 'full';
    if (d.status === S.NGO_ACCEPTED) return 'listing';
    const hist = await db.find(C.assignments, { donationId: d.id, volunteerId: user.id });
    return hist.length ? 'listing' : null;
  }
  return null;
}

async function party(userId, role) {
  if (!userId) return null;
  const db = getDb();
  const [u, p] = await Promise.all([db.get(C.users, userId), db.get(role === 'ngo' ? C.ngos : role === 'donor' ? C.donors : C.volunteers, userId)]);
  if (!u) return null;
  const out = { id: u.id, name: u.name, phone: u.phone };
  if (role === 'donor') Object.assign(out, { org: p?.orgName, orgType: p?.orgType });
  if (role === 'ngo') Object.assign(out, { org: p?.registeredName, address: p?.address, location: p?.location, representative: p?.representative });
  if (role === 'volunteer') Object.assign(out, { vehicleType: p?.vehicleType, photoFileId: p?.photoFileId });
  return out;
}

async function detail(user, id) {
  const db = getDb();
  const d = await db.get(C.donations, id);
  if (!d) throw notFound('Donation');
  const level = await access(user, d);
  if (!level) throw forbidden();
  const { timeline, ...donation } = d;
  if (level === 'listing') {
    // Approximate details only – no exact address / contacts until the party is assigned.
    const me = user.role === 'ngo' ? await db.get(C.ngos, user.id) : await db.get(C.volunteers, user.id);
    const req = user.role === 'ngo' ? await db.get(C.donationRequests, `${id}_${user.id}`) : null;
    const interest = user.role === 'volunteer' ? await db.get(C.assignments, `${id}_${user.id}_interest`) : null;
    return {
      level,
      donation: { ...summary(d), description: d.description, handlingInstructions: d.handlingInstructions, safetyNotes: d.safetyNotes, tempC: d.tempC, expiryDate: d.expiryDate, photoFileIds: d.photoFileIds, distanceKm: distanceKm(d.pickup, me?.location) },
      request: req ? { type: req.type, status: req.status } : null,
      interested: Boolean(interest),
    };
  }
  const [pickup, delivery, safetyChecks, distribution, requests, assignments] = await Promise.all([
    d.pickupVerificationId ? db.get(C.pickups, d.pickupVerificationId) : null,
    d.deliveryVerificationId ? db.get(C.deliveries, d.deliveryVerificationId) : null,
    db.find(C.safetyChecks, { donationId: id }),
    db.find(C.distributions, { donationId: id }),
    user.role === 'admin' ? db.find(C.donationRequests, { donationId: id }) : [],
    user.role === 'admin' ? db.find(C.assignments, { donationId: id }) : [],
  ]);
  const showContacts = user.role === 'admin' || !donations.TERMINAL.includes(d.status) || d.status === S.COMPLETED;
  const parties = {
    donor: user.role !== 'donor' ? await party(d.donorId, 'donor') : null,
    ngo: user.role !== 'ngo' ? await party(d.ngoId, 'ngo') : null,
    volunteer: user.role !== 'volunteer' ? await party(d.volunteerId, 'volunteer') : null,
  };
  if (!showContacts || user.role === 'donor') {
    // Donors never see NGO addresses; nobody sees contacts after a donation is closed.
    if (parties.ngo) { delete parties.ngo.address; delete parties.ngo.location; delete parties.ngo.representative; if (!showContacts) delete parties.ngo.phone; }
    if (parties.volunteer && !showContacts) delete parties.volunteer.phone;
    if (parties.donor && !showContacts) delete parties.donor.phone;
  }
  let otpView = null;
  if (user.role === 'donor' && d.status === S.IN_PICKUP) otpView = await otp.reveal(id, 'pickup', user);
  if (user.role === 'volunteer' && [S.PICKED_UP, S.AWAITING_RECEIPT].includes(d.status)) otpView = await otp.reveal(id, 'delivery', user);
  const out = {
    level, donation, timeline, pickup, delivery, safetyChecks: safetyChecks.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    distribution: distribution[0] || null, parties, otp: otpView,
  };
  if (user.role === 'admin') {
    out.requests = requests;
    out.assignments = assignments;
    out.audit = await db.findOrdered(C.auditLogs, { entityId: id }, 'at', 100);
    if (d.status === S.APPROVED) out.ngoCandidates = await donations.rankNgos(d);
    if (d.status === S.NGO_ACCEPTED) out.volunteerCandidates = await donations.rankVolunteers(d);
  }
  return out;
}

module.exports = { donorList, ngoBoard, volunteerBoard, adminList, liveBoard, detail, access };
