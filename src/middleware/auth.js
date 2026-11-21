'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb, C } = require('../db');
const { unauthorized, forbidden } = require('../lib/errors');

// Small per-process cache so suspended users are blocked quickly without a read on every request.
const cache = new Map();
const TTL = 15 * 1000;
const invalidateUser = (id) => cache.delete(id);

async function loadUser(id) {
  const hit = cache.get(id);
  if (hit && hit.exp > Date.now()) return hit.user;
  const user = await getDb().get(C.users, id);
  cache.set(id, { user, exp: Date.now() + TTL });
  return user;
}

async function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(unauthorized());
  let payload;
  try { payload = jwt.verify(token, config.jwt.accessSecret, { issuer: 'foodbridge' }); } catch { return next(unauthorized('Session expired')); }
  const u = await loadUser(payload.sub);
  if (!u || (u.tokenVersion || 0) !== payload.tv) return next(unauthorized('Session expired'));
  if (['suspended', 'rejected'].includes(u.status)) return next(forbidden('Account is not active'));
  req.user = { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, status: u.status, ip: req.ip };
  next();
}

const requireRole = (...roles) => (req, res, next) => (roles.includes(req.user?.role) ? next() : next(forbidden()));
const requireActive = (req, res, next) => (req.user?.status === 'active' ? next() : next(forbidden('Your account is awaiting admin verification')));
const adminNetwork = (req, res, next) => {
  if (config.adminIpAllowlist.length && !config.adminIpAllowlist.includes(req.ip)) return next(forbidden('Admin access is not permitted from this network'));
  next();
};

module.exports = { authenticate, requireRole, requireActive, adminNetwork, invalidateUser };

/** Restrict a route param to a fixed set of values (Express 5 has no inline regex params). */
const oneOf = (param, values) => (req, res, next) => (values.includes(req.params[param]) ? next() : res.status(404).json({ error: 'Not found' }));
module.exports.oneOf = oneOf;
