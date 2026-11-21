'use strict';
// Complete donation workflow (state machine). Every transition runs in a transaction that
// re-reads the donation, checks the actor and the current status, and writes an audit log –
// this is what prevents duplicate claims, double pickups and skipped verification steps.
const { getDb, C } = require('../db');
const { bad, forbidden, notFound, conflict, unprocessable } = require('../lib/errors');
const { parse, z, str, optStr, gps, isoDate, photos } = require('../lib/validate');
const { evaluate, STORAGE, CATEGORY } = require('../lib/safety');
const { distanceKm } = require('../lib/geo');
const files = require('../lib/files');
const { audit } = require('../lib/audit');
const { notify, adminIds } = require('../lib/notify');
const otp = require('./otp');
const settings = require('./settings');

const S = {
  PENDING: 'pending_review', APPROVED: 'approved', NGO_ACCEPTED: 'ngo_accepted',
  VOL_ASSIGNED: 'volunteer_assigned', IN_PICKUP: 'in_pickup', PICKED_UP: 'picked_up',
  AWAITING_RECEIPT: 'awaiting_receipt', RECEIVED: 'received', DISTRIBUTED: 'distributed',
  COMPLETED: 'completed', REJECTED: 'rejected', CANCELLED: 'cancelled', EXPIRED: 'expired',
  UNSAFE: 'unsafe_rejected',
};
const TRANSITIONS = {
  pending_review: ['approved', 'rejected', 'cancelled', 'expired'],
  approved: ['ngo_accepted', 'cancelled', 'expired'],
  ngo_accepted: ['volunteer_assigned', 'approved', 'cancelled', 'expired'],
  volunteer_assigned: ['in_pickup', 'ngo_accepted', 'approved', 'cancelled', 'expired'],
  in_pickup: ['picked_up', 'unsafe_rejected', 'ngo_accepted', 'approved', 'cancelled', 'expired'],
  picked_up: ['awaiting_receipt', 'unsafe_rejected'],
  awaiting_receipt: ['received', 'unsafe_rejected'],
  received: ['distributed'],
  distributed: ['completed'],
};
const TERMINAL = ['completed', 'rejected', 'cancelled', 'expired', 'unsafe_rejected'];
const PRE_PICKUP = ['pending_review', 'approved', 'ngo_accepted', 'volunteer_assigned', 'in_pickup'];
const ACTIVE = ['approved', 'ngo_accepted', 'volunteer_assigned', 'in_pickup', 'picked_up', 'awaiting_receipt', 'received', 'distributed'];

const nowIso = () => new Date().toISOString();

function move(t, d, to, patch = {}) {
  if (!(TRANSITIONS[d.status] || []).includes(to)) throw conflict(`Donation cannot move from "${d.status}" to "${to}"`);
  const ts = nowIso();
  const timeline = [...(d.timeline || []), { status: to, at: ts, by: patch._by || null }];
  delete patch._by;
  t.update(C.donations, d.id, { ...patch, status: to, updatedAt: ts, timeline });
  return { ...d, ...patch, status: to };
}

async function loadDonation(t, id) {
  const d = await t.get(C.donations, id);
  if (!d) throw notFound('Donation');
  return d;
}

function recordSafety(t, d, actor, stage, ev, extra = {}) {
  return t.create(C.safetyChecks, {
    donationId: d.id, stage, checkedBy: actor.id, role: actor.role, result: ev.result,
    flags: ev.flags, failures: ev.failures, safeUntil: ev.safeUntil, createdAt: nowIso(), ...extra,
  });
}

// ---------------------------------------------------------------- STEP 1: donor creates request
const createSchema = z.object({
  foodName: str(2, 120),
  category: z.enum(Object.keys(CATEGORY)),
  description: optStr(1000),
  quantityKg: z.coerce.number().positive().max(10000),
  vegType: z.enum(['veg', 'non_veg']),
  preparedAt: isoDate,
  expiryDate: isoDate.optional().or(z.literal('').transform(() => undefined)),
  pickupDeadline: isoDate,
  storage: z.enum(Object.keys(STORAGE)),
  tempC: z.coerce.number().min(-40).max(100).optional().or(z.literal('').transform(() => undefined)),
  allergens: z.array(str(1, 40)).max(20).default([]),
  safetyNotes: optStr(1000),
  handlingInstructions: str(3, 1000),
  pickup: z.object({ address: str(5, 300), city: str(2, 80), area: str(2, 80), lat: gps.shape.lat, lng: gps.shape.lng }),
  photos: photos(1, 4),
});

async function create(user, body) {
  const d = parse(createSchema, body);
  if (['hot_holding', 'refrigerated', 'frozen'].includes(d.storage) && d.tempC == null) {
    throw bad('A temperature reading is required for hot-held, refrigerated or frozen food');
  }
  const ev = evaluate(d, { stage: 'submission' });
  if (ev.result === 'fail') throw unprocessable(`Donation blocked by food-safety rules: ${ev.failures.join('; ')}`, { failures: ev.failures });
  d.photos.forEach((p) => files.decode(p)); // validate before writing
  const db = getDb();
  const donor = await db.get(C.donors, user.id);
  const s = await settings.get();
  const donation = await db.tx(async (t) => {
    const id = db.newId();
    const photoFileIds = d.photos.map((p) => files.save(t, { ownerId: user.id, purpose: 'food_photo', sensitivity: 'proof', donationId: id, dataUrl: p }));
    const ts = nowIso();
    const { photos: _p, ...food } = d;
    const doc = t.create(C.donations, {
      ...food, donorId: user.id, donorName: user.name, donorOrg: donor?.orgName || user.name,
      photoFileIds, status: S.PENDING, safety: { result: ev.result, flags: ev.flags, safeUntil: ev.safeUntil },
      estimatedMeals: Math.floor(d.quantityKg / s.servingSizeKg),
      ngoId: null, ngoName: null, volunteerId: null, volunteerName: null, assignmentId: null,
      createdAt: ts, updatedAt: ts, timeline: [{ status: S.PENDING, at: ts, by: user.id }],
    }, id);
    recordSafety(t, doc, user, 'submission', ev, { declaredTempC: d.tempC ?? null });
    audit(t, user, 'donation.created', 'food_donation', id, { quantityKg: d.quantityKg, safety: ev.result });
    return doc;
  });
  await notify(await adminIds(), { title: 'New donation awaiting review', body: `${donation.donorOrg}: ${d.foodName} (${d.quantityKg} kg)`, link: `/donation/${donation.id}` });
  return donation;
}

