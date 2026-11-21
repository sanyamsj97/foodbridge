# Database Design (Cloud Firestore)

Cloud Firestore replaces PostgreSQL so the platform runs on the free Firebase Spark plan. Each required table is a **collection**. Relationships are document-ID references; integrity is enforced by the service layer inside **transactions** (every state change re-reads the donation and checks its status). Only the server (Admin SDK) can access the database; `firestore.rules` denies all client access.

All timestamps are ISO-8601 UTC strings. `id` is the document ID.

## Required collections

### `users`
| Field | Type | Notes |
|---|---|---|
| email | string | unique (enforced via `user_emails/{email}`) |
| passwordHash | string | bcrypt, 12 rounds |
| role | `admin` \| `donor` \| `volunteer` \| `ngo` | |
| name, phone | string | |
| status | `pending` \| `active` \| `rejected` \| `suspended` | only `active` users can act |
| statusReason | string? | rejection / suspension reason |
| failedLogins, lockUntil | number, string? | lockout after 5 failures for 15 min |
| tokenVersion | number | incremented on suspension / password change, which kills sessions |
| createdAt, updatedAt, lastLoginAt | string | |

### `donors` (id = users.id, 1:1)
orgName, orgType (`college_mess`, `hostel`, `hotel`, `restaurant`, `event_organizer`, `caterer`, `other`), idType, **idNumberMasked** (last 4 only), fssaiLicense, idDocFileId → `files`, address, city, area, location {lat,lng}, verified, verifiedAt, verifiedBy.

### `volunteers` (id = users.id, 1:1)
govIdType, **govIdNumberMasked**, idDocFileId → `files`, photoFileId → `files`, vehicleType, emergencyContact, address, city, area, location, available, completedCount, verified.

### `ngos` (id = users.id, 1:1)
registeredName, registrationNumber, panMasked, operatingArea, representative {name, designation, phone, email}, fcraApplicable, fcraNumber, capacityKg, acceptsNonVeg, available, address, city, area, location, verified. *No bank details are collected; FoodBridge handles no money.*

### `ngo_documents` (N:1 → ngos)
ngoId, type (`registration_certificate`, `pan`, `fcra`, `organisation_photo`), fileId → `files`, required, status (`pending`/`verified`/`rejected`), note, reviewedBy, reviewedAt. **An NGO cannot be approved until every required document is verified.**

### `food_donations`
| Field | Notes |
|---|---|
| donorId → users, donorName, donorOrg | |
| foodName, category, description, quantityKg, vegType (`veg`/`non_veg`) | |
| preparedAt, expiryDate?, pickupDeadline | |
| storage (`hot_holding`/`room_temp`/`refrigerated`/`frozen`), tempC | |
| allergens[], safetyNotes, handlingInstructions | |
| photoFileIds[] → files | at least 1 required |
| pickup {address, city, area, lat, lng} | |
| status | see state machine below |
| safety {result, flags[], safeUntil} | from the rules engine |
| ngoId, ngoName, volunteerId, volunteerName, assignmentId | |
| pickupVerificationId, deliveryVerificationId, distributionRecordId | |
| verifiedPickupKg, receivedKg, distributedKg, peopleServed, estimatedMeals | |
| timeline[] {status, at, by} | |
| completion {…} | full completion record (donor, volunteer, NGO, quantities, OTP times, GPS, safety results) |
| completionMissing[] | reasons a distributed donation could not complete |
| reviewNotes, closedReason, *At timestamps | |

### `donation_requests` (id = `{donationId}_{ngoId}`)
donationId, ngoId, ngoName, type (`offer` = system/admin offered to NGO; `request` = NGO asked), status (`pending`, `accepted`, `declined`, `superseded`, `withdrawn`), distanceKm, note, decidedBy. The deterministic ID prevents duplicate requests.

### `volunteer_assignments`
donationId, volunteerId, volunteerName, assignedBy, status (`interested`, `assigned`, `accepted`, `declined`, `picked_up`, `completed`, `cancelled`, `closed_unsafe`), timestamps.

### `pickup_verifications` (1:1 → donation)
donationId, volunteerId, donorId, quantityKgDeclared, quantityKgVerified, conditionOk, tempC, photoFileIds[], gps {lat,lng,accuracy}, gpsDistanceKm, otpVerifiedAt, status, flags[], safetyCheckId.

### `delivery_verifications` (1:1 → donation)
donationId, volunteerId, ngoId, deliveryPhotoFileIds[], deliveryGps, deliveryGpsDistanceKm, arrivedAt, receivedKg, tempC, receivingPhotoFileIds[], otpVerifiedAt, receivedBy, receivedAt, status (`awaiting_ngo` then `verified`), flags[], receiptFlags[].

### `food_safety_checks` (N:1 → donation) – auditable history
donationId, stage (`submission`, `admin_review`, `pickup`, `transit`, `receipt`), checkedBy, role, result (`pass`/`flag`/`fail`), flags[], failures[], safeUntil, measuredTempC, createdAt.

### `distribution_records` (1:1 → donation)
donationId, ngoId, distributedAt, peopleServed, distributedKg, location, beneficiaryGroup, notes, proofFileIds[].

### `notifications`
userId, title, body, link, read, createdAt.

### `complaints`
reporterId, reporterName, reporterRole, type, description, donationId?, againstUserId?, photoFileIds[], status (`open`/`investigating`/`resolved`/`dismissed`), resolution, handledBy.

### `audit_logs` (append-only from the app)
at, actorId, actorRole, actorName, action (e.g. `donation.picked_up`), entityType, entityId, details {}, ip.

## Supporting collections
| Collection | Purpose |
|---|---|
| `user_emails/{email}` | uniqueness index → userId |
| `refresh_tokens/{sha256}` | hashed refresh tokens: userId, family, expiresAt, revokedAt (rotation + reuse detection) |
| `otp_codes/{donationId}_{pickup\|delivery}` | AES-256-GCM encrypted code, HMAC hash, holderId, verifierId, expiresAt, attempts, regenerations, consumedAt |
| `files` | base64 file content (≤ 700 KB), mime, size, ownerId, donationId, sensitivity (`identity` / `proof`) |
| `settings/global` | servingSizeKg, matchRadiusKm, maxOffers, otp limits, gpsToleranceKm |
| `push_tokens` | FCM tokens per user |

## Donation state machine

```
pending_review ──approve──▶ approved ──NGO accepts──▶ ngo_accepted ──admin assigns──▶ volunteer_assigned
      │ reject                  ▲    (or admin approves request)          ▲ decline/unassign      │ accept
      ▼                         └──── NGO releases ───────────────────────┘                     ▼
   rejected                                                                                in_pickup
                                                                                pickup OTP + photos + GPS + safety
                                                                                                │
   unsafe_rejected ◀── volunteer/NGO rejects unsafe ── picked_up ──delivery photos + GPS──▶ awaiting_receipt
                                                                                                │ delivery OTP + photos + safety
                                                                                                ▼
                                    completed ◀── all checks pass ── distributed ◀── distribution ── received
cancelled (donor/admin, before pickup)   expired (deadline / safe time passed before pickup)
```
