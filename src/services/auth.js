'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb, C } = require('../db');
const { AppError, unauthorized, forbidden, conflict } = require('../lib/errors');
const { parse, z, str, optStr, phone, email, password, gps, dataUrl } = require('../lib/validate');
const files = require('../lib/files');
const { audit } = require('../lib/audit');
const { notify, adminIds } = require('../lib/notify');

const ORG_TYPES = ['college_mess', 'hostel', 'hotel', 'restaurant', 'event_organizer', 'caterer', 'other'];
const ID_TYPES = ['aadhaar', 'pan', 'driving_licence', 'voter_id', 'passport', 'gst', 'fssai', 'other'];
const VEHICLES = ['on_foot', 'bicycle', 'two_wheeler', 'car', 'van', 'other'];

const base = {
  name: str(2, 100), email, password, phone,
  address: str(5, 300), city: str(2, 80), area: str(2, 80), location: gps,
};
const schemas = {
  donor: z.object({
    ...base,
    orgName: str(2, 150), orgType: z.enum(ORG_TYPES),
    idType: z.enum(ID_TYPES), idNumber: str(4, 40), fssaiLicense: optStr(40),
    idDocument: dataUrl,
  }),
  volunteer: z.object({
    ...base,
    govIdType: z.enum(ID_TYPES), govIdNumber: str(4, 40),
    vehicleType: z.enum(VEHICLES), emergencyContact: optStr(100),
    idDocument: dataUrl, profilePhoto: dataUrl,
  }),
  ngo: z.object({
    ...base,
    registeredName: str(2, 200), registrationNumber: str(3, 80), pan: optStr(20),
    operatingArea: str(2, 300), repDesignation: str(2, 100),
    fcraApplicable: z.coerce.boolean().default(false), fcraNumber: optStr(40),
    capacityKg: z.coerce.number().positive().max(100000),
    acceptsNonVeg: z.coerce.boolean().default(true),
    registrationCertificate: dataUrl, panDocument: dataUrl.optional(), fcraDocument: dataUrl.optional(),
    orgPhotos: z.array(dataUrl).min(1, 'At least one organisation photo').max(3),
  }).refine((d) => !d.fcraApplicable || (d.fcraNumber && d.fcraDocument), { message: 'FCRA number and certificate are required when FCRA is applicable', path: ['fcraNumber'] }),
};