// ---------------------------------------------------------------- STEP 2: admin verification
async function review(actor, id, { decision, notes }) {
  const d0 = parse(z.object({ decision: z.enum(['approve', 'reject']), notes: optStr(1000) }), { decision, notes });
  if (d0.decision === 'reject' && !d0.notes) throw bad('Please give a reason for rejection');
  const db = getDb();
  const donorStatus = async (t, d) => (await t.get(C.users, d.donorId))?.status;
  const result = await db.tx(async (t) => {
    const d = await loadDonation(t, id);
    if (d.status !== S.PENDING) throw conflict(`Donation is already ${d.status}`);
    if (d0.decision === 'approve') {
      if ((await donorStatus(t, d)) !== 'active') throw conflict('Donor account is not verified/active');
      const ev = evaluate(d, { stage: 'admin_review' });
      recordSafety(t, d, actor, 'admin_review', ev, { notes: d0.notes || null });
      if (ev.result === 'fail') {
        move(t, d, S.REJECTED, { reviewNotes: `Automatic safety rejection: ${ev.failures.join('; ')}`, reviewedBy: actor.id, reviewedAt: nowIso(), _by: actor.id });
        audit(t, actor, 'donation.rejected_unsafe_at_review', 'food_donation', id, { failures: ev.failures });
        return { d, approved: false, reason: ev.failures.join('; ') };
      }
      move(t, d, S.APPROVED, { reviewNotes: d0.notes || null, reviewedBy: actor.id, reviewedAt: nowIso(), approvedAt: nowIso(), safety: { result: ev.result, flags: ev.flags, safeUntil: ev.safeUntil }, _by: actor.id });
      audit(t, actor, 'donation.approved', 'food_donation', id, { notes: d0.notes || null });
      return { d, approved: true };
    }
    move(t, d, S.REJECTED, { reviewNotes: d0.notes, reviewedBy: actor.id, reviewedAt: nowIso(), _by: actor.id });
    audit(t, actor, 'donation.rejected', 'food_donation', id, { notes: d0.notes });
    return { d, approved: false, reason: d0.notes };
  });
  if (result.approved) {
    await notify(result.d.donorId, { title: 'Donation approved', body: `${result.d.foodName} was approved. We are matching it with a nearby NGO.`, link: `/donation/${id}` });
    const offers = await matchAndOffer(actor, id);
    return { status: S.APPROVED, offeredTo: offers.length };
  }
  await notify(result.d.donorId, { title: 'Donation rejected', body: `${result.d.foodName}: ${result.reason}`, link: `/donation/${id}` });
  return { status: S.REJECTED };
}

// ---------------------------------------------------------------- STEP 3: NGO matching
async function activeProfiles(role, col) {
  const db = getDb();
  const users = await db.find(C.users, { role, status: 'active' });
  const profiles = await Promise.all(users.map((u) => db.get(col, u.id)));
  return users.map((u, i) => ({ user: u, profile: profiles[i] })).filter((x) => x.profile);
}

async function rankNgos(d, { excludeIds = [] } = {}) {
  const s = await settings.get();
  const ngos = await activeProfiles('ngo', C.ngos);
  return ngos
    .filter(({ user }) => !excludeIds.includes(user.id))
    .map(({ user, profile }) => {
      const dist = distanceKm(d.pickup, profile.location);
      const reasons = [];
      if (!profile.available) reasons.push('NGO marked unavailable');
      if (d.vegType === 'non_veg' && profile.acceptsNonVeg === false) reasons.push('NGO accepts vegetarian food only');
      if (dist == null || dist > s.matchRadiusKm) reasons.push(`Outside ${s.matchRadiusKm} km radius`);
      const capacityOk = profile.capacityKg >= d.quantityKg;
      return { ngoId: user.id, name: profile.registeredName, city: profile.city, area: profile.area, distanceKm: dist, capacityKg: profile.capacityKg, capacityOk, eligible: reasons.length === 0, reasons };
    })
    .sort((a, b) => (b.eligible - a.eligible) || (b.capacityOk - a.capacityOk) || ((a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)));
}

async function matchAndOffer(actor, id, { excludeIds = [] } = {}) {
  const db = getDb();
  const s = await settings.get();
  const d = await db.get(C.donations, id);
  const ranked = (await rankNgos(d, { excludeIds })).filter((n) => n.eligible).slice(0, s.maxOffers);
  for (const n of ranked) {
    await db.set(C.donationRequests, `${id}_${n.ngoId}`, {
      donationId: id, ngoId: n.ngoId, ngoName: n.name, type: 'offer', status: 'pending', distanceKm: n.distanceKm, createdAt: nowIso(), createdBy: actor.id,
    });
  }
  await audit(db, actor, 'donation.matched', 'food_donation', id, { offeredTo: ranked.map((n) => n.ngoId) });
  if (ranked.length) {
    await notify(ranked.map((n) => n.ngoId), { title: 'Food donation available near you', body: `${d.foodName} – ${d.quantityKg} kg (${d.vegType === 'veg' ? 'Veg' : 'Non-veg'}) in ${d.pickup.area}. Pickup by ${new Date(d.pickupDeadline).toLocaleString('en-IN')}.`, link: `/donation/${id}` });
  } else {
    await notify(await adminIds(), { title: 'No NGO matched', body: `No eligible NGO found automatically for ${d.foodName}. Offer it manually.`, link: `/donation/${id}` });
  }
  return ranked;
}

