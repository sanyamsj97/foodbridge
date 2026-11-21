'use strict';
const express = require('express');
const { authenticate, requireRole, adminNetwork, oneOf } = require('../middleware/auth');
const users = require('../services/users');
const donations = require('../services/donations');
const views = require('../services/views');
const analytics = require('../services/analytics');
const complaints = require('../services/complaints');
const reports = require('../services/reports');
const settings = require('../services/settings');
const { getDb, C } = require('../db');
const { bad } = require('../lib/errors');

const router = express.Router();
router.use(adminNetwork, authenticate, requireRole('admin'));

router.get('/dashboard', async (req, res) => res.json(await analytics.dashboard({ fresh: req.query.fresh === '1' })));

router.get('/users', async (req, res) => res.json({ users: await users.list({ role: req.query.role || undefined, status: req.query.status || undefined }) }));
router.get('/users/:id', async (req, res) => res.json(await users.detail(req.params.id)));
router.post('/users/:id/:action', oneOf('action', ['approve', 'reject', 'suspend', 'reactivate']), async (req, res) => {
  const r = await users.setStatus(req.user, req.params.id, req.params.action, req.body?.reason);
  analytics.invalidate();
  res.json(r);
});
router.post('/ngo-documents/:id/review', async (req, res) => res.json(await users.reviewNgoDocument(req.user, req.params.id, req.body || {})));

router.get('/donations', async (req, res) => res.json({ donations: await views.adminList({ status: req.query.status || undefined }) }));
router.post('/donations/:id/review', async (req, res) => { const r = await donations.review(req.user, req.params.id, req.body || {}); analytics.invalidate(); res.json(r); });
router.post('/donations/:id/rematch', async (req, res) => { const r = await donations.matchAndOffer(req.user, req.params.id); res.json({ offeredTo: r.length }); });
router.post('/donations/:id/offer', async (req, res) => { await donations.offerToNgo(req.user, req.params.id, req.body?.ngoId); res.json({ ok: true }); });
router.post('/donations/:id/requests/:ngoId/:decision', oneOf('decision', ['approve', 'decline']), async (req, res) => {
  await donations.decideNgoRequest(req.user, req.params.id, req.params.ngoId, req.params.decision === 'approve', req.body?.reason);
  res.json({ ok: true });
});
router.post('/donations/:id/assign', async (req, res) => {
  if (!req.body?.volunteerId) throw bad('volunteerId is required');
  await donations.assignVolunteer(req.user, req.params.id, req.body.volunteerId);
  res.json({ ok: true });
});
router.post('/donations/:id/unassign', async (req, res) => { await donations.unassignVolunteer(req.user, req.params.id, req.body?.reason); res.json({ ok: true }); });

router.get('/live', async (req, res) => res.json({ donations: await views.liveBoard() }));

router.get('/complaints', async (req, res) => res.json({ complaints: await complaints.listAll({ status: req.query.status || undefined }) }));
router.patch('/complaints/:id', async (req, res) => res.json(await complaints.update(req.user, req.params.id, req.body || {})));

router.get('/reports', async (req, res) => res.json(await reports.adminReport(req.query.period || 'monthly', req.query.date)));
router.get('/reports/export', async (req, res) => {
  const r = await reports.adminReport(req.query.period || 'monthly', req.query.date);
  if (req.query.format === 'xlsx') return reports.reportXlsx(res, r);
  return reports.reportPdf(res, r);
});

router.get('/audit', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const logs = req.query.entityId
    ? await getDb().findOrdered(C.auditLogs, { entityId: req.query.entityId }, 'at', limit)
    : req.query.actorId
      ? await getDb().findOrdered(C.auditLogs, { actorId: req.query.actorId }, 'at', limit)
      : await getDb().recent(C.auditLogs, 'at', limit);
  res.json({ logs });
});
router.get('/audit/export', async (req, res) => reports.auditXlsx(res));

router.get('/settings', async (req, res) => res.json(await settings.get()));
router.put('/settings', async (req, res) => { const s = await settings.update(req.user, req.body || {}); analytics.invalidate(); res.json(s); });

module.exports = router;
