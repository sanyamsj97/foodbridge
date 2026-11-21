import { get, post, download } from '../api.js';
import { $, $$, html, raw, esc, label, toast, busy, badge, vegBadge, fmtDate, fmtNum, timeLeft, empty, photoGrid, hydrateFiles, filesToDataUrls, getGps, makeMap, navLink, modal, reasonBox, confirmBox } from '../ui.js';
import { go } from '../main.js';

const STEPS = [
  ['pending_review', 'Submitted'], ['approved', 'Admin verified'], ['ngo_accepted', 'NGO accepted'], ['volunteer_assigned', 'Volunteer assigned'],
  ['in_pickup', 'En route'], ['picked_up', 'Picked up (OTP)'], ['awaiting_receipt', 'Delivered'], ['received', 'NGO verified (OTP)'],
  ['distributed', 'Distributed'], ['completed', 'Completed'],
];
const ORDER = STEPS.map((s) => s[0]);

function progress(d, timeline) {
  const closed = ['rejected', 'cancelled', 'expired', 'unsafe_rejected'].includes(d.status);
  const reached = new Set((timeline || []).map((t) => t.status));
  const cur = ORDER.indexOf(d.status);
  return html`<ol class="progress" aria-label="Donation progress">${STEPS.map(([k, t], i) => {
    const done = reached.has(k) && (closed || i < cur || d.status === 'completed');
    const now = !closed && i === cur && d.status !== 'completed';
    return html`<li class="${done ? 'done' : now ? 'now' : ''}"><span class="dot" aria-hidden="true">${done ? '✓' : i + 1}</span><span>${t}</span>${now ? html`<span class="sr-only">(current step)</span>` : ''}</li>`;
  })}</ol>${closed ? html`<div class="alert alert-bad">${badge(d.status)} ${d.closedReason || d.reviewNotes || ''}</div>` : ''}`;
}

const gpsWidget = (name = 'gps') => html`<div class="field gps-capture"><span>GPS location <em class="req">*</em></span>
  <div class="row"><button type="button" class="btn btn-secondary gps-cap">📍 Capture current GPS</button><span class="gps-out muted">Not captured yet</span></div>
  <input type="hidden" name="${name}.lat"><input type="hidden" name="${name}.lng"><input type="hidden" name="${name}.accuracy"></div>`;
function bindGps(form) {
  $$('.gps-capture', form).forEach((w) => {
    $('.gps-cap', w).addEventListener('click', (e) => busy(e.target, async () => {
      const p = await getGps();
      const [la, ln, ac] = $$('input[type=hidden]', w);
      la.value = p.lat; ln.value = p.lng; ac.value = p.accuracy;
      $('.gps-out', w).textContent = `✔ ${p.lat}, ${p.lng} (±${p.accuracy} m) at ${new Date().toLocaleTimeString()}`;
    }));
  });
}
const readGps = (form, name = 'gps') => {
  const lat = form.elements[`${name}.lat`].value;
  if (!lat) throw new Error('Please capture your GPS location first');
  return { lat: Number(lat), lng: Number(form.elements[`${name}.lng`].value), accuracy: Number(form.elements[`${name}.accuracy`].value) || undefined };
};
const photoInput = (name, text, required = true) => html`<label class="field"><span>${text}${required ? raw(' <em class="req">*</em>') : ''}</span><input type="file" name="${name}" accept="image/*" capture="environment" multiple ${raw(required ? 'required' : '')}><small class="muted">Up to 4 photos – taken now, at the location.</small></label>`;
const tempInput = (required) => html`<label class="field"><span>Food temperature now (°C)${required ? raw(' <em class="req">*</em>') : ''}</span><input type="number" name="tempC" step="0.5" min="-40" max="100" ${raw(required ? 'required' : '')}></label>`;
const needsTemp = (d) => ['hot_holding', 'refrigerated', 'frozen'].includes(d.storage);

function otpCard(o, who) {
  if (!o) return '';
  if (o.used) return html`<div class="card otp-card"><p>✔ OTP already used.</p></div>`;
  return html`<div class="card otp-card">
    <h3>${who === 'donor' ? 'Pickup OTP' : 'Delivery OTP'}</h3>
    <p class="muted small">${who === 'donor' ? 'Share this code with the volunteer ONLY after you have handed over the food and checked their identity.' : 'Show this code to the NGO representative after they have checked the food.'}</p>
    ${o.code && !o.locked ? html`<div class="otp-code" aria-label="One-time code">${o.code.split('').join(' ')}</div><p class="small muted">Expires ${fmtDate(o.expiresAt)} · ${o.attemptsLeft} attempt(s) left</p>`
      : html`<p class="warn-text">${o.locked ? 'Too many wrong attempts – the code is locked.' : 'This code has expired.'}</p>`}
    <button class="btn btn-secondary btn-sm" data-act="regen-otp">↻ Generate a new code</button></div>`;
}