/** Admin manually offers a donation to a specific verified NGO. */
async function offerToNgo(actor, id, ngoId) {
  const db = getDb();
  const [d, u] = await Promise.all([db.get(C.donations, id), db.get(C.users, ngoId)]);
  if (!d) throw notFound('Donation');
  if (d.status !== S.APPROVED) throw conflict('Only approved, unclaimed donations can be offered');
  if (!u || u.role !== 'ngo' || u.status !== 'active') throw bad('Only verified (active) NGOs can receive donations');
  const ngo = await db.get(C.ngos, ngoId);
  await db.set(C.donationRequests, `${id}_${ngoId}`, { donationId: id, ngoId, ngoName: ngo.registeredName, type: 'offer', status: 'pending', distanceKm: distanceKm(d.pickup, ngo.location), createdAt: nowIso(), createdBy: actor.id });
  await audit(db, actor, 'donation.offered', 'food_donation', id, { ngoId });
  await notify(ngoId, { title: 'Donation offered to you', body: `${d.foodName} – ${d.quantityKg} kg`, link: `/donation/${id}` });
}

/** NGO asks for an open donation that was not offered to them – admin approves the request. */
async function ngoRequest(user, id, note) {
  const db = getDb();
  const d = await db.get(C.donations, id);
  if (!d) throw notFound('Donation');
  if (d.status !== S.APPROVED) throw conflict('Donation is no longer open');
  const ngo = await db.get(C.ngos, user.id);
  if (d.vegType === 'non_veg' && ngo.acceptsNonVeg === false) throw conflict('Your profile is set to vegetarian food only');
  const rid = `${id}_${user.id}`;
  const existing = await db.get(C.donationRequests, rid);
  if (existing && existing.status === 'pending') throw conflict(existing.type === 'offer' ? 'This donation was already offered to you – accept the offer instead' : 'You have already requested this donation');
  await db.set(C.donationRequests, rid, { donationId: id, ngoId: user.id, ngoName: ngo.registeredName, type: 'request', status: 'pending', note: note || null, distanceKm: distanceKm(d.pickup, ngo.location), createdAt: nowIso(), createdBy: user.id });
  await audit(db, user, 'donation.requested_by_ngo', 'food_donation', id, { note: note || null });
  await notify(await adminIds(), { title: 'NGO requested a donation', body: `${ngo.registeredName} requested ${d.foodName}`, link: `/donation/${id}` });
}

// ---------------------------------------------------------------- STEP 4: NGO acceptance
async function assignNgo(t, actor, d, req) {
  const ngoUser = await t.get(C.users, req.ngoId);
  if (!ngoUser || ngoUser.status !== 'active') throw conflict('Only verified NGOs can receive donations');
  const others = await t.find(C.donationRequests, { donationId: d.id, status: 'pending' });
  move(t, d, S.NGO_ACCEPTED, { ngoId: req.ngoId, ngoName: req.ngoName, ngoAcceptedAt: nowIso(), _by: actor.id });
  t.update(C.donationRequests, req.id, { status: 'accepted', decidedAt: nowIso(), decidedBy: actor.id });
  for (const o of others) if (o.id !== req.id) t.update(C.donationRequests, o.id, { status: 'superseded', decidedAt: nowIso() });
}

async function respondToOffer(user, id, { accept, reason }) {
  const db = getDb();
  const rid = `${id}_${user.id}`;
  const d = await db.tx(async (t) => {
    const don = await loadDonation(t, id);
    const req = await t.get(C.donationRequests, rid);
    if (!req || req.type !== 'offer' || req.status !== 'pending') throw conflict('No pending offer for your NGO');
    if (!accept) {
      t.update(C.donationRequests, rid, { status: 'declined', reason: reason || null, decidedAt: nowIso(), decidedBy: user.id });
      audit(t, user, 'donation.offer_declined', 'food_donation', id, { reason: reason || null });
      return don;
    }
    if (don.status !== S.APPROVED) throw conflict('Sorry – this donation has already been claimed or is no longer available');
    await assignNgo(t, user, don, req);
    audit(t, user, 'donation.ngo_accepted', 'food_donation', id, {});
    return don;
  });
  if (accept) {
    await notify(d.donorId, { title: 'NGO accepted your donation', body: `${d.foodName} will go to a verified NGO. A volunteer will be assigned shortly.`, link: `/donation/${id}` });
    await notify(await adminIds(), { title: 'Assign a volunteer', body: `NGO accepted ${d.foodName}. Please assign a volunteer.`, link: `/donation/${id}` });
  } else {
    const pending = await db.find(C.donationRequests, { donationId: id, status: 'pending' });
    if (!pending.length && d.status === S.APPROVED) await notify(await adminIds(), { title: 'All NGO offers declined', body: `${d.foodName} needs manual NGO allocation.`, link: `/donation/${id}` });
  }
}

async function decideNgoRequest(actor, id, ngoId, approve, reason) {
  const db = getDb();
  const rid = `${id}_${ngoId}`;
  const d = await db.tx(async (t) => {
    const don = await loadDonation(t, id);
    const req = await t.get(C.donationRequests, rid);
    if (!req || req.type !== 'request' || req.status !== 'pending') throw conflict('No pending request from this NGO');
    if (!approve) {
      t.update(C.donationRequests, rid, { status: 'declined', reason: reason || null, decidedAt: nowIso(), decidedBy: actor.id });
      audit(t, actor, 'donation.ngo_request_declined', 'food_donation', id, { ngoId });
      return don;
    }
    if (don.status !== S.APPROVED) throw conflict('Donation is no longer open');
    await assignNgo(t, actor, don, req);
    audit(t, actor, 'donation.ngo_request_approved', 'food_donation', id, { ngoId });
    return don;
  });
  await notify(ngoId, { title: approve ? 'Donation request approved' : 'Donation request declined', body: d.foodName, link: `/donation/${id}` });
  if (approve) await notify(d.donorId, { title: 'NGO assigned', body: `${d.foodName} has been allocated to a verified NGO.`, link: `/donation/${id}` });
}