const mask = (v) => { const s = String(v).replace(/\s|-/g, ''); return `${'X'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();

async function register(role, body, ip) {
  if (!schemas[role]) throw forbidden('Self-registration is not available for this role');
  const d = parse(schemas[role], body);
  const db = getDb();
  const passwordHash = await bcrypt.hash(d.password, config.bcryptRounds);
  // Validate all files before any write.
  const user = await db.tx(async (t) => {
    if (await t.get(C.userEmails, d.email)) throw conflict('An account with this email already exists');
    const userId = db.newId();
    const ts = now();
    t.create(C.userEmails, { userId }, d.email);
    const common = { address: d.address, city: d.city, area: d.area, location: d.location, createdAt: ts, updatedAt: ts };
    if (role === 'donor') {
      const idDocFileId = files.save(t, { ownerId: userId, purpose: 'donor_id', sensitivity: 'identity', dataUrl: d.idDocument, allowed: files.DOCS });
      t.create(C.donors, { userId, orgName: d.orgName, orgType: d.orgType, idType: d.idType, idNumberMasked: mask(d.idNumber), fssaiLicense: d.fssaiLicense || null, idDocFileId, verified: false, ...common }, userId);
    } else if (role === 'volunteer') {
      const idDocFileId = files.save(t, { ownerId: userId, purpose: 'volunteer_id', sensitivity: 'identity', dataUrl: d.idDocument, allowed: files.DOCS });
      const photoFileId = files.save(t, { ownerId: userId, purpose: 'volunteer_photo', sensitivity: 'identity', dataUrl: d.profilePhoto });
      t.create(C.volunteers, { userId, govIdType: d.govIdType, govIdNumberMasked: mask(d.govIdNumber), vehicleType: d.vehicleType, emergencyContact: d.emergencyContact || null, idDocFileId, photoFileId, available: true, completedCount: 0, ...common }, userId);
    } else {
      t.create(C.ngos, { userId, registeredName: d.registeredName, registrationNumber: d.registrationNumber, panMasked: d.pan ? mask(d.pan) : null, operatingArea: d.operatingArea, representative: { name: d.name, designation: d.repDesignation, phone: d.phone, email: d.email }, fcraApplicable: d.fcraApplicable, fcraNumber: d.fcraApplicable ? d.fcraNumber : null, capacityKg: d.capacityKg, acceptsNonVeg: d.acceptsNonVeg, available: true, verified: false, ...common }, userId);
      const docs = [['registration_certificate', d.registrationCertificate, true], ['pan', d.panDocument, false], ['fcra', d.fcraDocument, d.fcraApplicable]];
      for (const [type, url, required] of docs) {
        if (!url) continue;
        const fileId = files.save(t, { ownerId: userId, purpose: `ngo_${type}`, sensitivity: 'identity', dataUrl: url, allowed: files.DOCS });
        t.create(C.ngoDocuments, { ngoId: userId, type, fileId, required, status: 'pending', createdAt: ts });
      }
      for (const url of d.orgPhotos) {
        const fileId = files.save(t, { ownerId: userId, purpose: 'ngo_photo', sensitivity: 'identity', dataUrl: url });
        t.create(C.ngoDocuments, { ngoId: userId, type: 'organisation_photo', fileId, required: false, status: 'pending', createdAt: ts });
      }
    }
    const u = t.create(C.users, { email: d.email, passwordHash, role, name: d.name, phone: d.phone, status: 'pending', statusReason: null, failedLogins: 0, lockUntil: null, tokenVersion: 0, createdAt: ts, updatedAt: ts }, userId);
    audit(t, { id: userId, role, name: d.name, ip }, 'user.registered', 'user', userId, { role });
    return u;
  });
  await notify(await adminIds(), { title: `New ${role} registration`, body: `${d.name} registered and awaits verification.`, link: `/admin/users/${user.id}` });
  return publicUser(user);
}

function publicUser(u) {
  return { id: u.id, email: u.email, role: u.role, name: u.name, phone: u.phone, status: u.status, statusReason: u.statusReason || null, createdAt: u.createdAt };
}

function signAccess(u) {
  return jwt.sign({ sub: u.id, role: u.role, tv: u.tokenVersion || 0 }, config.jwt.accessSecret, { expiresIn: config.jwt.accessTtl, issuer: 'foodbridge' });
}

async function issueTokens(u, family) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + config.jwt.refreshTtlDays * 86400000).toISOString();
  await getDb().create(C.refreshTokens, { userId: u.id, family: family || crypto.randomUUID(), expiresAt, revokedAt: null, createdAt: now() }, sha(raw));
  return { accessToken: signAccess(u), refreshToken: raw, refreshExpiresAt: expiresAt };
}

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

async function login({ email: em, password: pw, portal }, ip) {
  const d = parse(z.object({ email, password: z.string().min(1).max(128), portal: z.enum(['admin', 'donor', 'volunteer', 'ngo']) }), { email: em, password: pw, portal });
  const db = getDb();
  if (portal === 'admin' && config.adminIpAllowlist.length && !config.adminIpAllowlist.includes(ip)) throw forbidden('Admin access is not permitted from this network');
  const idx = await db.get(C.userEmails, d.email);
  const u = idx && (await db.get(C.users, idx.userId));
  const generic = unauthorized('Invalid email, password, or portal');
  if (!u) { await bcrypt.hash(d.password, 4); throw generic; }
  if (u.lockUntil && Date.parse(u.lockUntil) > Date.now()) throw new AppError(429, 'Account temporarily locked after repeated failed logins. Try again in 15 minutes.', 'locked');
  const ok = await bcrypt.compare(d.password, u.passwordHash);
  if (!ok || u.role !== d.portal) {
    const fails = (u.failedLogins || 0) + 1;
    await db.update(C.users, u.id, { failedLogins: fails >= MAX_FAILS ? 0 : fails, lockUntil: fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS).toISOString() : null });
    if (fails >= MAX_FAILS) await audit(db, { id: u.id, role: u.role, name: u.name, ip }, 'auth.locked', 'user', u.id, {});
    throw generic;
  }
  if (u.status === 'suspended') throw forbidden(`Account suspended${u.statusReason ? `: ${u.statusReason}` : ''}. Contact FoodBridge support.`);
  if (u.status === 'rejected') throw forbidden(`Registration was rejected${u.statusReason ? `: ${u.statusReason}` : ''}.`);
  await db.update(C.users, u.id, { failedLogins: 0, lockUntil: null, lastLoginAt: now() });
  await audit(db, { id: u.id, role: u.role, name: u.name, ip }, 'auth.login', 'user', u.id, { portal });
  return { user: publicUser(u), ...(await issueTokens(u)) };
}

async function refresh(raw) {
  if (!raw) throw unauthorized('No session');
  const db = getDb();
  const id = sha(raw);
  const result = await db.tx(async (t) => {
    const rt = await t.get(C.refreshTokens, id);
    if (!rt) throw unauthorized('Session expired');
    if (rt.revokedAt) return { reuse: rt };
    if (Date.parse(rt.expiresAt) < Date.now()) throw unauthorized('Session expired');
    t.update(C.refreshTokens, id, { revokedAt: now() });
    return { rt };
  });
  if (result.reuse) {
    // Token reuse => possible theft: revoke the whole family.
    const fam = await db.find(C.refreshTokens, { family: result.reuse.family });
    await Promise.all(fam.map((f) => db.update(C.refreshTokens, f.id, { revokedAt: f.revokedAt || now() })));
    await audit(db, { id: result.reuse.userId }, 'auth.refresh_reuse_detected', 'user', result.reuse.userId, {});
    throw unauthorized('Session invalidated. Please sign in again.');
  }
  const u = await db.get(C.users, result.rt.userId);
  if (!u || ['suspended', 'rejected'].includes(u.status)) throw unauthorized('Account not available');
  return { user: publicUser(u), ...(await issueTokens(u, result.rt.family)) };
}

async function logout(raw) {
  if (!raw) return;
  const db = getDb();
  const rt = await db.get(C.refreshTokens, sha(raw));
  if (rt) {
    const fam = await db.find(C.refreshTokens, { family: rt.family });
    await Promise.all(fam.map((f) => db.update(C.refreshTokens, f.id, { revokedAt: f.revokedAt || now() })));
  }
}

async function changePassword(user, { currentPassword, newPassword }) {
  const d = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), { currentPassword, newPassword });
  const db = getDb();
  const u = await db.get(C.users, user.id);
  if (!(await bcrypt.compare(d.currentPassword, u.passwordHash))) throw unauthorized('Current password is incorrect');
  await db.update(C.users, u.id, { passwordHash: await bcrypt.hash(d.newPassword, config.bcryptRounds), tokenVersion: (u.tokenVersion || 0) + 1, updatedAt: now() });
  const tokens = await db.find(C.refreshTokens, { userId: u.id });
  await Promise.all(tokens.map((f) => db.update(C.refreshTokens, f.id, { revokedAt: f.revokedAt || now() })));
  await audit(db, user, 'auth.password_changed', 'user', u.id, {});
}

/** Create an admin account (CLI only – never exposed over HTTP). */
async function createAdmin({ name, email: em, phone: ph, password: pw }) {
  const d = parse(z.object({ name: str(2, 100), email, phone, password }), { name, email: em, phone: ph, password: pw });
  const db = getDb();
  const passwordHash = await bcrypt.hash(d.password, config.bcryptRounds);
  return db.tx(async (t) => {
    if (await t.get(C.userEmails, d.email)) throw conflict('Email already in use');
    const id = db.newId();
    t.create(C.userEmails, { userId: id }, d.email);
    const ts = now();
    const u = t.create(C.users, { email: d.email, passwordHash, role: 'admin', name: d.name, phone: d.phone, status: 'active', failedLogins: 0, lockUntil: null, tokenVersion: 0, createdAt: ts, updatedAt: ts }, id);
    audit(t, { id: 'cli', role: 'system', name: 'CLI' }, 'admin.created', 'user', id, { email: d.email });
    return publicUser(u);
  });
}

module.exports = { register, login, refresh, logout, changePassword, createAdmin, publicUser, ORG_TYPES, ID_TYPES, VEHICLES };