function partyCard(title, p) {
  if (!p) return '';
  return html`<div class="party"><h4>${title}</h4>
    <div class="party-row">${p.photoFileId ? html`<img class="avatar" data-file="${p.photoFileId}" alt="Volunteer photo">` : ''}
      <div><strong>${p.org || p.name}</strong>${p.org ? html`<div class="small">${p.name}</div>` : ''}
      ${p.representative ? html`<div class="small">Rep: ${p.representative.name} (${p.representative.designation})</div>` : ''}
      ${p.address ? html`<div class="small muted">${p.address}</div>` : ''}
      ${p.vehicleType ? html`<div class="small muted">Vehicle: ${label(p.vehicleType)}</div>` : ''}
      <div class="row">${p.phone ? html`<a class="btn btn-ghost btn-sm" href="tel:${p.phone.replace(/[^+\d]/g, '')}">📞 ${p.phone}</a>` : ''}${p.location ? navLink(p.location, 'Navigate') : ''}</div></div></div></div>`;
}

function actionPanel(data, user) {
  const d = data.donation;
  const s = d.status;
  const a = [];
  const preP = ['pending_review', 'approved', 'ngo_accepted', 'volunteer_assigned', 'in_pickup'].includes(s);
  if (user.status !== 'active' && user.role !== 'admin') return '';

  if (user.role === 'donor') {
    if (s === 'in_pickup') a.push(otpCard(data.otp, 'donor'));
    if (preP) a.push(html`<button class="btn btn-danger-outline" data-act="cancel">Cancel donation</button>`);
    if (s === 'completed') a.push(html`<button class="btn btn-primary" data-act="certificate">📄 Download donation certificate</button>`);
  }

  if (user.role === 'ngo') {
    if (data.level === 'listing') {
      if (data.request?.type === 'offer' && data.request.status === 'pending' && s === 'approved') {
        a.push(html`<div class="row"><button class="btn btn-primary" data-act="offer-accept">✔ Accept donation</button><button class="btn btn-ghost" data-act="offer-decline">Decline</button></div>`);
      } else if (s === 'approved' && !(data.request && data.request.status === 'pending')) {
        a.push(html`<button class="btn btn-primary" data-act="ngo-request">Request this donation</button>`);
      } else if (data.request) a.push(html`<p>Your ${data.request.type}: ${badge(data.request.status)}</p>`);
    } else {
      if (['ngo_accepted', 'volunteer_assigned', 'in_pickup'].includes(s)) a.push(html`<button class="btn btn-danger-outline" data-act="release">Release donation (cannot receive)</button>`);
      if (s === 'awaiting_receipt') {
        a.push(html`<form class="card action-form" id="receive-form"><h3>Step 8 · Verify receipt</h3>
          <p class="muted small">Check the food's quantity, smell, look and temperature BEFORE entering the OTP. If anything is unsafe, reject it.</p>
          <div class="grid grid-2"><label class="field"><span>Delivery OTP from volunteer <em class="req">*</em></span><input name="otp" inputmode="numeric" pattern="\\d{6}" maxlength="6" required autocomplete="one-time-code"></label>
          <label class="field"><span>Quantity received (kg) <em class="req">*</em></span><input type="number" name="receivedKg" step="0.1" min="0.1" required value="${d.verifiedPickupKg || d.quantityKg}"></label>
          ${tempInput(needsTemp(d))}</div>
          ${photoInput('photos', 'Receiving photographs')}
          <label class="field"><span>Notes</span><textarea name="notes" rows="2"></textarea></label>
          <label class="check"><input type="checkbox" name="conditionOk" required> I checked the food and it is in safe, edible condition.</label>
          <div class="row"><button class="btn btn-primary" type="submit">Confirm receipt</button><button class="btn btn-danger-outline" type="button" data-act="reject-unsafe">⚠ Reject unsafe food</button></div></form>`);
      }
      if (s === 'received') {
        a.push(html`<form class="card action-form" id="dist-form"><h3>Step 9 · Record distribution</h3>
          <div class="grid grid-2"><label class="field"><span>Distributed at <em class="req">*</em></span><input type="datetime-local" name="distributedAt" required></label>
          <label class="field"><span>Number of people served <em class="req">*</em></span><input type="number" name="peopleServed" min="1" step="1" required></label>
          <label class="field"><span>Quantity distributed (kg) <em class="req">*</em></span><input type="number" name="distributedKg" step="0.1" min="0.1" max="${d.receivedKg}" required value="${d.receivedKg}"></label>
          <label class="field"><span>Distribution location <em class="req">*</em></span><input name="location" required minlength="3"></label>
          <label class="field"><span>Beneficiary group</span><input name="beneficiaryGroup" placeholder="e.g. Shelter residents, street children"></label></div>
          ${photoInput('photos', 'Distribution proof (where appropriate – avoid identifiable faces of beneficiaries)', false)}
          <label class="field"><span>Notes</span><textarea name="notes" rows="2"></textarea></label>
          <button class="btn btn-primary" type="submit">Record distribution & complete</button></form>`);
      }
    }
  }

  if (user.role === 'volunteer') {
    if (data.level === 'listing') {
      if (s === 'ngo_accepted') a.push(data.interested ? html`<p>✔ You offered to collect this. The admin will assign a volunteer.</p>` : html`<button class="btn btn-primary" data-act="interest">🙋 I can collect this</button>`);
    } else {
      if (s === 'volunteer_assigned') a.push(html`<div class="row"><button class="btn btn-primary" data-act="assign-accept">✔ Accept pickup</button><button class="btn btn-ghost" data-act="assign-decline">Decline</button></div>`);
      if (s === 'in_pickup') {
        a.push(html`<div class="row">${navLink(d.pickup, 'Navigate to donor')}</div>`);
        a.push(html`<form class="card action-form" id="pickup-form"><h3>Step 6 · Pickup verification</h3>
          <p class="muted small">At the donor's location: check quantity, packaging, smell, look and temperature. Take photos, capture GPS, then ask the donor for the pickup OTP.</p>
          <div class="grid grid-2"><label class="field"><span>Verified quantity (kg) <em class="req">*</em></span><input type="number" name="quantityKg" step="0.1" min="0.1" required value="${d.quantityKg}"></label>
          ${tempInput(needsTemp(d))}</div>
          ${photoInput('photos', 'Pickup photographs')}
          ${gpsWidget()}
          <label class="check"><input type="checkbox" name="packagingOk" checked> Packaging is clean, covered and intact</label>
          <label class="check"><input type="checkbox" name="conditionOk" required> I checked the food and it looks, smells and feels safe to eat.</label>
          <label class="field"><span>Notes</span><textarea name="notes" rows="2"></textarea></label>
          <label class="field"><span>Pickup OTP from donor <em class="req">*</em></span><input name="otp" inputmode="numeric" pattern="\\d{6}" maxlength="6" required autocomplete="one-time-code"></label>
          <div class="row"><button class="btn btn-primary" type="submit">Confirm pickup</button><button class="btn btn-danger-outline" type="button" data-act="reject-unsafe">⚠ Reject unsafe food</button></div></form>`);
      }
      if (s === 'picked_up') {
        a.push(otpCard(data.otp, 'volunteer'));
        a.push(html`<div class="row">${data.parties.ngo?.location ? navLink(data.parties.ngo.location, 'Navigate to NGO') : ''}</div>`);
        a.push(html`<form class="card action-form" id="deliver-form"><h3>Step 7 · Delivery at NGO</h3>
          ${photoInput('photos', 'Delivery photographs')}${gpsWidget()}
          <label class="field"><span>Notes</span><textarea name="notes" rows="2"></textarea></label>
          <div class="row"><button class="btn btn-primary" type="submit">I have delivered the food</button><button class="btn btn-danger-outline" type="button" data-act="reject-unsafe">⚠ Food spoiled in transit</button></div></form>`);
      }
      if (s === 'awaiting_receipt') a.push(html`${otpCard(data.otp, 'volunteer')}<p class="muted">Waiting for the NGO to verify the food and enter this code.</p>`);
    }
  }

  if (user.role === 'admin') {
    if (s === 'pending_review') a.push(html`<div class="row"><button class="btn btn-primary" data-act="approve">✔ Verify & approve</button><button class="btn btn-danger-outline" data-act="reject">Reject</button></div>`);
    if (s === 'approved') {
      const reqs = (data.requests || []).filter((r) => r.status === 'pending');
      a.push(html`<div class="card"><h3>NGO matching</h3>
        ${reqs.length ? html`<table class="table"><thead><tr><th>NGO</th><th>Type</th><th class="num">km</th><th></th></tr></thead><tbody>${reqs.map((r) => html`<tr><td>${r.ngoName}</td><td>${label(r.type)}</td><td class="num">${r.distanceKm ?? '—'}</td><td>${r.type === 'request' ? html`<button class="btn btn-sm btn-primary" data-act="req-approve" data-ngo="${r.ngoId}">Approve</button> <button class="btn btn-sm btn-ghost" data-act="req-decline" data-ngo="${r.ngoId}">Decline</button>` : html`<span class="muted small">awaiting NGO</span>`}</td></tr>`)}</tbody></table>` : html`<p class="muted">No pending offers or requests.</p>`}
        <h4>Eligible / nearby NGOs</h4>
        <table class="table"><thead><tr><th>NGO</th><th>Area</th><th class="num">km</th><th class="num">Capacity kg</th><th>Eligibility</th><th></th></tr></thead><tbody>
        ${(data.ngoCandidates || []).map((n) => html`<tr><td>${n.name}</td><td>${n.area}</td><td class="num">${n.distanceKm ?? '—'}</td><td class="num">${n.capacityKg}${n.capacityOk ? '' : ' ⚠'}</td><td class="small">${n.eligible ? '✔ eligible' : n.reasons.join('; ')}</td><td><button class="btn btn-sm btn-secondary" data-act="offer" data-ngo="${n.ngoId}">Offer</button></td></tr>`)}
        </tbody></table><button class="btn btn-ghost btn-sm" data-act="rematch">↻ Re-run automatic matching</button></div>`);
    }
    if (s === 'ngo_accepted') {
      a.push(html`<div class="card"><h3>Step 5 · Assign a volunteer</h3><table class="table"><thead><tr><th>Volunteer</th><th>Area</th><th class="num">km</th><th>Status</th><th class="num">Active</th><th></th></tr></thead><tbody>
        ${(data.volunteerCandidates || []).length ? data.volunteerCandidates.map((v) => html`<tr><td>${v.name} ${v.interested ? html`<span class="badge badge-info">🙋 offered</span>` : ''}</td><td>${v.area}</td><td class="num">${v.distanceKm ?? '—'}</td><td>${v.available ? '✔ available' : '✕ unavailable'}</td><td class="num">${v.activeTasks}</td><td><button class="btn btn-sm btn-primary" data-act="assign" data-vol="${v.volunteerId}" ${raw(v.available ? '' : 'disabled')}>Assign</button></td></tr>`) : html`<tr><td colspan="6">${empty('No approved volunteers yet.')}</td></tr>`}
        </tbody></table></div>`);
    }
    if (['volunteer_assigned', 'in_pickup'].includes(s)) a.push(html`<button class="btn btn-ghost" data-act="unassign">Remove volunteer / reassign</button>`);
    if (preP) a.push(html`<button class="btn btn-danger-outline" data-act="cancel">Cancel donation</button>`);
    if (s === 'completed') a.push(html`<button class="btn btn-secondary" data-act="certificate">📄 Donor certificate</button>`);
  }
  if (user.role !== 'admin') a.push(html`<a class="btn btn-ghost btn-sm" href="#/complaints?donationId=${d.id}">⚑ Report a problem with this donation</a>`);
  return a.length ? html`<section class="card actions"><h2>Actions</h2>${a}</section>` : '';
}