/** NGO gives back a donation before pickup (cannot be collected). Rematches excluding this NGO. */
async function ngoRelease(user, id, reason) {
  if (!reason) throw bad('Please give a reason');
  const db = getDb();
  const d = await db.tx(async (t) => {
    const don = await loadDonation(t, id);
    if (don.ngoId !== user.id) throw forbidden();
    if (![S.NGO_ACCEPTED, S.VOL_ASSIGNED, S.IN_PICKUP].includes(don.status)) throw conflict('Donation can no longer be released');
    if (don.assignmentId) t.update(C.assignments, don.assignmentId, { status: 'cancelled', cancelledAt: nowIso(), cancelReason: 'NGO released donation' });
    if (don.status === S.IN_PICKUP) otp.invalidate(t, id, 'pickup');
    t.update(C.donationRequests, `${id}_${user.id}`, { status: 'withdrawn', reason, decidedAt: nowIso() });
    move(t, don, S.APPROVED, { ngoId: null, ngoName: null, volunteerId: null, volunteerName: null, assignmentId: null, _by: user.id });
    audit(t, user, 'donation.ngo_released', 'food_donation', id, { reason });
    return don;
  });
  await notify([d.donorId, d.volunteerId, ...(await adminIds())], { title: 'NGO released a donation', body: `${d.foodName}: ${reason}. Re-matching with other NGOs.`, link: `/donation/${id}` });
  await matchAndOffer(user, id, { excludeIds: [user.id] });
}

// ---------------------------------------------------------------- STEP 5: volunteer assignment
async function rankVolunteers(d) {
  const db = getDb();
  const vols = await activeProfiles('volunteer', C.volunteers);
  const interest = await db.find(C.assignments, { donationId: d.id, status: 'interested' });
  const active = await db.find(C.assignments, { status: { in: ['assigned', 'accepted', 'picked_up'] } });
  return vols.map(({ user, profile }) => ({
    volunteerId: user.id, name: user.name, area: profile.area, city: profile.city, vehicleType: profile.vehicleType,
    available: profile.available !== false, completedCount: profile.completedCount || 0,
    distanceKm: distanceKm(d.pickup, profile.location),
    interested: interest.some((i) => i.volunteerId === user.id),
    activeTasks: active.filter((a) => a.volunteerId === user.id).length,
  })).sort((a, b) => (b.available - a.available) || (b.interested - a.interested) || (a.activeTasks - b.activeTasks) || ((a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)));
}

async function assignVolunteer(actor, id, volunteerId) {
  const db = getDb();
  const d = await db.tx(async (t) => {
    const don = await loadDonation(t, id);
    if (don.status !== S.NGO_ACCEPTED) throw conflict('A volunteer can only be assigned after an NGO has accepted the donation');
    const vu = await t.get(C.users, volunteerId);
    if (!vu || vu.role !== 'volunteer' || vu.status !== 'active') throw bad('Only approved (active) volunteers can be assigned');
    const vp = await t.get(C.volunteers, volunteerId);
    if (vp && vp.available === false) throw conflict('Volunteer has marked themselves unavailable');
    const a = t.create(C.assignments, { donationId: id, volunteerId, volunteerName: vu.name, assignedBy: actor.id, status: 'assigned', assignedAt: nowIso() });
    move(t, don, S.VOL_ASSIGNED, { volunteerId, volunteerName: vu.name, assignmentId: a.id, assignedAt: nowIso(), _by: actor.id });
    audit(t, actor, 'donation.volunteer_assigned', 'food_donation', id, { volunteerId, assignmentId: a.id });
    return don;
  });
  await notify(volunteerId, { title: 'New pickup assigned', body: `${d.foodName} (${d.quantityKg} kg) from ${d.donorOrg}. Please accept or decline.`, link: `/donation/${id}` });
}

async function unassignVolunteer(actor, id, reason) {
  const db = getDb();
  const d = await db.tx(async (t) => {
    const don = await loadDonation(t, id);
    if (![S.VOL_ASSIGNED, S.IN_PICKUP].includes(don.status)) throw conflict('Volunteer can only be removed before pickup');
    t.update(C.assignments, don.assignmentId, { status: 'cancelled', cancelledAt: nowIso(), cancelReason: reason || 'Removed by admin' });
    if (don.status === S.IN_PICKUP) otp.invalidate(t, id, 'pickup');
    move(t, don, S.NGO_ACCEPTED, { volunteerId: null, volunteerName: null, assignmentId: null, _by: actor.id });
    audit(t, actor, 'donation.volunteer_unassigned', 'food_donation', id, { volunteerId: don.volunteerId, reason: reason || null });
    return don;
  });
  await notify(d.volunteerId, { title: 'Pickup unassigned', body: `You are no longer assigned to ${d.foodName}.`, link: '/' });
}

async function volunteerInterest(user, id) {
  const db = getDb();
  const d = await db.get(C.donations, id);
  if (!d || d.status !== S.NGO_ACCEPTED) throw conflict('This pickup is not open for volunteers');
  await db.set(C.assignments, `${id}_${user.id}_interest`, { donationId: id, volunteerId: user.id, volunteerName: user.name, status: 'interested', createdAt: nowIso() });
  await audit(db, user, 'donation.volunteer_interested', 'food_donation', id, {});
  await notify(await adminIds(), { title: 'Volunteer available for pickup', body: `${user.name} offered to collect ${d.foodName}.`, link: `/donation/${id}` });
}

