# Security, Privacy & Food Safety

## Authentication & sessions
- Passwords hashed with **bcrypt (12 rounds)**; minimum 10 characters with letters and numbers.
- **JWT access tokens** (15 min, kept in memory in the browser, never in localStorage) plus **rotating refresh tokens** in an `httpOnly`, `SameSite=Strict`, `Secure` (production) cookie limited to `/api/auth`. Refresh tokens are stored as SHA-256 hashes. Reusing a rotated token revokes the whole session family.
- Account **lockout** for 15 minutes after 5 failed logins; generic error messages (no user enumeration); login is portal-specific (an NGO account cannot sign in on the admin screen).
- Suspension or a password change increments `tokenVersion`, which invalidates existing access tokens within about 15 seconds.

## Authorisation (RBAC)
- Every route declares the roles allowed; unverified (`pending`) users can sign in but cannot act.
- Admin accounts can only be created from the CLI; `/api/admin/*` optionally checks `ADMIN_IP_ALLOWLIST`.
- Object-level checks: participants only (donor/NGO/volunteer of that donation). NGOs and volunteers browsing open donations get a **listing view without exact address or contacts**.

## Data protection
- Firestore rules deny all client access; only the server's Admin SDK touches data.
- Identity documents (`sensitivity: identity`) are served only to their owner and admins, with `Cache-Control: no-store`.
- Only the **last 4 digits** of ID numbers (Aadhaar, PAN, etc.) are stored; volunteers are asked to upload a masked Aadhaar.
- Phone numbers of other parties are shown only while a donation is active, and only to the parties involved.
- No bank or payment data is collected.

## OTP handovers
- 6-digit codes from a CSPRNG, **AES-256-GCM encrypted** at rest plus HMAC hash for comparison (timing-safe).
- Shown only to the holder (donor for pickup, volunteer for delivery); entered by the verifier.
- Expiry (default 120 min), **5 wrong attempts** then locked, holder can regenerate (limited), single use, plus per-user rate limiting.
- Pickup and delivery records store date/time, GPS, quantity, photos, user IDs and verification status.

## Integrity
- Every workflow transition runs in a transaction that re-checks the actor and current status, which prevents duplicate claims, double pickups and skipped steps.
- **A donation cannot complete** unless pickup OTP, delivery OTP, pickup/delivery/receiving photos, pickup GPS, safety checks at pickup and receipt, and a distribution record within the safe window all pass.
- Audit log entries for every important action (registration, login, approvals, OTP failures, transitions, settings changes). They cannot be edited from the app.

## Transport & web hardening
- HTTPS redirect + HSTS in production; Helmet security headers; strict Content-Security-Policy (no inline scripts); `frame-ancestors 'none'`.
- Input validation with Zod on every endpoint; uploads checked for type, magic bytes and size; output escaped in the UI.
- Rate limiting on all routes, stricter on auth and OTP endpoints.

## Food-safety rules (`src/lib/safety.js`)
| Storage | Flag after | Reject after | Temperature rule |
|---|---|---|---|
| Room temperature (cooked/dairy/other) | 2 h | 4 h | – |
| Room temperature (bakery) | 12 h | 24 h | – |
| Room temperature (fruit & veg) | 24 h | 48 h | – |
| Hot holding | 4 h | 6 h | < 60 °C → room-temperature limits apply |
| Refrigerated | 24 h | 48 h | > 5 °C flagged; > 8 °C → room-temperature limits |
| Frozen | 14 d | 60 d | > -18 °C flagged; > -10 °C → refrigerated limits |
| Packaged / beverages | expiry < 12 h flagged | past expiry | expiry date required |

Checks run at **submission, admin review, pickup (with measured temperature) and receipt (with measured temperature)**. The pickup deadline may not exceed the safe-until time. Uncollected donations expire automatically. Volunteers and NGOs can reject unsafe food at any handover stage; admin approval alone never allows distribution.

These limits are conservative defaults. Have them reviewed against FSSAI guidance by a qualified food-safety officer before launch.

## Known limitations
- OTPs are shown in-app rather than sent by SMS (SMS is paid). To add SMS, send the code from `services/otp.js#issue` through a provider such as MSG91 or Twilio.
- Government ID verification is manual document review by an admin; DigiLocker / Aadhaar offline e-KYC integration is not included.
- Files live in Firestore (Spark-compatible), which caps total storage at the 1 GiB free tier.
