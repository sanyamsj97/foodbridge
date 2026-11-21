import { get, post } from '../api.js';
import { $, html, label, toast, busy, badge, vegBadge, fmtDate, fmtNum, statTile, empty, locationField, locationPicker, filesToDataUrls, localInput, timeLeft } from '../ui.js';
import { go } from '../main.js';

export function donationCard(d, extra = '') {
  return html`<a class="card donation-card" href="#/donation/${d.id}">
    <div class="dc-top"><h3>${d.foodName}</h3>${badge(d.status)}</div>
    <div class="dc-meta">${vegBadge(d.vegType)}<span>${fmtNum(d.quantityKg)} kg</span><span>${label(d.category)}</span>${d.area ? html`<span>📍 ${d.area}${d.city ? `, ${d.city}` : ''}</span>` : ''}${d.distanceKm != null ? html`<span>${d.distanceKm} km away</span>` : ''}</div>
    <div class="dc-meta muted small"><span>Prepared ${fmtDate(d.preparedAt)}</span>${['pending_review', 'approved', 'ngo_accepted', 'volunteer_assigned'].includes(d.status) ? html`<span>Pickup by ${fmtDate(d.pickupDeadline)} (${timeLeft(d.pickupDeadline)})</span>` : ''}</div>
    ${d.safety?.flags?.length ? html`<div class="small warn-text">⚠ ${d.safety.flags.length} safety flag(s)</div>` : ''}
    ${extra}
  </a>`;
}

export async function dashboard({ el, user, banner }) {
  const { donations } = await get('/api/donor/donations');
  const completed = donations.filter((d) => d.status === 'completed');
  const active = donations.filter((d) => !['completed', 'rejected', 'cancelled', 'expired', 'unsafe_rejected'].includes(d.status));
  const past = donations.filter((d) => !active.includes(d));
  const kg = completed.reduce((a, d) => a + (d.receivedKg || 0), 0);
  el.innerHTML = String(html`${{ __raw: true, value: banner }}
    <div class="page-head"><div><h1>Welcome, ${user.name}</h1><p class="muted">Track your donations from listing to distribution.</p></div>
      ${user.status === 'active' ? html`<a class="btn btn-primary btn-lg" href="#/donor/new">+ Donate food</a>` : ''}</div>
    <div class="stats">
      ${statTile(fmtNum(donations.length), 'Donations listed')}
      ${statTile(fmtNum(completed.length), 'Completed')}
      ${statTile(`${fmtNum(Math.round(kg * 10) / 10)} kg`, 'Food delivered to NGOs')}
      ${statTile(fmtNum(completed.reduce((a, d) => a + (d.estimatedMeals || 0), 0)), 'Meals (estimated)', 'Estimate – not verified beneficiaries')}
      ${statTile(fmtNum(completed.reduce((a, d) => a + (d.peopleServed || 0), 0)), 'People served (reported by NGOs)')}
    </div>
    <h2 class="section-title">Active donations</h2>
    <div class="grid grid-2">${active.length ? active.map((d) => donationCard(d)) : empty('No active donations.')}</div>
    <h2 class="section-title">Donation history</h2>
    <div class="grid grid-2">${past.length ? past.map((d) => donationCard(d, d.status === 'completed' ? html`<span class="small link">📄 Certificate available</span>` : '')) : empty('No past donations yet.')}</div>`);
}

