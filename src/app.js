'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { AppError } = require('./lib/errors');
const analytics = require('./services/analytics');
const { CATEGORY, STORAGE } = require('./lib/safety');
const { ORG_TYPES, ID_TYPES, VEHICLES } = require('./services/auth');
const { TYPES: COMPLAINT_TYPES } = require('./services/complaints');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  if (config.isProd) {
    app.use((req, res, next) => (req.secure || req.headers['x-forwarded-proto'] === 'https' ? next() : res.redirect(301, `https://${req.headers.host}${req.originalUrl}`)));
  }
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://unpkg.com', 'https://www.gstatic.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://unpkg.com'],
        connectSrc: ["'self'", 'https://*.googleapis.com', 'https://www.gstatic.com'],
        workerSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    hsts: config.isProd,
  }));
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isTest ? 100000 : 1500, standardHeaders: 'draft-7', legacyHeaders: false }));
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true, db: config.dbDriver }));
  app.get('/api/public/stats', async (req, res) => res.json(await analytics.publicStats()));
  app.get('/api/public/config', (req, res) => {
    const fcm = config.firebase.web.apiKey && config.firebase.vapidKey ? { firebase: config.firebase.web, vapidKey: config.firebase.vapidKey } : null;
    res.json({
      fcm,
      enums: {
        categories: Object.fromEntries(Object.entries(CATEGORY).map(([k, v]) => [k, v.label])),
        storage: Object.fromEntries(Object.entries(STORAGE).map(([k, v]) => [k, v.label])),
        orgTypes: ORG_TYPES, idTypes: ID_TYPES, vehicles: VEHICLES, complaintTypes: COMPLAINT_TYPES,
      },
    });
  });
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api', require('./routes/app'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: config.isProd ? '1h' : 0 }));
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(__dirname, '..', 'public', 'index.html')) : next()));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload too large. Use fewer or smaller photos.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    if (err.code === 10 || err.code === 'ABORTED') return res.status(409).json({ error: 'The record was changed by someone else. Please retry.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}

module.exports = { createApp };
