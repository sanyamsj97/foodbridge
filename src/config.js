'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

function secret(name) {
  if (env[name]) return env[name];
  if (isProd) throw new Error(`Missing required environment variable ${name} in production`);
  // Dev/test only: random per-process secret (sessions reset on restart).
  return crypto.randomBytes(32).toString('hex');
}

const config = {
  isProd,
  isTest,
  port: Number(env.PORT || 3000),
  appUrl: env.APP_URL || 'http://localhost:3000',
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  dbDriver: env.DB_DRIVER || (isTest ? 'memory' : 'firestore'),
  devDbFile: env.DEV_DB_FILE || '',
  firebase: {
    serviceAccountPath: env.FIREBASE_SERVICE_ACCOUNT_PATH || '',
    serviceAccountBase64: env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '',
    projectId: env.FIREBASE_PROJECT_ID || '',
    // Optional – Firebase Cloud Messaging (web push). All free on Spark.
    web: {
      apiKey: env.FIREBASE_WEB_API_KEY || '',
      authDomain: env.FIREBASE_WEB_AUTH_DOMAIN || '',
      projectId: env.FIREBASE_PROJECT_ID || '',
      messagingSenderId: env.FIREBASE_WEB_MESSAGING_SENDER_ID || '',
      appId: env.FIREBASE_WEB_APP_ID || '',
    },
    vapidKey: env.FIREBASE_WEB_VAPID_KEY || '',
  },
  jwt: {
    accessSecret: secret('JWT_ACCESS_SECRET'),
    accessTtl: env.JWT_ACCESS_TTL || '15m',
    refreshTtlDays: Number(env.REFRESH_TTL_DAYS || 7),
  },
  otpKey: crypto.createHash('sha256').update(secret('OTP_ENCRYPTION_KEY')).digest(),
  adminIpAllowlist: (env.ADMIN_IP_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
  bcryptRounds: isTest ? 4 : 12,
  maxFileBytes: 700 * 1024, // Firestore document limit is 1 MiB; base64 adds ~33%.
  sweepIntervalMs: Number(env.SWEEP_INTERVAL_MS || 5 * 60 * 1000),
};

if (isProd && config.dbDriver !== 'firestore') {
  throw new Error('DB_DRIVER must be "firestore" in production');
}

module.exports = config;
