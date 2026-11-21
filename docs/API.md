# REST API Reference

Base URL: `/api`. JSON in and out. Files (photos/documents) are sent as **base64 data URLs** (`data:image/jpeg;base64,…`) of at most 700 KB each; JPEG/PNG/WebP for photos, plus PDF for documents. Content is checked against magic bytes.

**Auth:** `Authorization: Bearer <accessToken>` (15-minute JWT). The refresh token is an `httpOnly; SameSite=Strict` cookie scoped to `/api/auth`.
**Errors:** `{ "error": "message", "code": "bad_request|unauthorized|forbidden|not_found|conflict|unprocessable|otp_invalid|locked", "details"?: … }` with status 400/401/403/404/409/413/422/429.
**Roles:** `A` admin, `D` donor, `V` volunteer, `N` NGO. "active" means the account was verified by an admin.

## Public
| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/public/stats` | Aggregate impact numbers (no personal data) |
| GET | `/public/config` | Enum labels + optional FCM web config |

## Auth & profile
| Method | Path | Who | Body / notes |
|---|---|---|---|
| POST | `/auth/register/:role` | public | `role` ∈ donor, volunteer, ngo. Fields: name, email, password (≥10, letters+digits), phone, address, city, area, location{lat,lng} plus role fields: **donor** orgName, orgType, idType, idNumber, fssaiLicense?, idDocument; **volunteer** govIdType, govIdNumber, vehicleType, emergencyContact?, idDocument, profilePhoto; **ngo** registeredName, registrationNumber, pan?, operatingArea, repDesignation, capacityKg, acceptsNonVeg, fcraApplicable, fcraNumber?, registrationCertificate, panDocument?, fcraDocument?, orgPhotos[1–3]. Returns 201 with status `pending`. |
| POST | `/auth/login` | public | `{email, password, portal}`. `portal` must match the account's role (separate login screens). Returns `{user, accessToken}` and sets the refresh cookie. |
| POST | `/auth/refresh` | cookie | Rotates the refresh token. Reusing an old token revokes the whole session family. |
| POST | `/auth/logout` | cookie | Revokes the session family |
| GET | `/auth/me` | any | `{user, profile}` |
| PATCH | `/auth/me/profile` | any | phone, address, city, area, location; volunteer: available; NGO: capacityKg, acceptsNonVeg, available |
| POST | `/auth/me/password` | any | `{currentPassword, newPassword}`. Signs out all sessions. |
| POST | `/auth/me/push-token` | any | `{token}` FCM token |

## Donations – shared
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/donations/:id` | participants, A | Role-aware view. `level: "full"` for participants and admins; `level: "listing"` (no exact address or contacts) for NGOs/volunteers browsing. Includes `otp` for the current holder, verification records, safety checks, timeline; admins also get audit, requests, assignments and NGO/volunteer candidates. |
| POST | `/donations/:id/cancel` | D (own), A | `{reason}`. Only before pickup. |
| POST | `/donations/:id/otp/regenerate` | holder | New code; resets attempts; limited count |
| POST | `/donations/:id/reject-unsafe` | V (in_pickup/picked_up), N (awaiting_receipt) | `{reason, tempC?, photos[]?}` closes as `unsafe_rejected` |
| GET | `/donations/:id/certificate` | D (own), A | PDF; completed donations only |

## Donor
| Method | Path | Body |
|---|---|---|
| POST | `/donations` | foodName, category (`cooked_meal`, `dairy`, `bakery`, `raw_produce`, `packaged`, `beverages`, `other`), description?, quantityKg, vegType, preparedAt, pickupDeadline, expiryDate (packaged/beverages), storage, tempC (required for hot/chilled/frozen), allergens[], handlingInstructions, safetyNotes?, pickup{address,city,area,lat,lng}, photos[1–4]. **422** if the food-safety rules fail. |
| GET | `/donor/donations` | own donations |