function foodDetails(d) {
  return html`<section class="card"><h2>Food details</h2>
    <dl class="dl">
      <dt>Category</dt><dd>${label(d.category)} · ${vegBadge(d.vegType)}</dd>
      <dt>Quantity</dt><dd>${fmtNum(d.quantityKg)} kg declared${d.verifiedPickupKg ? ` · ${d.verifiedPickupKg} kg at pickup` : ''}${d.receivedKg ? ` · ${d.receivedKg} kg received` : ''}</dd>
      <dt>Estimated meals</dt><dd>${fmtNum(d.estimatedMeals)} <small class="muted">(estimate, not verified beneficiaries)</small></dd>
      <dt>Prepared</dt><dd>${fmtDate(d.preparedAt)}</dd>
      ${d.expiryDate ? html`<dt>Expiry</dt><dd>${fmtDate(d.expiryDate)}</dd>` : ''}
      <dt>Pickup deadline</dt><dd>${fmtDate(d.pickupDeadline)} ${['pending_review', 'approved', 'ngo_accepted', 'volunteer_assigned', 'in_pickup'].includes(d.status) ? html`<strong>(${timeLeft(d.pickupDeadline)})</strong>` : ''}</dd>
      <dt>Safe until</dt><dd>${fmtDate(d.safety?.safeUntil)}</dd>
      <dt>Storage</dt><dd>${label(d.storage)}${d.tempC != null && d.tempC !== '' ? ` · ${d.tempC}°C declared` : ''}</dd>
      <dt>Allergens</dt><dd>${d.allergens?.length ? d.allergens.join(', ') : 'None declared'}</dd>
      <dt>Handling</dt><dd>${d.handlingInstructions || '—'}</dd>
      ${d.safetyNotes ? html`<dt>Safety notes</dt><dd>${d.safetyNotes}</dd>` : ''}
      ${d.description ? html`<dt>Description</dt><dd>${d.description}</dd>` : ''}
      ${d.pickup?.address ? html`<dt>Pickup address</dt><dd>${d.pickup.address}, ${d.pickup.area}, ${d.pickup.city}</dd>` : html`<dt>Pickup area</dt><dd>${d.area}, ${d.city}${d.distanceKm != null ? ` · ${d.distanceKm} km from you` : ''}</dd>`}
    </dl>
    ${d.safety?.flags?.length ? html`<div class="alert alert-warn"><strong>Safety flags at submission:</strong><ul>${d.safety.flags.map((f) => html`<li>${f}</li>`)}</ul></div>` : ''}
    <h3>Food photographs</h3>${photoGrid(d.photoFileIds)}</section>`;
}