async function respondToAssignment(user, id, { accept, reason }) {
  const db = getDb();
  const d = await db.tx(async (t) => {
    const don = await loadDonation(t, id);
    if (don.volunteerId !== user.id || don.status !== S.VOL_ASSIGNED) throw conflict('No pending assignment for you on this donation');
    if (accept) {
      t.update(C.assignments, don.assignmentId, { status: 'accepted', acceptedAt: nowIso() });
      move(t, don, S.IN_PICKUP, { pickupStartedAt: nowIso(), _by: user.id });
      await otp.issue(t, { donationId: id, stage: 'pickup', holderId: don.donorId, verifierId: user.id });
      audit(t, user, 'assignment.accepted', 'food_donation', id, {});
    } else {
      t.update(C.assignments, don.assignmentId, { status: 'declined', declinedAt: nowIso(), declineReason: reason || null });
      move(t, don, S.NGO_ACCEPTED, { volunteerId: null, volunteerName: null, assignmentId: null, _by: user.id });
      audit(t, user, 'assignment.declined', 'food_donation', id, { reason: reason || null });
    }
    return don;
  });
  if (accept) {
    await notify([d.donorId, d.ngoId], { title: 'Volunteer on the way', body: `${user.name} accepted the pickup of ${d.foodName}.`, link: `/donation/${id}` });
    await notify(d.donorId, { title: 'Pickup OTP ready', body: 'Open the donation to see your pickup OTP. Share it with the volunteer only after you hand over the food.', link: `/donation/${id}` });
  } else {
    await notify(await adminIds(), { title: 'Volunteer declined pickup', body: `${user.name} declined ${d.foodName}. Please reassign.`, link: `/donation/${id}` });
  }
}

// ---------------------------------------------------------------- STEP 6: pickup with OTP
const pickupSchema = z.object({
  otp: z.string().trim().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  quantityKg: z.coerce.number().positive().max(10000),
  conditionOk: z.literal(true, { errorMap: () => ({ message: 'Confirm food condition is acceptable, or use "Reject unsafe food"' }) }),
  tempC: z.coerce.number().min(-40).max(100).optional().or(z.literal('').transform(() => undefined)),
  packagingOk: z.boolean().default(true),
  notes: optStr(1000),
  photos: photos(1, 4),
  gps,
});

async function confirmPickup(user, id, body) {
  const p = parse(pickupSchema, body);
  const db = getDb();
  const s = await settings.get();
  const d0 = await db.get(C.donations, id);
  if (!d0) throw notFound('Donation');
  if (d0.volunteerId !== user.id || d0.status !== S.IN_PICKUP) throw conflict('You are not collecting this donation right now');
  if (['hot_holding', 'refrigerated', 'frozen'].includes(d0.storage) && p.tempC == null) throw bad('Record the food temperature at pickup');
  const ev = evaluate(d0, { stage: 'pickup', measuredTempC: p.tempC });
  if (ev.result === 'fail') throw unprocessable(`Food fails the safety check at pickup: ${ev.failures.join('; ')}. Do not collect – use "Reject unsafe food".`, { failures: ev.failures });
  p.photos.forEach((x) => files.decode(x));
  const flags = [...ev.flags];
  if (!p.packagingOk) flags.push('Volunteer reported packaging issues');
  const diff = Math.abs(p.quantityKg - d0.quantityKg) / d0.quantityKg;
  if (diff > 0.2) flags.push(`Quantity differs from declared by ${Math.round(diff * 100)}% (${d0.quantityKg} kg declared, ${p.quantityKg} kg verified)`);
  const gpsDist = distanceKm(p.gps, d0.pickup);
  if (gpsDist != null && gpsDist > s.gpsToleranceKm) flags.push(`Pickup GPS is ${gpsDist} km from the listed pickup location`);

  await otp.check(id, 'pickup', user, p.otp);

  const d = await db.tx(async (t) => {
    const don = await loadDonation(t, id);
    if (don.volunteerId !== user.id || don.status !== S.IN_PICKUP) throw conflict('Pickup already recorded or no longer valid');
    const otpAt = await otp.consume(t, id, 'pickup', user);
    const photoFileIds = p.photos.map((x) => files.save(t, { ownerId: user.id, purpose: 'pickup_photo', sensitivity: 'proof', donationId: id, dataUrl: x }));
    const safety = recordSafety(t, don, user, 'pickup', { ...ev, result: flags.length ? 'flag' : 'pass', flags }, { measuredTempC: p.tempC ?? null, packagingOk: p.packagingOk });
    const pv = t.create(C.pickups, {
      donationId: id, volunteerId: user.id, donorId: don.donorId, quantityKgDeclared: don.quantityKg, quantityKgVerified: p.quantityKg,
      conditionOk: true, tempC: p.tempC ?? null, notes: p.notes || null, photoFileIds, gps: p.gps, gpsDistanceKm: gpsDist,
      otpVerifiedAt: otpAt, status: 'verified', flags, safetyCheckId: safety.id, createdAt: nowIso(),
    });
    t.update(C.assignments, don.assignmentId, { status: 'picked_up', pickedUpAt: nowIso() });
    move(t, don, S.PICKED_UP, { pickedUpAt: nowIso(), verifiedPickupKg: p.quantityKg, pickupVerificationId: pv.id, _by: user.id });
    await otp.issue(t, { donationId: id, stage: 'delivery', holderId: user.id, verifierId: don.ngoId });
    audit(t, user, 'donation.picked_up', 'food_donation', id, { quantityKg: p.quantityKg, gps: p.gps, flags });
    return don;
  });
  await notify([d.donorId, d.ngoId], { title: 'Food picked up', body: `${user.name} collected ${p.quantityKg} kg of ${d.foodName}.`, link: `/donation/${id}` });
  if (flags.length) await notify(await adminIds(), { title: 'Pickup flagged', body: `${d.foodName}: ${flags.join('; ')}`, link: `/donation/${id}` });
  return { status: S.PICKED_UP, flags };
}

