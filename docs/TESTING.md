# Testing

## Automated tests

```bash
npm test
```

Runs against the in-memory database driver (same interface as Firestore), so no Firebase project is needed.

**`tests/workflow.test.js`** covers the mandatory end-to-end flow from section 13 through the real HTTP API:

1. Donor, volunteer and NGO register (status `pending`); duplicate email → 409; admin self-registration → 403; wrong portal login → 401
2. A pending donor cannot create donations (403)
3. Admin approves donor and volunteer; **NGO approval is blocked until its documents are verified** (409), then approved
4. Unsafe food (cooked, 5 h at room temperature) → 422; missing photos → 400
5. Donor creates the request → `pending_review`; NGO cannot see it yet (403)
6. Admin verifies → automatic NGO matching (1 offer)
7. Volunteer cannot be assigned before NGO acceptance (409)
8. NGO accepts; a **second accept is rejected** (duplicate-claim protection)
9. Admin assigns volunteer; volunteer accepts; distribution out of order → 409
10. Donor sees pickup OTP; wrong OTP → 400 with attempts left; correct OTP → `picked_up`; replay → 409
11. Volunteer sees delivery OTP; NGO cannot confirm before delivery is recorded (409); volunteer uploads delivery proof
12. NGO verifies receipt with delivery OTP; over-distribution → 400; distribution → **`completed`**
13. Admin sees the full completion record (both OTP times, both GPS points, quantities, people served, estimated meals), a timeline with exactly 10 steps, the audit log and dashboard metrics; certificate PDF, Excel and PDF reports and NGO impact all work
14. Privacy: the NGO cannot download the volunteer's ID document; the full ID number is never stored

The second test covers OTP lockout after 5 wrong attempts and regeneration by the holder, unsafe-food rejection in transit, refresh-token rotation with reuse detection, and immediate effect of account suspension.

**`tests/safety.test.js`** covers food-safety rule cases (time limits per storage type, temperature downgrades, expiry dates, deadlines beyond the safe window).

## Manual end-to-end test (browser)

1. `npm run create-test-accounts` (dev/staging DB) and note the printed passwords. Start the server.
2. **Donor** (`/#/login/donor`) → *Donate food*: cooked meal, hot holding 68 °C, prepared 30 min ago, deadline in 3 h, 1–2 photos, tap *Use my current GPS location*, submit.
3. **Admin** (`/#/login/admin`) → Donations → open it → *Verify & approve* (it is auto-offered to nearby NGOs).
4. **NGO** → *Offered to you* → open → *Accept donation*.
5. **Admin** → open donation → *Assign* a volunteer.
6. **Volunteer** → open the pickup → *Accept pickup*.
7. **Donor** → open the donation → note the **Pickup OTP**.
8. **Volunteer** → pickup form: quantity, temperature, photo, *Capture current GPS*, tick condition, enter the OTP → *Confirm pickup*. Note the **Delivery OTP** now shown.
9. **Volunteer** → delivery form: photo + GPS → *I have delivered the food*.
10. **NGO** → receipt form: delivery OTP, received kg, temperature, photo, tick condition → *Confirm receipt*.
11. **NGO** → distribution form: people served, kg, location → *Record distribution & complete*.
12. **Admin** → the donation shows **Completed** with all proof; Dashboard counts update; donor can download the certificate.

Negative checks worth repeating: a wrong OTP 5 times locks the code; *Reject unsafe food* at pickup closes the donation; suspending a user signs them out immediately.

This exact flow was executed through the browser UI (headless Chrome) during development and reached `completed` with all verifications.
