# Installation & Deployment

## 1. Prerequisites

- Node.js 20 or newer
- A Google account (for Firebase – the free **Spark** plan is enough)
- Optional: Firebase CLI (`npm i -g firebase-tools`) to deploy rules and indexes

## 2. Create the Firebase project (free)

1. Go to https://console.firebase.google.com → **Add project**. Stay on the **Spark** plan.
2. **Build → Firestore Database → Create database** → *Production mode* → pick a region close to your users (e.g. `asia-south1` for India).
3. **Project settings → Service accounts → Generate new private key**. Save the JSON as `serviceAccount.json` in the project root. **Never commit this file** (it is in `.gitignore`).
4. Deploy the security rules and indexes:
   ```bash
   firebase login
   firebase use --add          # select your project
   firebase deploy --only firestore:rules,firestore:indexes
   ```
   The rules deny all direct client access; only the Node server (Admin SDK) reads and writes data. You can also paste `firebase/firestore.rules` into the console and create the indexes listed in `firebase/firestore.indexes.json` by hand.

### Optional: web push (FCM)
Project settings → General → **Add web app** (copy `apiKey`, `authDomain`, `messagingSenderId`, `appId`), then Cloud Messaging → **Web Push certificates → Generate key pair** (VAPID key). Put these values in `.env`. Users can then enable push from their Profile page.

## 3. Configure

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # run twice
```
Set `JWT_ACCESS_SECRET` and `OTP_ENCRYPTION_KEY` to the two generated values, then set `FIREBASE_SERVICE_ACCOUNT_PATH` (or `FIREBASE_SERVICE_ACCOUNT_BASE64`) and `FIREBASE_PROJECT_ID`. In production the server refuses to start without these secrets.

> Changing `OTP_ENCRYPTION_KEY` invalidates outstanding OTPs; changing `JWT_ACCESS_SECRET` signs everyone out.

## 4. Install, test, create the first admin

```bash
npm install
npm test
npm run create-admin -- --name "Your Name" --email you@yourorg.org --phone "+91 9xxxxxxxxx"
# password is prompted (or set ADMIN_PASSWORD in the environment for automation)
npm start
```

## 5. Host the Node server

Firebase Hosting on Spark serves only static files, and Cloud Functions require the paid Blaze plan, so run the Node server on any Node host. It talks to Firestore over HTTPS with the service account.

| Option | Notes |
|---|---|
| **Render** (free web service) | New → Web Service → connect repo → Build `npm install`, Start `npm start`. Add env vars from `.env`; use `FIREBASE_SERVICE_ACCOUNT_BASE64` (`base64 -w0 serviceAccount.json`). Set `TRUST_PROXY=1`. Free instances sleep when idle, so the first request is slow. |
| **Railway / Fly.io / Koyeb** | Same env vars; `npm start`. |
| **Your own VPS** | `npm ci --omit=dev`, run with `pm2 start src/server.js --name foodbridge`, put Nginx/Caddy in front with HTTPS (Let's Encrypt), set `TRUST_PROXY=1`. |

Requirements in production:
- **HTTPS is mandatory.** With `NODE_ENV=production` the app redirects HTTP to HTTPS, sets HSTS and marks cookies `Secure`. Browser GPS also requires HTTPS.
- Run a **single instance**, or accept that the 30-second settings cache and 15-second suspension cache are per instance.
- The server sweeps expired donations every 5 minutes (`SWEEP_INTERVAL_MS`).

## 6. Spark plan quotas (free tier)

| Resource | Daily/total free quota | FoodBridge usage |
|---|---|---|
| Firestore reads | 50,000 / day | Dashboards cache analytics for 60 s; boards poll every 60 s |
| Firestore writes | 20,000 / day | ~25–40 writes per completed donation |
| Firestore storage | 1 GiB | Photos are about 80–300 KB each, so roughly 3,000–8,000 photos fit |

If you outgrow the free tier: move file storage to Cloud Storage or a free image CDN (only `src/lib/files.js` and the `/api/files/:id` route change), and/or upgrade to Blaze.

## 7. Go-live checklist

- [ ] `NODE_ENV=production`, strong secrets, HTTPS domain in `APP_URL`
- [ ] Firestore rules deployed (deny-all) and indexes built
- [ ] First admin created with `npm run create-admin`; consider `ADMIN_IP_ALLOWLIST`
- [ ] Test accounts **not** created in the production project
- [ ] Review the safety limits in `src/lib/safety.js` with your food-safety officer (FSSAI guidance)
- [ ] Set the serving-size assumption in Admin → Settings
- [ ] Back up Firestore (console → Import/Export needs Blaze; on Spark, use `gcloud firestore export` on a Blaze trial or periodic scripted exports via the Admin SDK)
