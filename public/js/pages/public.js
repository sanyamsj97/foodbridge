import { post, get, session } from '../api.js';
import { $, html, esc, label, toast, busy, statTile, fmtNum, locationField, locationPicker, nest, fileToDataUrl, filesToDataUrls } from '../ui.js';
import { go, homeFor } from '../main.js';

const ROLE_INFO = {
  admin: { title: 'Admin Console', icon: '🛡️', blurb: 'Restricted access for FoodBridge administrators.', canRegister: false },
  donor: { title: 'Food Donor', icon: '🍲', blurb: 'College messes, hostels, hotels, restaurants and event organisers.', canRegister: true },
  volunteer: { title: 'Volunteer', icon: '🚲', blurb: 'Collect surplus food and deliver it safely to verified NGOs.', canRegister: true },
  ngo: { title: 'NGO Partner', icon: '🏠', blurb: 'Verified NGOs that distribute rescued food to people in need.', canRegister: true },
};

export async function landing({ el }) {
  let s = null;
  try { s = await get('/api/public/stats'); } catch { /* ignore */ }
  el.innerHTML = String(html`
    <section class="hero">
      <div>
        <h1>Rescue surplus food.<br>Feed people, not landfills.</h1>
        <p class="lead">FoodBridge connects food donors, verified volunteers and verified NGOs – with food-safety checks, GPS proof and two-stage OTP handovers at every step.</p>
        <div class="row"><a class="btn btn-primary btn-lg" href="#/register/donor">Donate food</a><a class="btn btn-secondary btn-lg" href="#/register/volunteer">Become a volunteer</a></div>
      </div>
      ${s ? html`<div class="stats stats-hero">
        ${statTile(`${fmtNum(s.totalDeliveredKg)} kg`, 'Food delivered')}
        ${statTile(fmtNum(s.estimatedMeals), 'Meals (estimated)', 'Estimate based on serving size')}
        ${statTile(fmtNum(s.successfulDonations), 'Completed donations')}
        ${statTile(fmtNum(s.verifiedNgos), 'Verified NGOs')}
      </div>` : ''}
    </section>
    <h2 class="section-title">Sign in to your portal</h2>
    <div class="grid grid-4">
      ${Object.entries(ROLE_INFO).map(([role, r]) => html`
        <a class="card role-card role-${role}" href="#/login/${role}">
          <div class="role-icon" aria-hidden="true">${r.icon}</div>
          <h3>${r.title}</h3><p class="muted">${r.blurb}</p><span class="link">Sign in →</span>
        </a>`)}
    </div>
    <h2 class="section-title">How a donation travels</h2>
    <ol class="steps">
      ${['Donor lists food with photos, prep time, storage & GPS', 'Admin verifies donor and food-safety details', 'Nearby verified NGOs are matched and one accepts', 'Admin assigns an approved volunteer', 'Volunteer checks food and confirms pickup with the donor\'s OTP', 'Volunteer delivers with photo + GPS proof', 'NGO checks food and confirms receipt with the delivery OTP', 'NGO records distribution and people served – donation completes'].map((t, i) => html`<li><span class="step-n">${i + 1}</span>${t}</li>`)}
    </ol>`);
}

export async function login({ el, params }) {
  const role = params.role;
  const r = ROLE_INFO[role];
  if (!r) { go('/'); return; }
  if (session.user) { go(homeFor(session.user)); return; }
  el.innerHTML = String(html`
    <div class="auth-wrap auth-${role}">
      <div class="card auth-card">
        <div class="auth-head"><span class="role-icon" aria-hidden="true">${r.icon}</span><div><h1>${r.title} sign in</h1><p class="muted">${r.blurb}</p></div></div>
        <form id="login-form" novalidate>
          <label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required></label>
          <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
          <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        </form>
        ${r.canRegister ? html`<p class="center">New here? <a href="#/register/${role}">Register as ${r.title.toLowerCase()}</a></p>` : html`<p class="muted small center">Admin accounts are created by the platform operator. Access is logged and may be IP-restricted.</p>`}
        <p class="center small"><a href="#/">← Choose a different portal</a></p>
      </div>
    </div>`);
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    await busy(e.submitter, async () => {
      const res = await post('/api/auth/login', { ...f, portal: role });
      session.set(res.user, res.accessToken);
      go(homeFor(res.user));
    });
  });
}