## NGO (active)
| Method | Path | Body / notes |
|---|---|---|
| GET | `/ngo/board` | `{offers, open, active, history}` |
| POST | `/donations/:id/offer/accept` | first verified NGO to accept wins (transaction); otherwise 409 |
| POST | `/donations/:id/offer/decline` | `{reason?}` |
| POST | `/donations/:id/request` | `{note?}` request an open donation (admin approves) |
| POST | `/donations/:id/release` | `{reason}` give back before pickup; system re-matches |
| POST | `/donations/:id/receive` | `{otp, receivedKg, conditionOk:true, tempC?, notes?, photos[1–4]}` (step 8) |
| POST | `/donations/:id/distribution` | `{distributedAt, peopleServed, distributedKg ≤ received, location, beneficiaryGroup?, notes?, photos[0–4]}`. Returns `{status:"completed"}` or `{status:"distributed", missing:[…]}`. |
| GET | `/ngo/impact?month=YYYY-MM` | monthly impact JSON |
| GET | `/ngo/impact.pdf?month=YYYY-MM` | monthly impact PDF |

## Volunteer (active)
| Method | Path | Body / notes |
|---|---|---|
| GET | `/volunteer/board` | `{available, active, history, profile}` |
| POST | `/donations/:id/interest` | offer to collect an NGO-accepted donation |
| POST | `/donations/:id/assignment/accept` | starts pickup; issues pickup OTP to donor |
| POST | `/donations/:id/assignment/decline` | `{reason?}` |
| POST | `/donations/:id/pickup` | `{otp, quantityKg, conditionOk:true, packagingOk, tempC?, notes?, photos[1–4], gps{lat,lng,accuracy}}` (step 6). Issues the delivery OTP to the volunteer. |
| POST | `/donations/:id/deliver` | `{photos[1–4], gps, notes?}` (step 7) |

## Notifications & complaints
| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | latest 50 + unread count |
| GET | `/notifications/unread-count` | |
| POST | `/notifications/:id/read`, `/notifications/read-all` | |
| POST | `/complaints` | `{type, description, donationId?, againstUserId?, photos[0–3]}`; type ∈ unsafe_food, suspicious_activity, fraud, no_show, misconduct, other |
| GET | `/complaints/mine` | |
| GET | `/files/:id` | Binary. Identity files: owner + admin only. Proof photos: donation participants + admin. |

## Admin (`/admin/*`, role admin, optional IP allowlist)
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/dashboard?fresh=1` | all metrics, status counts, area-wise stats |
| GET | `/admin/users?role=&status=` | |
| GET | `/admin/users/:id` | profile, documents, activity |
| POST | `/admin/users/:id/approve\|reject\|suspend\|reactivate` | `{reason}` required for reject/suspend. Suspension revokes sessions immediately. |
| POST | `/admin/ngo-documents/:id/review` | `{status: verified\|rejected, note?}` |
| GET | `/admin/donations?status=` | |
| POST | `/admin/donations/:id/review` | `{decision: approve\|reject, notes?}`. Approval re-runs safety checks and auto-matches NGOs. |
| POST | `/admin/donations/:id/rematch` | re-run NGO matching |
| POST | `/admin/donations/:id/offer` | `{ngoId}` manual offer |
| POST | `/admin/donations/:id/requests/:ngoId/approve\|decline` | NGO requests |
| POST | `/admin/donations/:id/assign` | `{volunteerId}` |
| POST | `/admin/donations/:id/unassign` | `{reason?}` |
| GET | `/admin/live` | active donations with pickup/delivery GPS |
| GET | `/admin/complaints?status=` / PATCH `/admin/complaints/:id` | `{status, resolution}` |
| GET | `/admin/reports?period=daily\|weekly\|monthly\|yearly&date=YYYY-MM-DD` | JSON |
| GET | `/admin/reports/export?…&format=pdf\|xlsx` | download |
| GET | `/admin/audit?entityId=\|actorId=&limit=` | audit log |
| GET | `/admin/audit/export` | Excel |
| GET / PUT | `/admin/settings` | serving size, matching radius, OTP limits, GPS tolerance |

## Rate limits
Global 1,500 requests per 15 min per IP; auth endpoints 30 per 15 min per IP; OTP endpoints (pickup/receive/regenerate) 30 per 15 min per user, on top of 5 wrong attempts per OTP.