// ---------------------------------------------------------------- STEP 7: transport + delivery proof
const arriveSchema = z.object({ photos: photos(1, 4), gps, notes: optStr(1000) });

async function markDelivered(user, id, body) {
  const p = parse(arriveSchema, body);
  p.photos.forEach((x) => files.decode(x));
  const db = getDb();
  const s = await settings.get();
  const d0 = await db.get(C.donations, id);
  if (!d0) throw notFound('Donation');
  const ngo = await db.get(C.ngos, d0.ngoId);
  const gpsDist = distanceKm(p.gps, ngo?.location);
  const flags = [];
  if (gpsDist != null && gpsDist > s.gpsToleranceKm) flags.push(`Delivery GPS is ${gpsDist} km from the NGO's registered location`);
  const d = await db.tx(async (t) => {
    const don = await loadDonation(t, id);
    if (don.volunteerId !== user.id || don.status !== S.PICKED_UP) throw conflict('Delivery can only be recorded for food you have picked up');
    const photoFileIds = p.photos.map((x) => files.save(t, { ownerId: user.id, purpose: 'delivery_photo', sensitivity: 'proof', donationId: id, dataUrl: x }));
    const dv = t.create(C.deliveries, {
      donationId: id, volunteerId: user.id, ngoId: don.ngoId, deliveryPhotoFileIds: photoFileIds, deliveryGps: p.gps,
      deliveryGpsDistanceKm: gpsDist, volunteerNotes: p.notes || null, arrivedAt: nowIso(), status: 'awaiting_ngo', flags,
    });
    move(t, don, S.AWAITING_RECEIPT, { arrivedAt: nowIso(), deliveryVerificationId: dv.id, _by: user.id });
    audit(t, user, 'donation.delivered_by_volunteer', 'food_donation', id, { gps: p.gps, flags });
    return don;
  });
  await notify(d.ngoId, { title: 'Volunteer has arrived', body: `Check ${d.foodName}, then enter the delivery OTP the volunteer shows you.`, link: `/donation/${id}` });
  return { status: S.AWAITING_RECEIPT, flags };
}

// ---------------------------------------------------------------- STEP 8: NGO receiving verification
const receiveSchema = z.object({
  otp: z.string().trim().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  receivedKg: z.coerce.number().positive().max(10000),
  conditionOk: z.literal(true, { errorMap: () => ({ message: 'Confirm food condition is acceptable, or use "Reject unsafe food"' }) }),
  tempC: z.coerce.number().min(-40).max(100).optional().or(z.literal('').transform(() => undefined)),
  notes: optStr(1000),
  photos: photos(1, 4),
});

async function confirmReceipt(user, id, body) {
  const p = parse(receiveSchema, body);
  const db = getDb();
  const d0 = await db.get(C.donations, id);
  if (!d0) throw notFound('Donation');
  if (d0.ngoId !== user.id || d0.status !== S.AWAITING_RECEIPT) throw conflict('This donation is not awaiting your receipt');
  if (['hot_holding', 'refrigerated', 'frozen'].includes(d0.storage) && p.tempC == null) throw bad('Record the food temperature on receipt');
  const ev = evaluate(d0, { stage: 'receipt', measuredTempC: p.tempC });
  if (ev.result === 'fail') throw unprocessable(`Food fails the safety check on receipt: ${ev.failures.join('; ')}. Do not distribute – use "Reject unsafe food".`, { failures: ev.failures });
  p.photos.forEach((x) => files.decode(x));
  const flags = [...ev.flags];
  const base = d0.verifiedPickupKg || d0.quantityKg;
  const diff = Math.abs(p.receivedKg - base) / base;
  if (diff > 0.1) flags.push(`Received ${p.receivedKg} kg vs ${base} kg picked up (${Math.round(diff * 100)}% difference)`);

  await otp.check(id, 'delivery', user, p.otp);

  const d = await db.tx(async (t) => {
    const don = await loadDonation(t, id);
    if (don.ngoId !== user.id || don.status !== S.AWAITING_RECEIPT) throw conflict('Receipt already recorded');
    const vp = await t.get(C.volunteers, don.volunteerId);
    const otpAt = await otp.consume(t, id, 'delivery', user);
    const photoFileIds = p.photos.map((x) => files.save(t, { ownerId: user.id, purpose: 'receiving_photo', sensitivity: 'proof', donationId: id, dataUrl: x }));
    const safety = recordSafety(t, don, user, 'receipt', { ...ev, result: flags.length ? 'flag' : 'pass', flags }, { measuredTempC: p.tempC ?? null });
    t.update(C.deliveries, don.deliveryVerificationId, {
      status: 'verified', receivedKg: p.receivedKg, conditionOk: true, tempC: p.tempC ?? null, ngoNotes: p.notes || null,
      receivingPhotoFileIds: photoFileIds, otpVerifiedAt: otpAt, receivedBy: user.id, receivedAt: nowIso(), receiptFlags: flags, safetyCheckId: safety.id,
    });
    t.update(C.assignments, don.assignmentId, { status: 'completed', completedAt: nowIso() });
    if (vp) t.update(C.volunteers, don.volunteerId, { completedCount: (vp.completedCount || 0) + 1 });
    move(t, don, S.RECEIVED, { receivedAt: nowIso(), receivedKg: p.receivedKg, _by: user.id });
    audit(t, user, 'donation.received', 'food_donation', id, { receivedKg: p.receivedKg, flags });
    return don;
  });
  await notify([d.donorId, d.volunteerId], { title: 'Food received by NGO', body: `${d.ngoName} confirmed receipt of ${p.receivedKg} kg of ${d.foodName}.`, link: `/donation/${id}` });
  if (flags.length) await notify(await adminIds(), { title: 'Receipt flagged', body: `${d.foodName}: ${flags.join('; ')}`, link: `/donation/${id}` });
  return { status: S.RECEIVED, flags };
}

