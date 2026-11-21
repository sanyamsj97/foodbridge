'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const auth = require('../services/auth');
const users = require('../services/users');
const { authenticate } = require('../middleware/auth');
const { getDb, C } = require('../db');

const router = express.Router();
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isTest ? 10000 : 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts, please try again later' } });

const COOKIE = 'fb_rt';
const setRefresh = (res, token, expiresAt) => res.cookie(COOKIE, token, { httpOnly: true, secure: config.isProd, sameSite: 'strict', path: '/api/auth', expires: new Date(expiresAt) });
const clearRefresh = (res) => res.clearCookie(COOKIE, { path: '/api/auth' });

router.post('/register/:role', authLimiter, async (req, res) => {
  const user = await auth.register(req.params.role, req.body, req.ip);
  res.status(201).json({ user, message: 'Registration received. An administrator will verify your documents before your account is activated.' });
});

router.post('/login', authLimiter, async (req, res) => {
  const r = await auth.login(req.body, req.ip);
  setRefresh(res, r.refreshToken, r.refreshExpiresAt);
  res.json({ user: r.user, accessToken: r.accessToken });
});

router.post('/refresh', authLimiter, async (req, res) => {
  try {
    const r = await auth.refresh(req.cookies[COOKIE]);
    setRefresh(res, r.refreshToken, r.refreshExpiresAt);
    res.json({ user: r.user, accessToken: r.accessToken });
  } catch (e) { clearRefresh(res); throw e; }
});

router.post('/logout', async (req, res) => {
  await auth.logout(req.cookies[COOKIE]);
  clearRefresh(res);
  res.json({ ok: true });
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.user, profile: await users.getProfile(req.user) });
});

router.patch('/me/profile', authenticate, async (req, res) => {
  res.json({ profile: await users.updateOwnProfile(req.user, req.body) });
});

router.post('/me/password', authenticate, async (req, res) => {
  await auth.changePassword(req.user, req.body);
  clearRefresh(res);
  res.json({ ok: true, message: 'Password changed. Please sign in again.' });
});

router.post('/me/push-token', authenticate, async (req, res) => {
  const token = String(req.body?.token || '').slice(0, 4096);
  if (token) await getDb().set(C.pushTokens, require('crypto').createHash('sha256').update(token).digest('hex'), { userId: req.user.id, token, createdAt: new Date().toISOString() });
  res.json({ ok: true });
});

module.exports = router;