function verification(data) {
  const { pickup: p, delivery: v, distribution: x, safetyChecks: checks, donation: d } = data;
  return html`<section class="card"><h2>Verification & proof</h2>
    <h3>Food-safety checks</h3>
    ${checks?.length ? html`<table class="table"><thead><tr><th>Stage</th><th>Result</th><th>By</th><th>When</th><th>Details</th></tr></thead><tbody>${checks.map((c) => html`<tr><td>${label(c.stage)}</td><td>${badge(c.result)}</td><td>${label(c.role)}</td><td>${fmtDate(c.createdAt)}</td><td class="small">${[...(c.failures || []), ...(c.flags || [])].join('; ') || '—'}${c.measuredTempC != null ? ` · measured ${c.measuredTempC}°C` : ''}</td></tr>`)}</tbody></table>` : html`<p class="muted">No checks yet.</p>`}
    ${p ? html`<h3>Pickup verification ${badge(p.status)}</h3><dl class="dl"><dt>OTP verified</dt><dd>${fmtDate(p.otpVerifiedAt)}</dd><dt>Quantity</dt><dd>${p.quantityKgVerified} kg (declared ${p.quantityKgDeclared} kg)</dd><dt>Temperature</dt><dd>${p.tempC ?? '—'}°C</dd><dt>GPS</dt><dd>${p.gps.lat}, ${p.gps.lng}${p.gpsDistanceKm != null ? ` · ${p.gpsDistanceKm} km from listed location` : ''}</dd>${p.flags?.length ? html`<dt>Flags</dt><dd class="warn-text">${p.flags.join('; ')}</dd>` : ''}${p.notes ? html`<dt>Notes</dt><dd>${p.notes}</dd>` : ''}</dl>${photoGrid(p.photoFileIds)}` : ''}
    ${v ? html`<h3>Delivery & receipt ${badge(v.status === 'verified' ? 'verified' : 'pending', v.status === 'verified' ? 'Verified by NGO' : 'Awaiting NGO')}</h3><dl class="dl"><dt>Arrived</dt><dd>${fmtDate(v.arrivedAt)}</dd><dt>Delivery GPS</dt><dd>${v.deliveryGps.lat}, ${v.deliveryGps.lng}${v.deliveryGpsDistanceKm != null ? ` · ${v.deliveryGpsDistanceKm} km from NGO` : ''}</dd>${v.otpVerifiedAt ? html`<dt>OTP verified</dt><dd>${fmtDate(v.otpVerifiedAt)}</dd><dt>Received</dt><dd>${v.receivedKg} kg · ${v.tempC ?? '—'}°C</dd>` : ''}${[...(v.flags || []), ...(v.receiptFlags || [])].length ? html`<dt>Flags</dt><dd class="warn-text">${[...(v.flags || []), ...(v.receiptFlags || [])].join('; ')}</dd>` : ''}</dl>
      <h4>Delivery photos (volunteer)</h4>${photoGrid(v.deliveryPhotoFileIds)}${v.receivingPhotoFileIds ? html`<h4>Receiving photos (NGO)</h4>${photoGrid(v.receivingPhotoFileIds)}` : ''}` : ''}
    ${x ? html`<h3>Distribution</h3><dl class="dl"><dt>When</dt><dd>${fmtDate(x.distributedAt)}</dd><dt>People served</dt><dd>${fmtNum(x.peopleServed)} (recorded by NGO)</dd><dt>Quantity</dt><dd>${x.distributedKg} kg</dd><dt>Location</dt><dd>${x.location}</dd>${x.beneficiaryGroup ? html`<dt>Beneficiaries</dt><dd>${x.beneficiaryGroup}</dd>` : ''}</dl>${photoGrid(x.proofFileIds)}` : ''}
    ${d.status === 'completed' && d.completion ? html`<div class="alert alert-good"><strong>✔ Donation completed ${fmtDate(d.completion.completedAt)}.</strong> All mandatory verifications passed: pickup OTP, delivery OTP, photos, GPS, safety checks at pickup and receipt, and distribution record.</div>` : ''}
    ${d.completionMissing?.length ? html`<div class="alert alert-bad"><strong>Not completed – missing/failed:</strong><ul>${d.completionMissing.map((m) => html`<li>${m}</li>`)}</ul></div>` : ''}
  </section>`;
}