// ---------------------------------------------------------------- unsafe food rejection (volunteer/NGO)
async function rejectUnsafe(user, id, body) {
  const p = parse(z.object({ reason: str(5, 1000), tempC: z.coerce.number().min(-40).max(100).optional().or(z.literal('').transform(() => undefined)), photos: z.array(z.string()).max(4).default([]) }), body);
  p.photos.forEach((x) => files.decode(x));
  const db = getDb();
  const d = await db.tx(async (t) => {
    const don = await loadDonation(t, id);
    const isVol = user.role === 'volunteer' && don.volunteerId === user.id && [S.IN_PICKUP, S.PICKED_UP].includes(don.status);
    const isNgo = user.role === 'ngo' && don.ngoId === user.id && don.status === S.AWAITING_RECEIPT;
    if (!isVol && !isNgo) throw forbidden('You cannot reject this donation at its current stage');
    const photoFileIds = p.photos.map((x) => files.save(t, { ownerId: user.id, purpose: 'unsafe_evidence', sensitivity: 'proof', donationId: id, dataUrl: x }));
    const stage = isNgo ? 'receipt' : don.status === S.IN_PICKUP ? 'pickup' : 'transit';
    recordSafety(t, don, user, stage, { result: 'fail', flags: [], failures: [p.reason], safeUntil: don.safety?.safeUntil }, { measuredTempC: p.tempC ?? null, photoFileIds, rejectedBy: user.role });
    if (don.assignmentId) t.update(C.assignments, don.assignmentId, { status: 'closed_unsafe', closedAt: nowIso() });
    if (don.status === S.IN_PICKUP) otp.invalidate(t, id, 'pickup');
    else otp.invalidate(t, id, 'delivery');
    move(t, don, S.UNSAFE, { closedReason: p.reason, closedAt: nowIso(), _by: user.id });
    audit(t, user, 'donation.rejected_unsafe', 'food_donation', id, { stage, reason: p.reason });
    return don;
  });
  await notify([d.donorId, d.ngoId, d.volunteerId, ...(await adminIds())].filter((x) => x !== user.id), { title: 'Food rejected as unsafe', body: `${d.foodName}: ${p.reason}`, link: `/donation/${id}` });
  return { status: S.UNSAFE };
}

// ---------------------------------------------------------------- STEP 9 + 10: distribution and completion
const distSchema = z.object({
  distributedAt: isoDate,
  peopleServed: z.coerce.number().int().min(1).max(1000000),
  distributedKg: z.coerce.number().positive().max(10000),
  location: str(3, 300),
  beneficiaryGroup: optStr(200),
  notes: optStr(1000),
  photos: z.array(z.string()).max(4).default([]),
});

/** Pure check: every mandatory verification step must be present and successful. */
function computeMissing({ don, pv, dv, checks, rec }) {
  const missing = [];
  if (!pv || pv.status !== 'verified' || !pv.otpVerifiedAt) missing.push('Pickup OTP verification');
  if (!pv?.photoFileIds?.length) missing.push('Pickup photographs');
  if (!pv?.gps) missing.push('Pickup GPS location');
  if (!checks.some((c) => c.stage === 'pickup' && c.result !== 'fail')) missing.push('Food safety check at pickup');
  if (!dv || dv.status !== 'verified' || !dv.otpVerifiedAt) missing.push('Delivery OTP verification by NGO');
  if (!dv?.deliveryPhotoFileIds?.length) missing.push('Delivery photographs');
  if (!dv?.receivingPhotoFileIds?.length) missing.push('NGO receiving photographs');
  if (!checks.some((c) => c.stage === 'receipt' && c.result !== 'fail')) missing.push('Food safety check on receipt');
  if (checks.some((c) => c.result === 'fail')) missing.push('A food-safety check failed');
  if (!rec || !(rec.peopleServed >= 1)) missing.push('Distribution record');
  if (rec && Date.parse(rec.distributedAt) > Date.parse(don.safety?.safeUntil)) missing.push('Distribution happened after the safe-until time – admin review required');
  return missing;
}

