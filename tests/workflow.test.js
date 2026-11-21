'use strict';
// End-to-end test of the mandatory donation workflow (Section 13), using the in-memory DB driver.
process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'memory';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { createAdmin } = require('../src/services/auth');
const { getDb, C } = require('../src/db');

const app = createApp();
const JPG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(64).fill(1)]).toString('base64')}`;
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test document').toString('base64')}`;
const PW = 'Passw0rd!123';
const hours = (h) => new Date(Date.now() + h * 3600000).toISOString();

const base = (name, email, lat, lng) => ({ name, email, password: PW, phone: '+91 98765 43210', address: '12 Test Street, Sector 5', city: 'Jaipur', area: 'Malviya Nagar', location: { lat, lng } });
const donorBody = { ...base('Mess Manager', 'donor@test.local', 26.85, 75.80), orgName: 'MNIT Hostel Mess', orgType: 'college_mess', idType: 'gst', idNumber: '08ABCDE1234F1Z5', idDocument: PDF };
const volBody = { ...base('Ravi Volunteer', 'vol@test.local', 26.86, 75.81), govIdType: 'aadhaar', govIdNumber: '1234 5678 9012', vehicleType: 'two_wheeler', idDocument: JPG, profilePhoto: JPG };
const ngoBody = { ...base('Asha Rep', 'ngo@test.local', 26.87, 75.82), registeredName: 'Asha Food Trust', registrationNumber: 'RJ/2015/0012345', pan: 'AAATA1234A', operatingArea: 'South Jaipur', repDesignation: 'Secretary', fcraApplicable: false, capacityKg: 200, acceptsNonVeg: true, registrationCertificate: PDF, orgPhotos: [JPG] };

async function login(email, portal) {
  const r = await request(app).post('/api/auth/login').send({ email, password: PW, portal });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body.accessToken, cookie: r.headers['set-cookie'], user: r.body.user };
}
const as = (s) => ({
  get: (u) => request(app).get(u).set('Authorization', `Bearer ${s.token}`),
  post: (u, b = {}) => request(app).post(u).set('Authorization', `Bearer ${s.token}`).send(b),
});