function mapSection(data) {
  const pts = [];
  const d = data.donation;
  if (d.pickup?.lat != null) pts.push(['Pickup location', d.pickup]);
  if (data.pickup?.gps) pts.push(['Pickup GPS (volunteer)', data.pickup.gps]);
  if (data.delivery?.deliveryGps) pts.push(['Delivery GPS (volunteer)', data.delivery.deliveryGps]);
  if (data.parties?.ngo?.location) pts.push(['NGO', data.parties.ngo.location]);
  if (!pts.length) return { html: '', pts };
  return { html: html`<section class="card"><h2>Locations</h2><div class="map" id="don-map"></div><ul class="small muted">${pts.map(([t, p]) => html`<li>${t}: ${p.lat}, ${p.lng}</li>`)}</ul></section>`, pts };
}

export async function detail(ctx) {
  const { el, params, user } = ctx;
  const data = await get(`/api/donations/${params.id}`);
  const d = data.donation;
  const m = data.level === 'full' ? mapSection(data) : { html: '', pts: [] };
  el.innerHTML = String(html`
    <p><a href="#" data-back>← Back</a></p>
    <div class="page-head"><div><h1>${d.foodName}</h1><p class="muted">${d.donorOrg} · ${fmtNum(d.quantityKg)} kg · listed ${fmtDate(d.createdAt)} · ID ${d.id}</p></div>${badge(d.status)}</div>
    ${data.level === 'full' ? progress(d, data.timeline) : ''}
    <div class="detail-grid">
      <div>${actionPanel(data, user)}${foodDetails(d)}${data.level === 'full' ? verification(data) : ''}</div>
      <div>
        ${data.level === 'full' ? html`<section class="card"><h2>People involved</h2>${partyCard('Donor', data.parties.donor)}${partyCard('NGO', data.parties.ngo)}${partyCard('Volunteer', data.parties.volunteer)}${!data.parties.ngo && !data.parties.volunteer && user.role === 'donor' ? html`<p class="muted">NGO and volunteer will appear here once assigned.</p>` : ''}</section>` : ''}
        ${m.html}
        ${data.timeline ? html`<section class="card"><h2>Timeline</h2><ol class="timeline">${data.timeline.map((t) => html`<li>${badge(t.status)} <span class="small muted">${fmtDate(t.at)}</span></li>`)}</ol></section>` : ''}
        ${data.audit ? html`<section class="card"><h2>Audit log</h2><ul class="audit">${data.audit.map((l) => html`<li><code>${l.action}</code> by ${l.actorName} (${l.actorRole}) <span class="small muted">${fmtDate(l.at)}</span></li>`)}</ul></section>` : ''}
      </div>
    </div>`);
  hydrateFiles(el);
  if (m.pts.length) {
    const map = makeMap($('#don-map'));
    if (map) {
      const L = window.L;
      const ll = m.pts.map(([t, p]) => { L.marker([p.lat, p.lng]).addTo(map).bindPopup(esc(t)); return [p.lat, p.lng]; });
      map.fitBounds(ll, { padding: [30, 30], maxZoom: 15 });
    }
  }
  bindActions(ctx, data);
}