async function recordDistribution(user, id, body) {
  const p = parse(distSchema, body);
  p.photos.forEach((x) => files.decode(x));
  const db = getDb();
  const s = await settings.get();
  const out = await db.tx(async (t) => {
    const don = await loadDonation(t, id);
    if (don.ngoId !== user.id || don.status !== S.RECEIVED) throw conflict('Distribution can only be recorded after you have received the food');
    if (Date.parse(p.distributedAt) > Date.now() + 5 * 60000) throw bad('Distribution time cannot be in the future');
    if (Date.parse(p.distributedAt) < Date.parse(don.receivedAt) - 60000) throw bad('Distribution time cannot be before the food was received');
    if (p.distributedKg > (don.receivedKg || 0) + 0.001) throw bad(`Distributed quantity cannot exceed received quantity (${don.receivedKg} kg)`);
    // All reads before writes (Firestore transaction rule).
    const pv = don.pickupVerificationId ? await t.get(C.pickups, don.pickupVerificationId) : null;
    const dv = don.deliveryVerificationId ? await t.get(C.deliveries, don.deliveryVerificationId) : null;
    const checks = await t.find(C.safetyChecks, { donationId: id });

    const proofFileIds = p.photos.map((x) => files.save(t, { ownerId: user.id, purpose: 'distribution_proof', sensitivity: 'proof', donationId: id, dataUrl: x }));
    const { photos: _ph, ...rest } = p;
    const rec = t.create(C.distributions, { donationId: id, ngoId: user.id, ...rest, proofFileIds, createdAt: nowIso() });
    const missing = computeMissing({ don, pv, dv, checks, rec });
    const ts = nowIso();
    const patch = { distributedAt: p.distributedAt, distributedKg: p.distributedKg, peopleServed: p.peopleServed, distributionRecordId: rec.id, updatedAt: ts };
    const timeline = [...(don.timeline || []), { status: S.DISTRIBUTED, at: ts, by: user.id }];
    audit(t, user, 'donation.distributed', 'food_donation', id, { peopleServed: p.peopleServed, distributedKg: p.distributedKg });
    if (!missing.length) {
      const completion = {
        completedAt: ts,
        donor: { id: don.donorId, name: don.donorName, org: don.donorOrg },
        volunteer: { id: don.volunteerId, name: don.volunteerName },
        ngo: { id: don.ngoId, name: don.ngoName },
        food: { name: don.foodName, category: don.category, vegType: don.vegType },
        quantityKgDeclared: don.quantityKg, quantityKgPickedUp: don.verifiedPickupKg, quantityKgReceived: don.receivedKg, quantityKgDistributed: p.distributedKg,
        peopleServed: p.peopleServed, estimatedMeals: Math.floor((don.receivedKg || 0) / s.servingSizeKg), servingSizeKgAssumed: s.servingSizeKg,
        pickupVerificationId: pv.id, pickupOtpVerifiedAt: pv.otpVerifiedAt, pickupGps: pv.gps, pickupPhotos: pv.photoFileIds.length,
        deliveryVerificationId: dv.id, deliveryOtpVerifiedAt: dv.otpVerifiedAt, deliveryGps: dv.deliveryGps,
        receivingPhotos: dv.receivingPhotoFileIds.length, distributionRecordId: rec.id, distributionStatus: 'distributed',
        safetyChecks: checks.map((c) => ({ stage: c.stage, result: c.result })),
      };
      timeline.push({ status: S.COMPLETED, at: ts, by: 'system' });
      t.update(C.donations, id, { ...patch, status: S.COMPLETED, completedAt: ts, completion, completionMissing: [], estimatedMeals: completion.estimatedMeals, timeline });
      audit(t, null, 'donation.completed', 'food_donation', id, { completion });
    } else {
      t.update(C.donations, id, { ...patch, status: S.DISTRIBUTED, completionMissing: missing, timeline });
      audit(t, null, 'donation.completion_blocked', 'food_donation', id, { missing });
    }
    return { don, missing };
  });
  const { don, missing } = out;
  if (!missing.length) {
    await notify([don.donorId, don.volunteerId, don.ngoId, ...(await adminIds())], { title: 'Donation completed', body: `${don.foodName}: distributed to ${p.peopleServed} people. Thank you!`, link: `/donation/${id}` });
    return { status: S.COMPLETED };
  }
  await notify(await adminIds(), { title: 'Donation needs review', body: `${don.foodName} cannot be completed: ${missing.join('; ')}`, link: `/donation/${id}` });
  return { status: S.DISTRIBUTED, missing };
}

// ---------------------------------------------------------------- cancel / expire
async function cancel(user, id, reason) {
  if (!reason) throw bad('Please give a reason');
  const db = getDb();
  const d = await db.tx(async (t) => {
    const don = await loadDonation(t, id);
    if (user.role === 'donor' && don.donorId !== user.id) throw forbidden();
    if (!PRE_PICKUP.includes(don.status)) throw conflict('Donation can no longer be cancelled');
    if (don.assignmentId) t.update(C.assignments, don.assignmentId, { status: 'cancelled', cancelledAt: nowIso(), cancelReason: reason });
    if (don.status === S.IN_PICKUP) otp.invalidate(t, id, 'pickup');
    move(t, don, S.CANCELLED, { closedReason: reason, closedAt: nowIso(), _by: user.id });
    audit(t, user, 'donation.cancelled', 'food_donation', id, { reason });
    return don;
  });
  await notify([d.donorId, d.ngoId, d.volunteerId].filter((x) => x && x !== user.id), { title: 'Donation cancelled', body: `${d.foodName}: ${reason}`, link: `/donation/${id}` });
}

/** Expire donations whose pickup deadline / safe time has passed before pickup. */
async function sweepExpired() {
  const db = getDb();
  const list = await db.find(C.donations, { status: { in: PRE_PICKUP } });
  const now = Date.now();
  let n = 0;
  for (const d0 of list) {
    const deadline = d0.status === S.IN_PICKUP ? Date.parse(d0.safety?.safeUntil) : Math.min(Date.parse(d0.pickupDeadline), Date.parse(d0.safety?.safeUntil));
    if (!(deadline < now)) continue;
    try {
      const d = await db.tx(async (t) => {
        const don = await loadDonation(t, d0.id);
        if (!PRE_PICKUP.includes(don.status)) return null;
        if (don.assignmentId) t.update(C.assignments, don.assignmentId, { status: 'cancelled', cancelledAt: nowIso(), cancelReason: 'Expired' });
        if (don.status === S.IN_PICKUP) otp.invalidate(t, don.id, 'pickup');
        move(t, don, S.EXPIRED, { closedReason: 'Pickup deadline or safe time passed before collection', closedAt: nowIso(), _by: 'system' });
        audit(t, null, 'donation.expired', 'food_donation', don.id, {});
        return don;
      });
      if (d) { n += 1; await notify([d.donorId, d.ngoId, d.volunteerId], { title: 'Donation expired', body: `${d.foodName} was not collected within its safe time and has expired.`, link: `/donation/${d.id}` }); }
    } catch (e) { /* skip; next sweep retries */ }
  }
  return n;
}

module.exports = {
  S, TERMINAL, PRE_PICKUP, ACTIVE,
  create, review, rankNgos, matchAndOffer, offerToNgo, ngoRequest, respondToOffer, decideNgoRequest, ngoRelease,
  rankVolunteers, assignVolunteer, unassignVolunteer, volunteerInterest, respondToAssignment,
  confirmPickup, markDelivered, confirmReceipt, rejectUnsafe, recordDistribution, computeMissing, cancel, sweepExpired,
};