test('complete donation workflow: register → verify → donate → match → pickup OTP → delivery OTP → distribute → complete', async () => {
  // Admin is created out-of-band (CLI) – never through a public endpoint.
  await createAdmin({ name: 'Super Admin', email: 'admin@test.local', phone: '+91 90000 00000', password: PW });
  const admin = as(await login('admin@test.local', 'admin'));

  // Registrations
  for (const [role, body] of [['donor', donorBody], ['volunteer', volBody], ['ngo', ngoBody]]) {
    const r = await request(app).post(`/api/auth/register/${role}`).send(body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.user.status, 'pending');
  }
  const dup = await request(app).post('/api/auth/register/donor').send(donorBody);
  assert.equal(dup.status, 409, 'duplicate email rejected');
  const adminReg = await request(app).post('/api/auth/register/admin').send(donorBody);
  assert.equal(adminReg.status, 403, 'admin self-registration impossible');

  // Wrong portal is rejected
  const wrongPortal = await request(app).post('/api/auth/login').send({ email: 'donor@test.local', password: PW, portal: 'admin' });
  assert.equal(wrongPortal.status, 401);

  // Pending donor cannot create donations
  const donorPending = as(await login('donor@test.local', 'donor'));
  const early = await donorPending.post('/api/donations', {});
  assert.equal(early.status, 403);

  // Admin approves donor + volunteer, verifies NGO documents, then approves NGO
  const { body: { users } } = await admin.get('/api/admin/users?status=pending');
  const id = (email) => users.find((u) => u.email === email).id;
  assert.equal((await admin.post(`/api/admin/users/${id('donor@test.local')}/approve`)).status, 200);
  assert.equal((await admin.post(`/api/admin/users/${id('vol@test.local')}/approve`)).status, 200);
  const ngoId = id('ngo@test.local');
  const blocked = await admin.post(`/api/admin/users/${ngoId}/approve`);
  assert.equal(blocked.status, 409, 'NGO cannot be approved before documents are verified');
  const ngoDetail = (await admin.get(`/api/admin/users/${ngoId}`)).body;
  for (const doc of ngoDetail.documents) {
    assert.equal((await admin.post(`/api/admin/ngo-documents/${doc.id}/review`, { status: 'verified' })).status, 200);
  }
  assert.equal((await admin.post(`/api/admin/users/${ngoId}/approve`)).status, 200);

  const donor = as(await login('donor@test.local', 'donor'));
  const vol = as(await login('vol@test.local', 'volunteer'));
  const ngo = as(await login('ngo@test.local', 'ngo'));

  // Unsafe food is blocked at submission (room-temperature cooked food prepared 5 hours ago)
  const food = {
    foodName: 'Veg Pulao & Dal', category: 'cooked_meal', quantityKg: 25, vegType: 'veg', storage: 'hot_holding', tempC: 68,
    preparedAt: hours(-0.5), pickupDeadline: hours(3), allergens: ['dairy'], handlingInstructions: 'Keep covered, transport in insulated containers',
    pickup: { address: 'MNIT Hostel Mess, JLN Marg', city: 'Jaipur', area: 'Malviya Nagar', lat: 26.85, lng: 75.80 }, photos: [JPG],
  };
  const unsafe = await donor.post('/api/donations', { ...food, storage: 'room_temp', tempC: '', preparedAt: hours(-5), pickupDeadline: hours(1) });
  assert.equal(unsafe.status, 422, 'expired food blocked');
  const noPhoto = await donor.post('/api/donations', { ...food, photos: [] });
  assert.equal(noPhoto.status, 400, 'photos are mandatory');

  // STEP 1 – donor creates request
  const created = await donor.post('/api/donations', food);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const did = created.body.id;
  assert.equal(created.body.status, 'pending_review');

  // NGO cannot see it before admin verification
  assert.equal((await ngo.get(`/api/donations/${did}`)).status, 403);

  // STEP 2 + 3 – admin verifies; system matches nearby verified NGO
  const reviewed = await admin.post(`/api/admin/donations/${did}/review`, { decision: 'approve', notes: 'Photos and temps OK' });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.offeredTo, 1);

  // Volunteer cannot be assigned before an NGO accepts
  const volId = (await vol.get('/api/auth/me')).body.user.id;
  assert.equal((await admin.post(`/api/admin/donations/${did}/assign`, { volunteerId: volId })).status, 409);

  // STEP 4 – NGO gets the request and accepts; duplicate claim rejected
  const board = (await ngo.get('/api/ngo/board')).body;
  assert.equal(board.offers.length, 1);
  assert.equal((await ngo.post(`/api/donations/${did}/offer/accept`)).status, 200);
  assert.equal((await ngo.post(`/api/donations/${did}/offer/accept`)).status, 409, 'cannot claim twice');

  // STEP 5 – admin assigns volunteer, volunteer accepts
  const adminView = (await admin.get(`/api/donations/${did}`)).body;
  assert.equal(adminView.volunteerCandidates[0].volunteerId, volId);
  assert.equal((await admin.post(`/api/admin/donations/${did}/assign`, { volunteerId: volId })).status, 200);
  assert.equal((await vol.post(`/api/donations/${did}/assignment/accept`)).status, 200);

  // Distribution cannot be recorded out of order
  assert.equal((await ngo.post(`/api/donations/${did}/distribution`, { distributedAt: hours(0), peopleServed: 10, distributedKg: 5, location: 'Shelter home' })).status, 409);

  // STEP 6 – pickup with donor's OTP
  const donorView = (await donor.get(`/api/donations/${did}`)).body;
  const pickupOtp = donorView.otp.code;
  assert.match(pickupOtp, /^\d{6}$/);
  const pickup = { quantityKg: 24, conditionOk: true, tempC: 66, notes: 'Hot and sealed', photos: [JPG], gps: { lat: 26.8501, lng: 75.8002, accuracy: 12 } };
  const wrong = await vol.post(`/api/donations/${did}/pickup`, { ...pickup, otp: pickupOtp === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /Incorrect OTP\. 4 attempt/);
  const picked = await vol.post(`/api/donations/${did}/pickup`, { ...pickup, otp: pickupOtp });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  const replay = await vol.post(`/api/donations/${did}/pickup`, { ...pickup, otp: pickupOtp });
  assert.equal(replay.status, 409, 'pickup OTP is single-use');

  // STEP 7 – transport and delivery proof
  const volView = (await vol.get(`/api/donations/${did}`)).body;
  const deliveryOtp = volView.otp.code;
  assert.match(deliveryOtp, /^\d{6}$/);
  // NGO cannot confirm before volunteer records delivery
  assert.equal((await ngo.post(`/api/donations/${did}/receive`, { otp: deliveryOtp, receivedKg: 24, conditionOk: true, tempC: 63, photos: [JPG] })).status, 409);
  const delivered = await vol.post(`/api/donations/${did}/deliver`, { photos: [JPG], gps: { lat: 26.8701, lng: 75.8201 }, notes: 'Handed to kitchen' });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));

  // STEP 8 – NGO verifies receipt with delivery OTP
  const received = await ngo.post(`/api/donations/${did}/receive`, { otp: deliveryOtp, receivedKg: 24, conditionOk: true, tempC: 63, photos: [JPG], notes: 'Good condition' });
  assert.equal(received.status, 200, JSON.stringify(received.body));

  // STEP 9 – distribution; cannot exceed received quantity
  assert.equal((await ngo.post(`/api/donations/${did}/distribution`, { distributedAt: new Date().toISOString(), peopleServed: 60, distributedKg: 30, location: 'Shelter' })).status, 400);
  const dist = await ngo.post(`/api/donations/${did}/distribution`, { distributedAt: new Date().toISOString(), peopleServed: 60, distributedKg: 24, location: 'Night shelter, Sanganer', beneficiaryGroup: 'Homeless families', photos: [JPG] });
  assert.equal(dist.status, 200, JSON.stringify(dist.body));
  assert.equal(dist.body.status, 'completed');

  // STEP 10 – admin sees the completed record with every proof
  const final = (await admin.get(`/api/donations/${did}`)).body;
  assert.equal(final.donation.status, 'completed');
  const c = final.donation.completion;
  assert.equal(c.quantityKgReceived, 24);
  assert.equal(c.peopleServed, 60);
  assert.ok(c.pickupOtpVerifiedAt && c.deliveryOtpVerifiedAt && c.pickupGps && c.deliveryGps);
  assert.equal(c.estimatedMeals, 60); // 24 kg / 0.4 kg
  assert.deepEqual(final.timeline.map((t) => t.status), ['pending_review', 'approved', 'ngo_accepted', 'volunteer_assigned', 'in_pickup', 'picked_up', 'awaiting_receipt', 'received', 'distributed', 'completed']);
  assert.ok(final.audit.length >= 9);

  const dash = (await admin.get('/api/admin/dashboard?fresh=1')).body;
  assert.equal(dash.successfulDonations, 1);
  assert.equal(dash.totalDeliveredKg, 24);
  assert.equal(dash.verifiedNgos, 1);

  // Outputs: certificate, reports, impact
  const cert = await donor.get(`/api/donations/${did}/certificate`);
  assert.equal(cert.status, 200);
  assert.equal(cert.headers['content-type'], 'application/pdf');
  assert.equal((await admin.get('/api/admin/reports/export?period=monthly&format=xlsx')).status, 200);
  assert.equal((await admin.get('/api/admin/reports/export?period=yearly&format=pdf')).status, 200);
  const month = new Date().toISOString().slice(0, 7);
  const impact = (await ngo.get(`/api/ngo/impact?month=${month}`)).body;
  assert.equal(impact.peopleServed, 60);

  // Privacy: volunteer's identity document is not visible to the NGO, only to admin/owner
  const volProfile = (await vol.get('/api/auth/me')).body.profile;
  assert.equal((await ngo.get(`/api/files/${volProfile.idDocFileId}`)).status, 403);
  assert.equal((await admin.get(`/api/files/${volProfile.idDocFileId}`)).status, 200);
  assert.ok(!JSON.stringify(volProfile).includes('9012 '), 'full ID number is never stored');
  assert.equal(volProfile.govIdNumberMasked, 'XXXXXXXX9012');
});

