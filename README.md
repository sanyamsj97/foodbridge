# FoodBridge – Food Rescue & Donation Management System

FoodBridge connects **food donors** (college messes, hostels, hotels, restaurants, event organisers), **verified volunteers** and **verified NGOs**, supervised by a **Super Admin**. Surplus edible food is listed, verified, matched to a nearby NGO, picked up and delivered with photo + GPS proof and **two-stage OTP handovers**, then distributed. A donation is only marked *completed* when every mandatory verification has passed.

**Stack:** Node.js 20+ · Express 5 · Cloud Firestore (works on the free Firebase **Spark** plan) · vanilla-JS single-page web app (no build step) · Leaflet + OpenStreetMap maps (free, no API key) · optional Firebase Cloud Messaging web push.

## Quick start (local, no Firebase needed)

```bash
npm install
npm test                                   # full workflow + safety tests (in-memory DB)

# Local dev server with an in-memory DB persisted to data/dev-db.json
set DB_DRIVER=memory&& set DEV_DB_FILE=data/dev-db.json&& node scripts/create-test-accounts.js
set DB_DRIVER=memory&& set DEV_DB_FILE=data/dev-db.json&& npm start
# macOS/Linux: DB_DRIVER=memory DEV_DB_FILE=data/dev-db.json npm start
```

Open http://localhost:3000. Separate sign-in screens: `/#/login/admin`, `/#/login/donor`, `/#/login/volunteer`, `/#/login/ngo`.

> GPS capture in the browser needs `localhost` or HTTPS.

## Production (Firebase Spark – free)

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. In short: create a Firebase project, enable Firestore, download a service-account key, set `.env` from `.env.example`, deploy rules/indexes, run `npm run create-admin`, host the Node server (any Node host; free options listed in the guide).

## Test accounts

There are **no hardcoded credentials**. Run `npm run create-test-accounts` against a dev/staging database: it creates one verified account per role (`admin@`, `donor@`, `volunteer@`, `ngo@foodbridge.test`) with **randomly generated passwords printed once**. The script refuses to run when `NODE_ENV=production`.

Real admins are created only with `npm run create-admin` (CLI). There is no admin sign-up page or endpoint.

## Documentation

| Document | Contents |
|---|---|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Installation, Firebase setup, environment, hosting, going live |
| [docs/API.md](docs/API.md) | REST API reference |
| [docs/DATABASE.md](docs/DATABASE.md) | Firestore collections (the required "tables"), fields, relationships, status machine |
| [docs/TESTING.md](docs/TESTING.md) | Automated tests and the manual end-to-end test script |
| [docs/SECURITY.md](docs/SECURITY.md) | Security & privacy controls, food-safety rules |

## Project structure

```
src/
  server.js, app.js, config.js
  db/            Firestore + in-memory adapters (same interface)
  lib/           safety rules engine, OTP crypto, file validation, audit, notifications
  services/      auth, users, donations (workflow state machine), otp, views, analytics, reports, complaints, settings
  routes/        auth, admin, app (donor / NGO / volunteer / shared)
  middleware/    JWT auth, RBAC
public/          web app (index.html, css, js/pages/*), FCM service worker
scripts/         create-admin, create-test-accounts
firebase/        firestore.rules (deny all client access), firestore.indexes.json
tests/           workflow.test.js (full 13-step flow), safety.test.js
```

## Workflow (enforced server-side)

`pending_review → approved → ngo_accepted → volunteer_assigned → in_pickup → picked_up → awaiting_receipt → received → distributed → completed`
Terminal alternatives: `rejected`, `cancelled`, `expired`, `unsafe_rejected`. Each transition checks the actor, the current status and food safety inside a database transaction, and writes an audit log entry.

## Design decisions (Spark plan)

| Requirement | How it is met for free |
|---|---|
| PostgreSQL | Replaced by **Cloud Firestore** (Spark free tier). Collections mirror the 15 required tables; see DATABASE.md. |
| Cloud storage for photos/docs | Cloud Storage requires the paid Blaze plan for new projects, so images are **compressed in the browser** (≤ 650 KB) and stored in a server-only `files` collection with access checks. |
| SMS OTP | SMS gateways are paid. OTPs are shown **in-app to the holder** (donor for pickup, volunteer for delivery) and read out at the physical handover, which is the handover model the spec describes. Codes are encrypted at rest, expire, are single-use and attempt-limited. An SMS provider can be plugged into `services/otp.js` later. |
| Google Maps | Leaflet + OpenStreetMap for maps; "Navigate" opens Google Maps directions via a public URL (no API key or billing). |
| Push notifications | In-app notifications always; FCM web push optional (free). |
| Android APK | Not produced; this is a responsive web app (works in mobile browsers). |