export async function newDonation({ el, user, config }) {
  if (user.status !== 'active') { el.innerHTML = '<div class="alert alert-warn">Your account must be verified before you can donate food.</div>'; return; }
  const { profile } = await get('/api/auth/me');
  const en = config?.enums || {};
  const now = new Date();
  el.innerHTML = String(html`
    <div class="card form-card">
      <h1>Donate surplus food</h1>
      <div class="alert alert-info small"><strong>Food-safety rules:</strong> cooked food kept at room temperature must be collected within 4 hours of preparation, hot-held food (≥60°C) within 6 hours, chilled food (≤5°C) within 48 hours. Expired or unsafe food is automatically blocked. Volunteers and NGOs re-check the food at pickup and receipt.</div>
      <form id="don-form" novalidate>
        <fieldset><legend>Food details</legend><div class="grid grid-2">
          <label class="field"><span>Food name <em class="req">*</em></span><input name="foodName" required minlength="2" placeholder="e.g. Veg biryani, dal, rotis"></label>
          <label class="field"><span>Category <em class="req">*</em></span><select name="category" required>${Object.entries(en.categories || {}).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
          <label class="field"><span>Quantity (kg) <em class="req">*</em></span><input type="number" name="quantityKg" min="0.5" step="0.5" required></label>
          <fieldset class="field inline-radios"><legend>Food type <em class="req">*</em></legend>
            <label class="check"><input type="radio" name="vegType" value="veg" required checked> <span class="veg veg-yes">● Vegetarian</span></label>
            <label class="check"><input type="radio" name="vegType" value="non_veg"> <span class="veg veg-no">▲ Non-vegetarian</span></label></fieldset>
        </div>
        <label class="field"><span>Description</span><textarea name="description" rows="2" placeholder="Items, containers, number of portions…"></textarea></label></fieldset>

        <fieldset><legend>Timing & storage</legend><div class="grid grid-2">
          <label class="field"><span>Preparation time <em class="req">*</em></span><input type="datetime-local" name="preparedAt" required max="${localInput(now)}"></label>
          <label class="field"><span>Pickup deadline <em class="req">*</em></span><input type="datetime-local" name="pickupDeadline" required min="${localInput(now)}"></label>
          <label class="field"><span>Storage condition <em class="req">*</em></span><select name="storage" required>${Object.entries(en.storage || {}).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
          <label class="field"><span>Current temperature (°C)</span><input type="number" name="tempC" step="0.5" min="-40" max="100" placeholder="Required for hot / chilled / frozen"></label>
          <label class="field" id="expiry-field" hidden><span>Expiry / best-before date <em class="req">*</em></span><input type="datetime-local" name="expiryDate"></label>
        </div></fieldset>

        <fieldset><legend>Safety & allergens</legend>
          <div class="checks">${['milk/dairy', 'nuts', 'peanuts', 'gluten/wheat', 'soy', 'egg', 'fish', 'shellfish', 'sesame', 'mustard'].map((a) => html`<label class="check"><input type="checkbox" name="allergen" value="${a}"> ${a}</label>`)}</div>
          <label class="field"><span>Handling instructions <em class="req">*</em></span><textarea name="handlingInstructions" rows="2" required minlength="3" placeholder="e.g. Keep covered, transport in insulated box, consume within 2 hours"></textarea></label>
          <label class="field"><span>Food-safety notes</span><textarea name="safetyNotes" rows="2" placeholder="Hygiene practices, packaging, anything the NGO should know"></textarea></label>
        </fieldset>

        <fieldset><legend>Photographs</legend>
          <label class="field"><span>Real-time food photos (1–4) <em class="req">*</em></span><input type="file" name="photos" accept="image/*" capture="environment" multiple required></label>
          <div id="preview" class="photos"></div>
        </fieldset>

        <fieldset><legend>Pickup location</legend>
          <label class="field"><span>Pickup address <em class="req">*</em></span><input name="pickup.address" required minlength="5" value="${profile?.address || ''}"></label>
          <div class="grid grid-2"><label class="field"><span>Area <em class="req">*</em></span><input name="pickup.area" required value="${profile?.area || ''}"></label>
          <label class="field"><span>City <em class="req">*</em></span><input name="pickup.city" required value="${profile?.city || ''}"></label></div>
          ${locationField('pickup', 'Pickup GPS location')}
        </fieldset>
        <label class="check"><input type="checkbox" required> I confirm this food is fresh, hygienically prepared and safe to eat, and the information above is accurate.</label>
        <button type="submit" class="btn btn-primary btn-lg">Submit donation for verification</button>
      </form>
    </div>`);
  const form = $('#don-form');
  locationPicker($('.location-field', form), profile?.location || {});
  const cat = form.elements.category;
  const toggleExpiry = () => { $('#expiry-field').hidden = !['packaged', 'beverages'].includes(cat.value); };
  cat.addEventListener('change', toggleExpiry); toggleExpiry();
  form.elements.photos.addEventListener('change', (e) => {
    $('#preview').innerHTML = [...e.target.files].slice(0, 4).map((f) => `<img src="${URL.createObjectURL(f)}" alt="Selected photo">`).join('');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    if (!form.elements['pickup.lat'].value) { toast('Please set the pickup location using GPS or the map', 'error'); return; }
    if (form.elements.photos.files.length > 4) { toast('Maximum 4 photos', 'error'); return; }
    await busy(e.submitter, async () => {
      const f = form.elements;
      const body = {
        foodName: f.foodName.value, category: f.category.value, description: f.description.value,
        quantityKg: Number(f.quantityKg.value), vegType: form.querySelector('[name=vegType]:checked').value,
        preparedAt: new Date(f.preparedAt.value).toISOString(), pickupDeadline: new Date(f.pickupDeadline.value).toISOString(),
        expiryDate: f.expiryDate.value ? new Date(f.expiryDate.value).toISOString() : '',
        storage: f.storage.value, tempC: f.tempC.value,
        allergens: [...form.querySelectorAll('[name=allergen]:checked')].map((x) => x.value),
        handlingInstructions: f.handlingInstructions.value, safetyNotes: f.safetyNotes.value,
        pickup: { address: f['pickup.address'].value, area: f['pickup.area'].value, city: f['pickup.city'].value, lat: Number(f['pickup.lat'].value), lng: Number(f['pickup.lng'].value) },
        photos: await filesToDataUrls(f.photos),
      };
      const res = await post('/api/donations', body);
      toast(res.safety?.flags?.length ? `Submitted with ${res.safety.flags.length} safety flag(s) for admin review` : 'Donation submitted for verification');
      go(`/donation/${res.id}`);
    });
  });
}
