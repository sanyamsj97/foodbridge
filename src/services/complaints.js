'use strict';
const { getDb, C } = require('../db');
const { notFound, conflict } = require('../lib/errors');
const { parse, z, str, optStr } = require('../lib/validate');
const files = require('../lib/files');
const { audit } = require('../lib/audit');
const { notify, adminIds } = require('../lib/notify');

const TYPES = ['unsafe_food', 'suspicious_activity', 'fraud', 'no_show', 'misconduct', 'other'];

async function create(user, body) {
  const d = parse(z.object({
    type: z.enum(TYPES), description: str(10, 2000), donationId: optStr(64), againstUserId: optStr(64),
    photos: z.array(z.string()).max(3).default([]),
  }), body);
  d.photos.forEach((p) => files.decode(p));
  const db = getDb();
  if (d.donationId && !(await db.get(C.donations, d.donationId))) throw notFound('Donation');
  const c = await db.tx(async (t) => {
    const id = db.newId();
    const photoFileIds = d.photos.map((p) => files.save(t, { ownerId: user.id, purpose: 'complaint_evidence', sensitivity: 'identity', dataUrl: p }));
    const { photos, ...rest } = d;
    const doc = t.create(C.complaints, { ...rest, donationId: d.donationId || null, againstUserId: d.againstUserId || null, photoFileIds, reporterId: user.id, reporterName: user.name, reporterRole: user.role, status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, id);
    audit(t, user, 'complaint.created', 'complaint', id, { type: d.type, donationId: d.donationId || null });
    return doc;
  });
  await notify(await adminIds(), { title: `New complaint: ${d.type.replace(/_/g, ' ')}`, body: d.description.slice(0, 140), link: '/admin/complaints' });
  return c;
}

async function listMine(user) {
  const list = await getDb().find(C.complaints, { reporterId: user.id });
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function listAll({ status } = {}) {
  const list = await getDb().find(C.complaints, status ? { status } : {});
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function update(actor, id, body) {
  const d = parse(z.object({ status: z.enum(['investigating', 'resolved', 'dismissed']), resolution: optStr(2000) }), body);
  const db = getDb();
  const c = await db.get(C.complaints, id);
  if (!c) throw notFound('Complaint');
  if (['resolved', 'dismissed'].includes(c.status)) throw conflict('Complaint already closed');
  await db.update(C.complaints, id, { status: d.status, resolution: d.resolution || null, handledBy: actor.id, updatedAt: new Date().toISOString() });
  await audit(db, actor, `complaint.${d.status}`, 'complaint', id, { resolution: d.resolution || null });
  await notify(c.reporterId, { title: `Complaint ${d.status}`, body: d.resolution || 'Your complaint status was updated.', link: '/complaints' });
  return { id, status: d.status };
}
module.exports = { create, listMine, listAll, update, TYPES };
