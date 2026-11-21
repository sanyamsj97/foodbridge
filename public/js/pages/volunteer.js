import { get, post, patch } from '../api.js';
import { $, html, busy, statTile, fmtNum, empty, toast } from '../ui.js';
import { donationCard } from './donor.js';

export async function board({ el, user, banner, onCleanup }) {
  const b = await get('/api/volunteer/board');
  const available = b.profile?.available !== false;
  el.innerHTML = String(html`${{ __raw: true, value: banner }}
    <div class="page-head"><div><h1>My pickups</h1><p class="muted">Check food condition at every pickup. If anything looks or smells unsafe, reject it – never transport unsafe food.</p></div>
      ${user.status === 'active' ? html`<label class="switch"><input type="checkbox" id="avail" ${{ __raw: true, value: available ? 'checked' : '' }}> <span>Available for pickups</span></label>` : ''}</div>
    <div class="stats">
      ${statTile(fmtNum(b.active.length), 'Active tasks')}
      ${statTile(fmtNum(b.profile?.completedCount || 0), 'Completed deliveries')}
      ${statTile(fmtNum(b.available.length), 'Open pickups nearby')}
    </div>
    <h2 class="section-title">Assigned to me</h2>
    <div class="grid grid-2">${b.active.length ? b.active.map((d) => donationCard(d, d.status === 'volunteer_assigned' ? html`<span class="badge badge-warn">Action needed: accept or decline</span>` : '')) : empty('No active pickups. Admin will assign pickups to you.')}</div>
    <h2 class="section-title">Available pickup requests</h2>
    <p class="muted small">Pickups accepted by an NGO that still need a volunteer. Offer to help and the admin will assign you.</p>
    <div class="grid grid-2">${b.available.length ? b.available.map((d) => html`<div>${donationCard(d)}
      ${user.status === 'active' ? (d.interested ? html`<p class="small">✔ You offered to collect this</p>` : html`<button class="btn btn-secondary btn-sm" data-interest="${d.id}">🙋 I can collect this</button>`) : ''}</div>`) : empty('No open pickup requests right now.')}</div>
    <h2 class="section-title">Completed pickups</h2>
    <div class="grid grid-2">${b.history.length ? b.history.map((d) => donationCard(d)) : empty('No completed pickups yet.')}</div>`);
  el.querySelectorAll('[data-interest]').forEach((btn) => btn.addEventListener('click', () => busy(btn, async () => {
    await post(`/api/donations/${btn.dataset.interest}/interest`);
    toast('Thanks! The admin has been notified.');
    btn.replaceWith(Object.assign(document.createElement('p'), { className: 'small', textContent: '✔ You offered to collect this' }));
  })));
  const avail = $('#avail');
  if (avail) avail.addEventListener('change', async () => {
    try { await patch('/api/auth/me/profile', { available: avail.checked }); toast(avail.checked ? 'You are available for pickups' : 'You are marked unavailable'); } catch (e) { avail.checked = !avail.checked; toast(e.message, 'error'); }
  });
  const t = setInterval(() => { if (!document.hidden && location.hash === '#/volunteer') { clearInterval(t); board({ el, user, banner, onCleanup }).catch(() => {}); } }, 60000);
  onCleanup(() => clearInterval(t));
}
