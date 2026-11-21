#!/usr/bin/env node
'use strict';
// Creates one verified test account per role for staging / demo / QA.
// Passwords are randomly generated and printed once (never hardcoded).
// Refuses to run when NODE_ENV=production unless --allow-production is passed explicitly.
const crypto = require('crypto');
const config = require('../src/config');
const auth = require('../src/services/auth');
const users = require('../src/services/users');
const { getDb, C } = require('../src/db');

if (config.isProd && !process.argv.includes('--allow-production')) {
  console.error('Refusing to create test accounts in production. Pass --allow-production only for a staging project.');
  process.exit(1);
}

const domain = process.env.TEST_ACCOUNT_DOMAIN || 'foodbridge.test';
const pw = () => `${crypto.randomBytes(9).toString('base64url')}7a`;
// Minimal placeholder files clearly marked as test documents.
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n% FoodBridge TEST DOCUMENT - not a real identity document\n').toString('base64')}`;
// 1x1 valid PNG placeholder (replace with real photos when testing manually).
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const loc = (lat, lng) => ({ address: 'Test address, Sector 1', city: 'Jaipur', area: 'Malviya Nagar', location: { lat, lng } });
const system = { id: 'cli', role: 'admin', name: 'Test-account script' };

(async () => {
  const out = [];
  const make = async (role, body) => {
    const email = `${role}@${domain}`;
    if (await getDb().get(C.userEmails, email)) { out.push([role, email, '(already exists – unchanged)']); return; }
    const password = pw();
    if (role === 'admin') {
      await auth.createAdmin({ name: 'Test Admin', email, phone: '+91 90000 00001', password });
    } else {
      const u = await auth.register(role, { ...body, email, password, phone: '+91 90000 00002' }, '127.0.0.1');
      if (role === 'ngo') {
        for (const d of await getDb().find(C.ngoDocuments, { ngoId: u.id })) await users.reviewNgoDocument(system, d.id, { status: 'verified', note: 'Test account' });
      }
      await users.setStatus(system, u.id, 'approve');
    }
    out.push([role, email, password]);
  };
  if (process.argv.includes('--with-admin')) await make('admin'); // admins normally come from npm run create-admin
  await make('donor', { name: 'Test Donor', orgName: 'Test College Mess', orgType: 'college_mess', idType: 'gst', idNumber: 'TEST00001234', idDocument: PDF, ...loc(26.8505, 75.8047) });
  await make('volunteer', { name: 'Test Volunteer', govIdType: 'driving_licence', govIdNumber: 'TESTDL5678', vehicleType: 'two_wheeler', idDocument: IMG, profilePhoto: IMG, ...loc(26.8550, 75.8100) });
  await make('ngo', { name: 'Test NGO Rep', registeredName: 'Test Food Relief Trust', registrationNumber: 'TEST/REG/0001', operatingArea: 'Jaipur', repDesignation: 'Coordinator', fcraApplicable: false, capacityKg: 300, acceptsNonVeg: true, registrationCertificate: PDF, orgPhotos: [IMG], ...loc(26.8600, 75.8150) });
  console.log('\nTest accounts (store these securely – passwords are shown only once):\n');
  console.table(out.map(([role, email, password]) => ({ role, email, password, portal: `/#/login/${role}` })));
  process.exit(0);
})().catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
