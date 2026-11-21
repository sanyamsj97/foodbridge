import { get, post, patch, session } from '../api.js';
import { $, $$, html, label, toast, busy, badge, fmtDate, empty, filesToDataUrls, locationField, locationPicker } from '../ui.js';
import { go, state } from '../main.js';

export async function notifications({ el }) {
  const { notifications: list } = await get('/api/notifications');
  el.innerHTML = String(html`<div class="page-head"><div><h1>Notifications</h1></div>${list.some((n) => !n.read) ? html`<button class="btn btn-secondary" id="ra">Mark all as read</button>` : ''}</div>
    <div class="card"><ul class="notif-list">${list.length ? list.map((n) => html`<li class="${n.read ? '' : 'unread'}"><a href="#${n.link || '/'}" data-n="${n.id}"><strong>${n.title}</strong><span>${n.body}</span><small class="muted">${fmtDate(n.createdAt)}</small></a></li>`) : html`<li>${empty('No notifications yet.')}</li>`}</ul></div>`);
  $$('[data-n]', el).forEach((a) => a.addEventListener('click', () => { post(`/api/notifications/${a.dataset.n}/read`).catch(() => {}); }));
  const ra = $('#ra');
  if (ra) ra.addEventListener('click', () => busy(ra, async () => { await post('/api/notifications/read-all'); await notifications({ el }); }));
}

export async function complaints({ el, user, query }) {
  if (user.role === 'admin') { go('/admin/complaints'); return; }
  const { complaints: list } = await get('/api/complaints/mine');
  const types = state.config?.enums?.complaintTypes || [];
  el.innerHTML = String(html`<div class="page-head"><div><h1>Report an issue</h1><p class="muted">Report unsafe food, suspicious activity, fraud or misconduct. Reports go to FoodBridge administrators.</p></div></div>
    <div class="grid grid-2"><form class="card" id="cf"><h2>New report</h2>
      <label class="field"><span>Type <em class="req">*</em></span><select name="type" required>${types.map((t) => html`<option value="${t}">${label(t)}</option>`)}</select></label>
      <label class="field"><span>Donation ID (if related)</span><input name="donationId" value="${query.donationId || ''}"></label>
      <label class="field"><span>Describe what happened <em class="req">*</em></span><textarea name="description" rows="5" required minlength="10"></textarea></label>
      <label class="field"><span>Photos (optional, up to 3)</span><input type="file" name="photos" accept="image/*" multiple></label>
      <button class="btn btn-primary" type="submit" ${{ __raw: true, value: user.status === 'active' ? '' : 'disabled' }}>Submit report</button></form>
    <section class="card"><h2>My reports</h2>${list.length ? list.map((c) => html`<div class="party"><div class="dc-top"><strong>${label(c.type)}</strong>${badge(c.status)}</div><p class="small">${c.description}</p>${c.resolution ? html`<p class="small"><strong>Admin response:</strong> ${c.resolution}</p>` : ''}<small class="muted">${fmtDate(c.createdAt)}</small></div>`) : empty('No reports submitted.')}</section></div>`);
  $('#cf').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(e.submitter, async () => {
      if (f.photos.files.length > 3) throw new Error('Maximum 3 photos');
      await post('/api/complaints', { type: f.type.value, donationId: f.donationId.value, description: f.description.value, photos: await filesToDataUrls(f.photos) });
      toast('Report submitted to the admin team');
      await complaints({ el, user, query: {} });
    });
  });
}

export async function profile({ el, user }) {
  const { profile: p } = await get('/api/auth/me');
  const editable = user.role !== 'admin';
  el.innerHTML = String(html`<div class="page-head"><div><h1>My profile</h1><p class="muted">${user.email} · ${label(user.role)} · ${badge(user.status)}</p></div></div>
    <div class="grid grid-2">
      <form class="card" id="pf"><h2>Contact & location</h2>
        <label class="field"><span>Mobile number</span><input name="phone" type="tel" value="${user.phone}" required></label>
        ${editable && p ? html`
          <label class="field"><span>Address</span><input name="address" value="${p.address}" required></label>
          <div class="grid grid-2"><label class="field"><span>Area</span><input name="area" value="${p.area}" required></label><label class="field"><span>City</span><input name="city" value="${p.city}" required></label></div>
          ${user.role === 'ngo' ? html`<label class="field"><span>Daily capacity (kg)</span><input type="number" name="capacityKg" min="1" value="${p.capacityKg}"></label>
            <label class="check"><input type="checkbox" name="acceptsNonVeg" ${{ __raw: true, value: p.acceptsNonVeg !== false ? 'checked' : '' }}> Accept non-vegetarian food</label>
            <label class="check"><input type="checkbox" name="available" ${{ __raw: true, value: p.available !== false ? 'checked' : '' }}> Currently accepting donations</label>` : ''}
          ${locationField('location', 'GPS location')}` : ''}
        <button class="btn btn-primary" type="submit">Save</button></form>
      <div>
        <form class="card" id="pw"><h2>Change password</h2>
          <label class="field"><span>Current password</span><input type="password" name="currentPassword" required autocomplete="current-password"></label>
          <label class="field"><span>New password</span><input type="password" name="newPassword" required minlength="10" autocomplete="new-password"></label>
          <button class="btn btn-secondary" type="submit">Change password</button></form>
        ${state.config?.fcm ? html`<section class="card"><h2>Push notifications</h2><p class="small muted">Get instant alerts on this device (Firebase Cloud Messaging).</p><button class="btn btn-secondary" id="push">🔔 Enable push notifications</button></section>` : ''}
      </div></div>`);
  const pf = $('#pf');
  if (editable && p) locationPicker($('.location-field', pf), p.location || {});
  pf.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const f = pf.elements;
      const body = { phone: f.phone.value };
      if (editable && p) {
        Object.assign(body, { address: f.address.value, area: f.area.value, city: f.city.value, location: { lat: Number(f['location.lat'].value), lng: Number(f['location.lng'].value) } });
        if (user.role === 'ngo') Object.assign(body, { capacityKg: Number(f.capacityKg.value), acceptsNonVeg: f.acceptsNonVeg.checked, available: f.available.checked });
      }
      await patch('/api/auth/me/profile', body);
      toast('Profile updated');
    });
  });
  $('#pw').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await post('/api/auth/me/password', Object.fromEntries(new FormData(e.target)));
      toast('Password changed – please sign in again');
      session.clear();
      go(`/login/${user.role}`);
    });
  });
  const push = $('#push');
  if (push) push.addEventListener('click', () => busy(push, enablePush));
}

async function enablePush() {
  const { firebase, vapidKey } = state.config.fcm;
  const V = '10.12.2';
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  const { getMessaging, getToken } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-messaging.js`);
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notification permission was not granted');
  const reg = await navigator.serviceWorker.register(`/firebase-messaging-sw.js?c=${encodeURIComponent(btoa(JSON.stringify(firebase)))}`);
  const token = await getToken(getMessaging(initializeApp(firebase)), { vapidKey, serviceWorkerRegistration: reg });
  await post('/api/auth/me/push-token', { token });
  toast('Push notifications enabled on this device');
}