function bindActions(ctx, data) {
  const { el } = ctx;
  const d = data.donation;
  const id = d.id;
  const reload = () => detail(ctx);
  const act = async (btn, fn, msg) => busy(btn, async () => { await fn(); if (msg) toast(msg); await reload(); });

  const handlers = {
    cancel: async (b) => { const r = await reasonBox('Cancel donation', { submitText: 'Cancel donation', danger: true }); if (r) await act(b, () => post(`/api/donations/${id}/cancel`, r), 'Donation cancelled'); },
    certificate: (b) => busy(b, () => download(`/api/donations/${id}/certificate`, `foodbridge-certificate-${id}.pdf`)),
    'regen-otp': (b) => act(b, () => post(`/api/donations/${id}/otp/regenerate`), 'New code generated'),
    'offer-accept': async (b) => { if (await confirmBox('Accept donation', `Accept ${d.foodName} (${d.quantityKg} kg)? You must be able to receive it before ${fmtDate(d.pickupDeadline)}.`, { submitText: 'Accept' })) await act(b, () => post(`/api/donations/${id}/offer/accept`), 'Donation accepted'); },
    'offer-decline': async (b) => { const r = await modal('Decline offer', '<label class="field"><span>Reason (optional)</span><textarea name="reason" rows="2"></textarea></label>', { submitText: 'Decline' }); if (r) await act(b, () => post(`/api/donations/${id}/offer/decline`, r), 'Offer declined'); },
    'ngo-request': async (b) => { const r = await modal('Request donation', '<label class="field"><span>Note to admin (optional)</span><textarea name="note" rows="2"></textarea></label>', { submitText: 'Send request' }); if (r) await act(b, () => post(`/api/donations/${id}/request`, r), 'Request sent to admin'); },
    release: async (b) => { const r = await reasonBox('Release donation', { submitText: 'Release', danger: true }); if (r) await act(b, () => post(`/api/donations/${id}/release`, r), 'Donation released'); },
    interest: (b) => act(b, () => post(`/api/donations/${id}/interest`), 'Admin notified – thank you!'),
    'assign-accept': (b) => act(b, () => post(`/api/donations/${id}/assignment/accept`), 'Pickup accepted – the donor has been notified'),
    'assign-decline': async (b) => { const r = await modal('Decline pickup', '<label class="field"><span>Reason (optional)</span><textarea name="reason" rows="2"></textarea></label>', { submitText: 'Decline' }); if (r) await act(b, () => post(`/api/donations/${id}/assignment/decline`, r), 'Pickup declined'); },
    'reject-unsafe': async (b) => {
      const r = await modal('Reject unsafe food', `<div class="alert alert-warn small">Use this when food is spoiled, smells bad, is past its safe time/temperature, or packaging is contaminated. The donation will be closed and the admin notified.</div>
        <label class="field"><span>What is wrong? <em class="req">*</em></span><textarea name="reason" required minlength="5" rows="3"></textarea></label>
        <label class="field"><span>Measured temperature (°C)</span><input type="number" step="0.5" name="tempC"></label>
        <label class="field"><span>Evidence photos (optional, max 4)</span><input type="file" name="ev" accept="image/*" capture="environment" multiple></label>`, { submitText: 'Reject food', danger: true });
      if (!r) return;
      await act(b, async () => { const photos = await filesToDataUrls(r.ev.slice(0, 4)); delete r.ev; await post(`/api/donations/${id}/reject-unsafe`, { ...r, photos }); }, 'Food rejected as unsafe');
    },
    approve: async (b) => { const r = await modal('Verify & approve', `<p>Confirm you reviewed the donor, photos, timings, storage and allergen details.</p>${d.safety?.flags?.length ? `<div class="alert alert-warn small">${d.safety.flags.map(esc).join('<br>')}</div>` : ''}<label class="field"><span>Notes</span><textarea name="notes" rows="2"></textarea></label>`, { submitText: 'Approve' }); if (r) await act(b, async () => { const res = await post(`/api/admin/donations/${id}/review`, { decision: 'approve', notes: r.notes }); toast(res.status === 'approved' ? `Approved · offered to ${res.offeredTo} NGO(s)` : 'Rejected automatically by safety rules', res.status === 'approved' ? 'ok' : 'error'); }); },
    reject: async (b) => { const r = await modal('Reject donation', '<label class="field"><span>Reason <em class="req">*</em></span><textarea name="notes" required minlength="3" rows="3"></textarea></label>', { submitText: 'Reject', danger: true }); if (r) await act(b, () => post(`/api/admin/donations/${id}/review`, { decision: 'reject', notes: r.notes }), 'Donation rejected'); },
    offer: (b) => act(b, () => post(`/api/admin/donations/${id}/offer`, { ngoId: b.dataset.ngo }), 'Offer sent to NGO'),
    rematch: (b) => act(b, async () => { const r = await post(`/api/admin/donations/${id}/rematch`); toast(`Offered to ${r.offeredTo} NGO(s)`); }),
    'req-approve': (b) => act(b, () => post(`/api/admin/donations/${id}/requests/${b.dataset.ngo}/approve`), 'NGO request approved'),
    'req-decline': (b) => act(b, () => post(`/api/admin/donations/${id}/requests/${b.dataset.ngo}/decline`), 'Request declined'),
    assign: (b) => act(b, () => post(`/api/admin/donations/${id}/assign`, { volunteerId: b.dataset.vol }), 'Volunteer assigned'),
    unassign: async (b) => { const r = await reasonBox('Remove volunteer', { submitText: 'Remove' }); if (r) await act(b, () => post(`/api/admin/donations/${id}/unassign`, r), 'Volunteer removed'); },
  };
  $$('[data-act]', el).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); handlers[b.dataset.act]?.(b); }));

  const pf = $('#pickup-form', el);
  if (pf) {
    bindGps(pf);
    pf.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pf.reportValidity()) return;
      await act(e.submitter, async () => {
        const f = pf.elements;
        if (f.photos.files.length > 4) throw new Error('Maximum 4 photos');
        await post(`/api/donations/${id}/pickup`, { otp: f.otp.value, quantityKg: Number(f.quantityKg.value), tempC: f.tempC.value, conditionOk: f.conditionOk.checked, packagingOk: f.packagingOk.checked, notes: f.notes.value, gps: readGps(pf), photos: await filesToDataUrls(f.photos) });
      }, 'Pickup confirmed – deliver to the NGO');
    });
  }
  const df = $('#deliver-form', el);
  if (df) {
    bindGps(df);
    df.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!df.reportValidity()) return;
      await act(e.submitter, async () => {
        if (df.elements.photos.files.length > 4) throw new Error('Maximum 4 photos');
        await post(`/api/donations/${id}/deliver`, { notes: df.elements.notes.value, gps: readGps(df), photos: await filesToDataUrls(df.elements.photos) });
      }, 'Delivery recorded – show the delivery OTP to the NGO');
    });
  }
  const rf = $('#receive-form', el);
  if (rf) rf.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!rf.reportValidity()) return;
    await act(e.submitter, async () => {
      const f = rf.elements;
      if (f.photos.files.length > 4) throw new Error('Maximum 4 photos');
      await post(`/api/donations/${id}/receive`, { otp: f.otp.value, receivedKg: Number(f.receivedKg.value), tempC: f.tempC.value, conditionOk: f.conditionOk.checked, notes: f.notes.value, photos: await filesToDataUrls(f.photos) });
    }, 'Receipt verified');
  });
  const xf = $('#dist-form', el);
  if (xf) {
    const n = new Date(); xf.elements.distributedAt.value = new Date(n.getTime() - n.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    xf.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!xf.reportValidity()) return;
      await busy(e.submitter, async () => {
        const f = xf.elements;
        const r = await post(`/api/donations/${id}/distribution`, { distributedAt: new Date(f.distributedAt.value).toISOString(), peopleServed: Number(f.peopleServed.value), distributedKg: Number(f.distributedKg.value), location: f.location.value, beneficiaryGroup: f.beneficiaryGroup.value, notes: f.notes.value, photos: await filesToDataUrls(f.photos) });
        toast(r.status === 'completed' ? 'Donation completed – thank you!' : `Recorded, but not completed: ${(r.missing || []).join('; ')}`, r.status === 'completed' ? 'ok' : 'error');
        await reload();
      });
    });
  }
}

export { go };
