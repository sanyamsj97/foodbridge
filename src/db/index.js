'use strict';
const config = require('../config');

let db;
function getDb() {
  if (db) return db;
  if (config.dbDriver === 'memory') {
    const MemoryDB = require('./memory');
    db = new MemoryDB({ file: config.devDbFile || undefined });
  } else {
    const FirestoreDB = require('./firestore');
    db = new FirestoreDB(config.firebase);
  }
  return db;
}
function setDb(instance) { db = instance; }

// Collection names mirror the required relational tables.
const C = {
  users: 'users',
  userEmails: 'user_emails',
  refreshTokens: 'refresh_tokens',
  donors: 'donors',
  volunteers: 'volunteers',
  ngos: 'ngos',
  ngoDocuments: 'ngo_documents',
  files: 'files',
  donations: 'food_donations',
  donationRequests: 'donation_requests',
  assignments: 'volunteer_assignments',
  pickups: 'pickup_verifications',
  deliveries: 'delivery_verifications',
  safetyChecks: 'food_safety_checks',
  distributions: 'distribution_records',
  notifications: 'notifications',
  complaints: 'complaints',
  auditLogs: 'audit_logs',
  otps: 'otp_codes',
  settings: 'settings',
  pushTokens: 'push_tokens',
};

module.exports = { getDb, setDb, C };
