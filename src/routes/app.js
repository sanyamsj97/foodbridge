'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { authenticate, requireRole, requireActive, oneOf } = require('../middleware/auth');
const donations = require('../services/donations');
const views = require('../services/views');
const otp = require('../services/otp');
const complaints = require('../services/complaints');
const reports = require('../services/reports');
const analytics = require('../services/analytics');
const { getDb, C } = require('../db');
const { notFound, forbidden } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);

// OTP-bearing endpoints get a tighter per-user limit on top of per-OTP attempt limits.
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isTest ? 10000 : 30, keyGenerator: (req) => req.user.id, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many verification attempts, please wait' } });
const done = (res, r) => { analytics.invalidate(); res.json(r || { ok: true }); };
const donor = [requireRole('donor'), requireActive];
const ngo = [requireRole('ngo'), requireActive];
const vol = [requireRole('volunteer'), requireActive];

// ---- notifications
router.get('/notifications', async (req, res) => {
  const list = await getDb().findOrdered(C.notifications, { userId: req.user.id }, 'createdAt', 50);
  res.json({ notifications: list, unread: list.filter((n) => !n.read).length });
});
router.get('/notifications/unread-count', async (req, res) => res.json({ unread: await getDb().count(C.notifications, { userId: req.user.id, read: false }) }));
router.post('/notifications/read-all', async (req, res) => {
  const list = await getDb().find(C.notifications, { userId: req.user.id, read: false });
  await Promise.all(list.map((n) => getDb().update(C.notifications, n.id, { read: true })));
  res.json({ ok: true });
});
router.post('/notifications/:id/read', async (req, res) => {
  const n = await getDb().get(C.notifications, req.params.id);
  if (!n || n.userId !== req.user.id) throw notFound('Notification');
  await getDb().update(C.notifications, n.id, { read: true });
  res.json({ ok: true });
});

// ---- files (access-controlled; identity documents are owner + admin only)
router.get('/files/:id', async (req, res) => {
  const db = getDb();
  const f = await db.get(C.files, req.params.id);
  if (!f) throw notFound('File');
  let ok = req.user.role === 'admin' || f.ownerId === req.user.id;
  if (!ok && f.sensitivity === 'proof' && f.donationId) {
    const d = await db.get(C.donations, f.donationId);
    ok = Boolean(d && (await views.access(req.user, d)));
  }
  if (!ok && f.sensitivity === 'identity' && f.purpose === 'volunteer_photo') {
    // A volunteer's profile photo is visible to the donor/NGO of a donation they are actively handling.
    const active = await db.find(C.donations, { volunteerId: f.ownerId });
    ok = active.some((d) => (d.donorId === req.user.id || d.ngoId === req.user.id) && !donations.TERMINAL.includes(d.status));
  }
  if (!ok) throw forbidden();
  res.set({ 'Content-Type': f.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
  res.send(Buffer.from(f.data, 'base64'));
});

// ---- complaints
router.post('/complaints', requireActive, async (req, res) => res.status(201).json(await complaints.create(req.user, req.body || {})));
router.get('/complaints/mine', async (req, res) => res.json({ complaints: await complaints.listMine(req.user) }));

// ---- donations (shared)
router.get('/donations/:id', async (req, res) => res.json(await views.detail(req.user, req.params.id)));
router.post('/donations/:id/cancel', async (req, res) => {
  if (!['donor', 'admin'].includes(req.user.role)) throw forbidden();
  await donations.cancel(req.user, req.params.id, req.body?.reason);
  done(res);
});
router.post('/donations/:id/otp/regenerate', otpLimiter, async (req, res) => {
  const d = await getDb().get(C.donations, req.params.id);
  if (!d) throw notFound('Donation');
  const stage = req.user.role === 'donor' ? 'pickup' : 'delivery';
  res.json(await otp.regenerate(req.params.id, stage, req.user));
});
router.post('/donations/:id/reject-unsafe', requireRole('volunteer', 'ngo'), requireActive, async (req, res) => done(res, await donations.rejectUnsafe(req.user, req.params.id, req.body || {})));

// ---- donor
router.post('/donations', ...donor, async (req, res) => { const d = await donations.create(req.user, req.body || {}); analytics.invalidate(); res.status(201).json({ id: d.id, status: d.status, safety: d.safety }); });
router.get('/donor/donations', requireRole('donor'), async (req, res) => res.json({ donations: await views.donorList(req.user) }));
router.get('/donations/:id/certificate', requireRole('donor', 'admin'), async (req, res) => reports.donorCertificate(res, req.user, req.params.id));

// ---- NGO
router.get('/ngo/board', requireRole('ngo'), async (req, res) => res.json(await views.ngoBoard(req.user)));
router.post('/donations/:id/offer/:decision', oneOf('decision', ['accept', 'decline']), ...ngo, async (req, res) => done(res, await donations.respondToOffer(req.user, req.params.id, { accept: req.params.decision === 'accept', reason: req.body?.reason })));
router.post('/donations/:id/request', ...ngo, async (req, res) => done(res, await donations.ngoRequest(req.user, req.params.id, req.body?.note)));
router.post('/donations/:id/release', ...ngo, async (req, res) => done(res, await donations.ngoRelease(req.user, req.params.id, req.body?.reason)));
router.post('/donations/:id/receive', ...ngo, otpLimiter, async (req, res) => done(res, await donations.confirmReceipt(req.user, req.params.id, req.body || {})));
router.post('/donations/:id/distribution', ...ngo, async (req, res) => done(res, await donations.recordDistribution(req.user, req.params.id, req.body || {})));
router.get('/ngo/impact', requireRole('ngo'), async (req, res) => res.json(await reports.ngoImpact(req.user, req.query.month)));
router.get('/ngo/impact.pdf', requireRole('ngo'), async (req, res) => reports.ngoImpactPdf(res, req.user, req.query.month));

// ---- volunteer
router.get('/volunteer/board', requireRole('volunteer'), async (req, res) => res.json(await views.volunteerBoard(req.user)));
router.post('/donations/:id/interest', ...vol, async (req, res) => done(res, await donations.volunteerInterest(req.user, req.params.id)));
router.post('/donations/:id/assignment/:decision', oneOf('decision', ['accept', 'decline']), ...vol, async (req, res) => done(res, await donations.respondToAssignment(req.user, req.params.id, { accept: req.params.decision === 'accept', reason: req.body?.reason })));
router.post('/donations/:id/pickup', ...vol, otpLimiter, async (req, res) => done(res, await donations.confirmPickup(req.user, req.params.id, req.body || {})));
router.post('/donations/:id/deliver', ...vol, async (req, res) => done(res, await donations.markDelivered(req.user, req.params.id, req.body || {})));

module.exports = router;