test('OTP lockout after max attempts, suspension blocks access, refresh rotation', async () => {
  const db = getDb();
  const admin = as(await login('admin@test.local', 'admin'));
  const donor = as(await login('donor@test.local', 'donor'));
  const vol = as(await login('vol@test.local', 'volunteer'));
  const ngo = as(await login('ngo@test.local', 'ngo'));
  const volId = (await vol.get('/api/auth/me')).body.user.id;

  const r = await donor.post('/api/donations', {
    foodName: 'Bread loaves', category: 'bakery', quantityKg: 5, vegType: 'veg', storage: 'room_temp', preparedAt: hours(-1), pickupDeadline: hours(6),
    handlingInstructions: 'Keep dry', pickup: { address: 'MNIT Hostel Mess, JLN Marg', city: 'Jaipur', area: 'Malviya Nagar', lat: 26.85, lng: 75.80 }, photos: [JPG],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const did = r.body.id;
  await admin.post(`/api/admin/donations/${did}/review`, { decision: 'approve' });
  await ngo.post(`/api/donations/${did}/offer/accept`);
  await admin.post(`/api/admin/donations/${did}/assign`, { volunteerId: volId });
  await vol.post(`/api/donations/${did}/assignment/accept`);
  const code = (await donor.get(`/api/donations/${did}`)).body.otp.code;
  const bad = code === '000000' ? '111111' : '000000';
  const body = { quantityKg: 5, conditionOk: true, photos: [JPG], gps: { lat: 26.85, lng: 75.80 } };
  for (let i = 0; i < 5; i += 1) assert.equal((await vol.post(`/api/donations/${did}/pickup`, { ...body, otp: bad })).status, 400);
  const locked = await vol.post(`/api/donations/${did}/pickup`, { ...body, otp: code });
  assert.equal(locked.status, 400);
  assert.match(locked.body.error, /Too many wrong attempts/);
  // Holder regenerates, new code works
  const regen = await donor.post(`/api/donations/${did}/otp/regenerate`);
  assert.equal(regen.status, 200);
  assert.equal((await vol.post(`/api/donations/${did}/pickup`, { ...body, otp: regen.body.code })).status, 200);

  // Volunteer reports unsafe food in transit – donation can never complete
  const rej = await vol.post(`/api/donations/${did}/reject-unsafe`, { reason: 'Bread became wet and mouldy in rain' });
  assert.equal(rej.status, 200);
  assert.equal((await admin.get(`/api/donations/${did}`)).body.donation.status, 'unsafe_rejected');

  // Refresh token rotation + reuse detection
  const s = await login('donor@test.local', 'donor');
  const r1 = await request(app).post('/api/auth/refresh').set('Cookie', s.cookie);
  assert.equal(r1.status, 200);
  const r2 = await request(app).post('/api/auth/refresh').set('Cookie', s.cookie);
  assert.equal(r2.status, 401, 'reused refresh token rejected');

  // Suspension takes effect immediately
  const donorId = (await donor.get('/api/auth/me')).body.user.id;
  assert.equal((await admin.post(`/api/admin/users/${donorId}/suspend`, { reason: 'Fraudulent listings' })).status, 200);
  assert.equal((await donor.get('/api/donor/donations')).status, 401);
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'donor@test.local', password: PW, portal: 'donor' })).status, 403);
  const logs = await db.recent(C.auditLogs, 'at', 500);
  assert.ok(logs.some((l) => l.action === 'user.suspend'));
});