const opt = (values, labels = {}) => values.map((v) => html`<option value="${v}">${labels[v] || label(v)}</option>`);
const field = (name, text, attrs = '', type = 'text') => html`<label class="field"><span>${text}${attrs.includes('required') ? html` <em class="req">*</em>` : ''}</span><input type="${type}" name="${name}" ${{ __raw: true, value: attrs }}></label>`;
const fileField = (name, text, { required = true, multiple = false, accept = 'image/*,application/pdf', capture = false, hint = '' } = {}) => html`
  <label class="field"><span>${text}${required ? html` <em class="req">*</em>` : ''}</span>
  <input type="file" name="${name}" accept="${accept}" ${{ __raw: true, value: `${required ? 'required' : ''} ${multiple ? 'multiple' : ''} ${capture ? 'capture="environment"' : ''}` }}>
  ${hint ? html`<small class="muted">${hint}</small>` : ''}</label>`;

export async function register({ el, params, config }) {
  const role = params.role;
  const r = ROLE_INFO[role];
  if (!r || !r.canRegister) { go('/'); return; }
  const en = config?.enums || {};
  const common = html`
    <fieldset><legend>Contact person</legend><div class="grid grid-2">
      ${field('name', role === 'ngo' ? 'Authorised representative name' : 'Full name', 'required minlength="2"')}
      ${field('phone', 'Mobile number', 'required placeholder="+91 98xxxxxxx"', 'tel')}
      ${field('email', 'Email', 'required autocomplete="email"', 'email')}
      ${field('password', 'Password', 'required minlength="10" autocomplete="new-password"', 'password')}
    </div><small class="muted">Password: at least 10 characters with letters and numbers.</small></fieldset>
    <fieldset><legend>Address</legend>
      ${field('address', 'Full address', 'required minlength="5"')}
      <div class="grid grid-2">${field('area', 'Area / locality', 'required')}${field('city', 'City', 'required')}</div>
      ${locationField('location', 'GPS location')}
    </fieldset>`;
  const specific = {
    donor: html`<fieldset><legend>Organisation</legend><div class="grid grid-2">
        ${field('orgName', 'Organisation name', 'required')}
        <label class="field"><span>Organisation type <em class="req">*</em></span><select name="orgType" required>${opt(en.orgTypes || [])}</select></label>
        <label class="field"><span>Identity / business document type <em class="req">*</em></span><select name="idType" required>${opt(en.idTypes || [], { gst: 'GST certificate', fssai: 'FSSAI licence', pan: 'PAN' })}</select></label>
        ${field('idNumber', 'Document number', 'required')}
        ${field('fssaiLicense', 'FSSAI licence number (if any)')}
      </div>${fileField('idDocument', 'Upload identity / registration document', { hint: 'Photo or PDF (max 650 KB). Only the last 4 digits of the number are stored.' })}</fieldset>`,
    volunteer: html`<fieldset><legend>Identity verification</legend><div class="grid grid-2">
        <label class="field"><span>Government ID type <em class="req">*</em></span><select name="govIdType" required>${opt((en.idTypes || []).filter((x) => !['gst', 'fssai'].includes(x)), { pan: 'PAN', voter_id: 'Voter ID' })}</select></label>
        ${field('govIdNumber', 'ID number', 'required')}
        <label class="field"><span>Vehicle <em class="req">*</em></span><select name="vehicleType" required>${opt(en.vehicles || [])}</select></label>
        ${field('emergencyContact', 'Emergency contact (name & phone)')}
      </div>
      <div class="alert alert-info small">For Aadhaar, upload a <strong>masked Aadhaar</strong> (first 8 digits hidden). FoodBridge stores only the last 4 digits of any ID number. Documents are visible only to administrators.</div>
      ${fileField('idDocument', 'Upload government ID')}
      ${fileField('profilePhoto', 'Profile photograph', { accept: 'image/*', capture: true })}</fieldset>`,
    ngo: html`<fieldset><legend>NGO registration</legend><div class="grid grid-2">
        ${field('registeredName', 'NGO registered name', 'required')}
        ${field('registrationNumber', 'Registration number', 'required')}
        ${field('pan', 'NGO PAN (where applicable)')}
        ${field('repDesignation', 'Representative designation', 'required')}
        ${field('operatingArea', 'Operating locations / areas served', 'required')}
        ${field('capacityKg', 'Daily food handling capacity (kg)', 'required min="1" step="1"', 'number')}
      </div>
      <label class="check"><input type="checkbox" name="acceptsNonVeg" checked> We can accept non-vegetarian food</label>
      <label class="check"><input type="checkbox" name="fcraApplicable" id="fcra-toggle"> FCRA registration is applicable to us</label>
      <div id="fcra-fields" hidden>${field('fcraNumber', 'FCRA registration number')}${fileField('fcraDocument', 'FCRA certificate', { required: false })}</div>
      ${fileField('registrationCertificate', 'Registration certificate')}
      ${fileField('panDocument', 'PAN card (optional)', { required: false })}
      ${fileField('orgPhotos', 'Organisation photographs (1–3)', { accept: 'image/*', multiple: true })}
      <p class="muted small">Bank details are not collected – FoodBridge does not handle money.</p></fieldset>`,
  }[role];

  el.innerHTML = String(html`
    <div class="card form-card">
      <div class="auth-head"><span class="role-icon" aria-hidden="true">${r.icon}</span><div><h1>Register as ${r.title.toLowerCase()}</h1><p class="muted">Your account is activated after an administrator manually verifies your documents.</p></div></div>
      <form id="reg-form" novalidate>${common}${specific}
        <label class="check"><input type="checkbox" required name="consent"> I confirm the information is true and consent to FoodBridge verifying my documents.</label>
        <button class="btn btn-primary btn-lg" type="submit">Submit registration</button>
        <p class="small">Already registered? <a href="#/login/${role}">Sign in</a></p>
      </form>
    </div>`);
  const form = $('#reg-form');
  locationPicker($('.location-field', form));
  const fcra = $('#fcra-toggle');
  if (fcra) fcra.addEventListener('change', () => { $('#fcra-fields').hidden = !fcra.checked; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    if (!form.elements['location.lat'].value) { toast('Please set your location using GPS or the map', 'error'); return; }
    await busy(e.submitter, async () => {
      const fd = Object.fromEntries(new FormData(form));
      for (const k of Object.keys(fd)) if (fd[k] instanceof File) delete fd[k];
      const body = nest(fd);
      delete body.consent;
      if (role === 'ngo') {
        body.acceptsNonVeg = Boolean(form.elements.acceptsNonVeg.checked);
        body.fcraApplicable = Boolean(form.elements.fcraApplicable.checked);
        body.registrationCertificate = await fileToDataUrl(form.elements.registrationCertificate.files[0]);
        if (form.elements.panDocument.files[0]) body.panDocument = await fileToDataUrl(form.elements.panDocument.files[0]);
        if (body.fcraApplicable && form.elements.fcraDocument.files[0]) body.fcraDocument = await fileToDataUrl(form.elements.fcraDocument.files[0]);
        body.orgPhotos = (await filesToDataUrls(form.elements.orgPhotos)).slice(0, 3);
      } else {
        body.idDocument = await fileToDataUrl(form.elements.idDocument.files[0]);
        if (role === 'volunteer') body.profilePhoto = await fileToDataUrl(form.elements.profilePhoto.files[0]);
      }
      const res = await post(`/api/auth/register/${role}`, body);
      el.innerHTML = String(html`<div class="card form-card center"><div class="big-icon" aria-hidden="true">✅</div><h1>Registration submitted</h1><p>${res.message}</p><a class="btn btn-primary" href="#/login/${role}">Go to sign in</a></div>`);
    });
  });
}

export { ROLE_INFO, esc };
