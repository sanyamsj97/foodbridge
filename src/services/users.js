'use strict';
const { getDb, C } = require('../db');
const { notFound, bad, conflict } = require('../lib/errors');
const { parse, z, str, optStr, phone, gps } = require('../lib/validate');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const { publicUser } = require('./auth');
const { invalidateUser } = require('../middleware/auth');

const PROFILE = { donor: C.donors, volunteer: C.volunteers, ngo: C.ngos };

async function getProfile(user) {
  const col = PROFILE[user.role];
  return col ? getDb().get(col, user.id) : null;
}

async function list({ role, status } = {}) {
  const where = {};
  if (role) where.role = role;
  if (status) where.status = status;
  const users = await getDb().find(C.users, where);
  return users.map(publicUser).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function detail(id) {
  const db = getDb();
  const u = await db.get(C.users, id);
  if (!u) throw notFound('User');
  const profile = PROFILE[u.role] ? await db.get(PROFILE[u.role], id) : null;
  const documents = u.role === 'ngo' ? await db.find(C.ngoDocuments, { ngoId: id }) : [];
  const history = (await db.findOrdered(C.auditLogs, { entityId: id }, 'at', 50)) || [];
  return { user: { ...publicUser(u), lastLoginAt: u.lastLoginAt || null }, profile, documents, history };
}

async function setStatus(actor, id, action, reason) {
  const db = getDb();
  const map = { approve: 'active', reject: 'rejected', suspend: 'suspended', reactivate: 'active' };
  const to = map[action];
  if (!to) throw bad('Unknown action');
  if (['reject', 'suspend'].includes(action) && !reason) throw bad('A reason is required');
  const u = await db.tx(async (t) => {
    const user = await t.get(C.users, id);
    if (!user) throw notFound('User');
    if (user.role === 'admin') throw bad('Admin accounts cannot be changed here');
    const allowed = { approve: ['pending'], reject: ['pending'], suspend: ['active', 'pending'], reactivate: ['suspended'] }[action];
    if (!allowed.includes(user.status)) throw conflict(`Cannot ${action} a user whose status is ${user.status}`);
    if (action === 'approve' && user.role === 'ngo') {
      const docs = await t.find(C.ngoDocuments, { ngoId: id });
      const required = docs.filter((d) => d.required);
      if (!required.length || required.some((d) => d.status !== 'verified')) {
        throw conflict('All mandatory NGO documents (registration certificate, FCRA where applicable) must be verified before approval');
      }
    }
    const ts = new Date().toISOString();
    t.update(C.users, id, { status: to, statusReason: reason || null, updatedAt: ts, ...(action === 'suspend' ? { tokenVersion: (user.tokenVersion || 0) + 1 } : {}) });
    if (PROFILE[user.role] && (action === 'approve' || action === 'reject')) {
      t.update(PROFILE[user.role], id, { verified: action === 'approve', verifiedAt: ts, verifiedBy: actor.id, updatedAt: ts });
    }
    audit(t, actor, `user.${action}`, 'user', id, { reason: reason || null, role: user.role });
    return user;
  });
  invalidateUser(id);
  const msg = {
    approve: ['Account verified', 'Your FoodBridge account has been verified. You can now use all features.'],
    reject: ['Registration rejected', `Your registration was rejected: ${reason}`],
    suspend: ['Account suspended', `Your account has been suspended: ${reason}`],
    reactivate: ['Account reactivated', 'Your FoodBridge account is active again.'],
  }[action];
  await notify(id, { title: msg[0], body: msg[1], link: '/' });
  return { id, status: to, role: u.role };
}

async function reviewNgoDocument(actor, docId, { status, note }) {
  const d = parse(z.object({ status: z.enum(['verified', 'rejected']), note: optStr(500) }), { status, note });
  const db = getDb();
  const doc = await db.get(C.ngoDocuments, docId);
  if (!doc) throw notFound('Document');
  if (d.status === 'rejected' && !d.note) throw bad('A note is required when rejecting a document');
  await db.update(C.ngoDocuments, docId, { status: d.status, note: d.note || null, reviewedBy: actor.id, reviewedAt: new Date().toISOString() });
  await audit(db, actor, `ngo_document.${d.status}`, 'ngo_document', docId, { ngoId: doc.ngoId, type: doc.type, note: d.note || null });
  return { id: docId, status: d.status };
}

const profileSchemas = {
  donor: z.object({ phone, address: str(5, 300), city: str(2, 80), area: str(2, 80), location: gps, orgName: str(2, 150) }).partial(),
  volunteer: z.object({ phone, address: str(5, 300), city: str(2, 80), area: str(2, 80), location: gps, available: z.boolean(), emergencyContact: optStr(100) }).partial(),
  ngo: z.object({ phone, address: str(5, 300), city: str(2, 80), area: str(2, 80), location: gps, available: z.boolean(), capacityKg: z.coerce.number().positive().max(100000), acceptsNonVeg: z.boolean(), operatingArea: str(2, 300) }).partial(),
  admin: z.object({ phone }).partial(),
};

async function updateOwnProfile(user, body) {
  const d = parse(profileSchemas[user.role], body);
  const db = getDb();
  const ts = new Date().toISOString();
  const { phone: ph, ...rest } = d;
  if (ph) { await db.update(C.users, user.id, { phone: ph, updatedAt: ts }); invalidateUser(user.id); }
  if (PROFILE[user.role] && Object.keys(rest).length) await db.update(PROFILE[user.role], user.id, { ...rest, updatedAt: ts });
  await audit(db, user, 'profile.updated', 'user', user.id, { fields: Object.keys(d) });
  return getProfile(user);
}

module.exports = { list, detail, setStatus, reviewNgoDocument, getProfile, updateOwnProfile, PROFILE };
