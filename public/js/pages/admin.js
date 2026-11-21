import { get, post, patch, put, download } from '../api.js';
import { $, $$, html, raw, esc, label, toast, busy, badge, vegBadge, fmtDate, fmtNum, statTile, empty, photoGrid, hydrateFiles, modal, reasonBox, makeMap } from '../ui.js';

const STATUSES = ['pending_review', 'approved', 'ngo_accepted', 'volunteer_assigned', 'in_pickup', 'picked_up', 'awaiting_receipt', 'received', 'distributed', 'completed', 'rejected', 'unsafe_rejected', 'cancelled', 'expired'];

export async function dashboard({ el }) {
  const m = await get('/api/admin/dashboard');
  const maxKg = Math.max(1, ...m.areas.map((a) => a.donatedKg));
  el.innerHTML = String(html`
    <div class="page-head"><div><h1>Admin dashboard</h1><p class="muted">Updated ${fmtDate(m.generatedAt)}</p></div>
      <div class="row">${m.pendingVerifications ? html`<a class="btn btn-primary" href="#/admin/users?status=pending">${m.pendingVerifications} pending verification(s)</a>` : ''}
      ${m.byStatus.pending_review ? html`<a class="btn btn-secondary" href="#/admin/donations?status=pending_review">${m.byStatus.pending_review} donation(s) to review</a>` : ''}
      ${m.openComplaints ? html`<a class="btn btn-secondary" href="#/admin/complaints">${m.openComplaints} open complaint(s)</a>` : ''}</div></div>
    <div class="stats">
      ${statTile(`${fmtNum(m.totalDonatedKg)} kg`, 'Total food donated', 'Excludes rejected/cancelled')}
      ${statTile(`${fmtNum(m.totalDeliveredKg)} kg`, 'Food delivered to NGOs')}
      ${statTile(`${fmtNum(m.foodWastePreventedKg)} kg`, 'Food waste prevented', 'Distributed in completed donations')}
      ${statTile(fmtNum(m.estimatedMeals), 'Meals provided (estimated)', `Assumes ${m.servingSizeKg} kg per meal – not verified beneficiaries`)}
      ${statTile(fmtNum(m.peopleServedReported), 'People served (NGO-reported)')}
      ${statTile(fmtNum(m.successfulDonations), 'Successful donations')}
      ${statTile(fmtNum(m.rejectedDonations), 'Rejected donations', `${m.unsafeRejected} rejected as unsafe`)}
      ${statTile(fmtNum(m.verifiedNgos), 'Verified NGOs')}
      ${statTile(fmtNum(m.activeVolunteers), 'Active volunteers')}
      ${statTile(fmtNum(m.totalDonors), 'Verified donors')}
    </div>
    <div class="grid grid-2">
      <section class="card"><h2>Donations by status</h2>
        <table class="table"><thead><tr><th>Status</th><th class="num">Count</th></tr></thead><tbody>
        ${STATUSES.filter((s) => m.byStatus[s]).map((s) => html`<tr><td><a href="#/admin/donations?status=${s}">${badge(s)}</a></td><td class="num">${m.byStatus[s]}</td></tr>`)}
        ${!m.totalDonations ? html`<tr><td colspan="2">${empty('No donations yet.')}</td></tr>` : ''}</tbody></table></section>
      <section class="card"><h2>Area-wise donations</h2><p class="muted small">Food donated (kg) by pickup area</p>
        <table class="table area-table"><thead><tr><th>Area</th><th>Donated kg</th><th class="num">Delivered kg</th><th class="num">Donations</th></tr></thead><tbody>
        ${m.areas.slice(0, 15).map((a) => html`<tr><td>${a.area}</td><td><div class="bar-cell" title="${a.area}: ${a.donatedKg} kg donated"><span class="bar" style="width:${Math.max(2, (a.donatedKg / maxKg) * 100)}%"></span><span class="bar-val">${fmtNum(a.donatedKg)}</span></div></td><td class="num">${fmtNum(a.deliveredKg)}</td><td class="num">${a.donations}</td></tr>`)}
        ${!m.areas.length ? html`<tr><td colspan="4">${empty('No data yet.')}</td></tr>` : ''}</tbody></table></section>
    </div>`);
}

export async function users({ el, query }) {
  const role = query.role || ''; const status = query.status || '';
  const { users: list } = await get(`/api/admin/users?role=${encodeURIComponent(role)}&status=${encodeURIComponent(status)}`);
  el.innerHTML = String(html`
    <div class="page-head"><div><h1>Verifications & users</h1><p class="muted">Review identity and organisation documents before approving accounts.</p></div></div>
    <form class="card row filters" id="uf">
      <label class="field"><span>Role</span><select name="role"><option value="">All</option>${['donor', 'volunteer', 'ngo', 'admin'].map((r) => html`<option value="${r}" ${raw(r === role ? 'selected' : '')}>${label(r)}</option>`)}</select></label>
      <label class="field"><span>Status</span><select name="status"><option value="">All</option>${['pending', 'active', 'rejected', 'suspended'].map((s) => html`<option value="${s}" ${raw(s === status ? 'selected' : '')}>${label(s)}</option>`)}</select></label>
      <button class="btn btn-secondary" type="submit">Filter</button></form>
    <div class="card"><table class="table"><thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Phone</th><th>Status</th><th>Registered</th><th></th></tr></thead><tbody>
    ${list.length ? list.map((u) => html`<tr><td>${u.name}</td><td>${label(u.role)}</td><td>${u.email}</td><td>${u.phone}</td><td>${badge(u.status)}</td><td>${fmtDate(u.createdAt)}</td><td><a class="btn btn-sm btn-secondary" href="#/admin/users/${u.id}">Review</a></td></tr>`) : html`<tr><td colspan="7">${empty('No users match.')}</td></tr>`}
    </tbody></table></div>`);
  $('#uf').addEventListener('submit', (e) => { e.preventDefault(); const f = new FormData(e.target); location.hash = `/admin/users?role=${f.get('role')}&status=${f.get('status')}`; });
}

const docLink = (id, text) => (id ? html`<a href="#" data-file-link="${id}" class="btn btn-sm btn-ghost">📄 ${text}</a>` : '');

export async function userDetail(ctx) {
  const { el, params } = ctx;
  const { user: u, profile: p, documents, history } = await get(`/api/admin/users/${params.id}`);
  const pRows = p ? Object.entries(p).filter(([k]) => !['id', 'userId', 'idDocFileId', 'photoFileId', 'createdAt', 'updatedAt', 'location', 'representative'].includes(k)) : [];
  el.innerHTML = String(html`
    <p><a href="#/admin/users">← All users</a></p>
    <div class="page-head"><div><h1>${u.name}</h1><p class="muted">${label(u.role)} · ${u.email} · ${u.phone}</p></div>${badge(u.status)}</div>
    ${u.statusReason ? html`<div class="alert alert-warn">Reason: ${u.statusReason}</div>` : ''}
    <div class="row actions-row">
      ${u.status === 'pending' ? html`<button class="btn btn-primary" data-a="approve">✔ Approve</button><button class="btn btn-danger-outline" data-a="reject">Reject</button>` : ''}
      ${['active', 'pending'].includes(u.status) && u.role !== 'admin' ? html`<button class="btn btn-danger" data-a="suspend">⛔ Suspend account</button>` : ''}
      ${u.status === 'suspended' ? html`<button class="btn btn-secondary" data-a="reactivate">Reactivate</button>` : ''}
    </div>
    <div class="detail-grid"><div>
      <section class="card"><h2>Profile</h2><dl class="dl">
        ${pRows.map(([k, v]) => html`<dt>${label(k)}</dt><dd>${typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v ?? '—'}</dd>`)}
        ${p?.representative ? html`<dt>Representative</dt><dd>${p.representative.name}, ${p.representative.designation} · ${p.representative.phone} · ${p.representative.email}</dd>` : ''}
        ${p?.location ? html`<dt>GPS</dt><dd>${p.location.lat}, ${p.location.lng}</dd>` : ''}
        <dt>Last login</dt><dd>${fmtDate(u.lastLoginAt)}</dd></dl>
        ${p?.location ? html`<div class="map map-sm" id="u-map"></div>` : ''}</section>
      <section class="card"><h2>Identity documents</h2><p class="muted small">Confidential. Visible only to administrators and the account owner.</p>
        ${p?.photoFileId ? html`<img class="avatar-lg" data-file="${p.photoFileId}" alt="Profile photo">` : ''}
        <div class="row">${docLink(p?.idDocFileId, `${label(p?.idType || p?.govIdType || 'ID')} document (${p?.idNumberMasked || p?.govIdNumberMasked || ''})`)}</div>
        ${documents.length ? html`<table class="table"><thead><tr><th>Document</th><th>Required</th><th>Status</th><th>File</th><th></th></tr></thead><tbody>
          ${documents.map((d) => html`<tr><td>${label(d.type)}</td><td>${d.required ? 'Yes' : 'No'}</td><td>${badge(d.status === 'pending' ? 'pending' : d.status === 'verified' ? 'verified' : 'rejected', label(d.status))}${d.note ? html`<div class="small">${d.note}</div>` : ''}</td><td>${docLink(d.fileId, 'View')}</td>
          <td>${d.status !== 'verified' ? html`<button class="btn btn-sm btn-primary" data-doc="${d.id}" data-s="verified">Verify</button>` : ''} ${d.status !== 'rejected' ? html`<button class="btn btn-sm btn-ghost" data-doc="${d.id}" data-s="rejected">Reject</button>` : ''}</td></tr>`)}
        </tbody></table>` : ''}
        ${u.role === 'ngo' ? html`<p class="small muted">All required documents must be verified before the NGO can be approved.</p>` : ''}</section>
    </div><div>
      <section class="card"><h2>Activity</h2><ul class="audit">${history.length ? history.map((l) => html`<li><code>${l.action}</code> by ${l.actorName} <span class="small muted">${fmtDate(l.at)}</span></li>`) : html`<li class="muted">No activity.</li>`}</ul>
      <a class="small" href="#/admin/audit?actorId=${u.id}">Full audit trail of actions by this user →</a></section>
    </div></div>`);
  hydrateFiles(el);
  if (p?.location) { const map = makeMap($('#u-map'), [p.location.lat, p.location.lng], 14); if (map) window.L.marker([p.location.lat, p.location.lng]).addTo(map); }
  $$('[data-a]', el).forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.a;
    let body = {};
    if (['reject', 'suspend'].includes(a)) { const r = await reasonBox(`${label(a)} ${u.name}`, { submitText: label(a), danger: true }); if (!r) return; body = r; }
    await busy(b, async () => { await post(`/api/admin/users/${u.id}/${a}`, body); toast(`Account ${({ approve: 'approved', reject: 'rejected', suspend: 'suspended', reactivate: 'reactivated' })[a]}`); await userDetail(ctx); });
  }));
  $$('[data-doc]', el).forEach((b) => b.addEventListener('click', async () => {
    let note = '';
    if (b.dataset.s === 'rejected') { const r = await modal('Reject document', '<label class="field"><span>Note to NGO <em class="req">*</em></span><textarea name="note" required rows="2"></textarea></label>', { submitText: 'Reject', danger: true }); if (!r) return; note = r.note; }
    await busy(b, async () => { await post(`/api/admin/ngo-documents/${b.dataset.doc}/review`, { status: b.dataset.s, note }); await userDetail(ctx); });
  }));
}

export async function donations({ el, query }) {
  const status = query.status || '';
  const { donations: list } = await get(`/api/admin/donations?status=${encodeURIComponent(status)}`);
  el.innerHTML = String(html`
    <div class="page-head"><div><h1>Donations</h1></div></div>
    <form class="card row filters" id="df"><label class="field"><span>Status</span><select name="status"><option value="">All</option>${STATUSES.map((s) => html`<option value="${s}" ${raw(s === status ? 'selected' : '')}>${label(s)}</option>`)}</select></label><button class="btn btn-secondary">Filter</button></form>
    <div class="card"><table class="table"><thead><tr><th>Listed</th><th>Food</th><th>Donor</th><th class="num">kg</th><th>Area</th><th>NGO</th><th>Volunteer</th><th>Status</th></tr></thead><tbody>
    ${list.length ? list.map((d) => html`<tr><td>${fmtDate(d.createdAt)}</td><td><a href="#/donation/${d.id}">${d.foodName}</a> ${vegBadge(d.vegType)}${d.flags ? html` <span class="warn-text" title="Safety flags">⚠${d.flags}</span>` : ''}</td><td>${d.donorOrg}</td><td class="num">${d.quantityKg}</td><td>${d.area}</td><td>${d.ngoName || '—'}</td><td>${d.volunteerName || '—'}</td><td>${badge(d.status)}</td></tr>`) : html`<tr><td colspan="8">${empty('No donations.')}</td></tr>`}
    </tbody></table></div>`);
  $('#df').addEventListener('submit', (e) => { e.preventDefault(); location.hash = `/admin/donations?status=${new FormData(e.target).get('status')}`; });
}

export async function live({ el, onCleanup }) {
  el.innerHTML = String(html`<div class="page-head"><div><h1>Live collection tracking</h1><p class="muted">Auto-refreshes every 20 seconds.</p></div></div>
    <section class="card"><div class="map map-lg" id="live-map"></div><p class="small muted">● Pickup location · ◆ Pickup GPS · ■ Delivery GPS · ⌂ NGO</p></section><div id="live-list"></div>`);
  const map = makeMap($('#live-map'));
  const layer = map ? window.L.layerGroup().addTo(map) : null;
  let first = true;
  const icon = (ch) => window.L.divIcon({ className: 'map-pin', html: `<span>${ch}</span>`, iconSize: [24, 24] });
  const load = async () => {
    const { donations: list } = await get('/api/admin/live');
    $('#live-list').innerHTML = String(html`<div class="card"><table class="table"><thead><tr><th>Food</th><th class="num">kg</th><th>Donor → NGO</th><th>Volunteer</th><th>Status</th><th>Updated</th></tr></thead><tbody>
      ${list.length ? list.map((d) => html`<tr><td><a href="#/donation/${d.id}">${d.foodName}</a></td><td class="num">${d.quantityKg}</td><td>${d.donorOrg} → ${d.ngoName || '…'}</td><td>${d.volunteerName || '—'}</td><td>${badge(d.status)}</td><td>${fmtDate(d.updatedAt)}</td></tr>`) : html`<tr><td colspan="6">${empty('No active collections.')}</td></tr>`}</tbody></table></div>`);
    if (layer) {
      layer.clearLayers();
      const pts = [];
      for (const d of list) {
        const add = (p, ch, t) => { if (p?.lat != null) { window.L.marker([p.lat, p.lng], { icon: icon(ch) }).bindPopup(`<a href="#/donation/${esc(d.id)}">${esc(d.foodName)}</a><br>${esc(t)}`).addTo(layer); pts.push([p.lat, p.lng]); } };
        add(d.pickupLocation, '●', `Pickup – ${d.donorOrg}`); add(d.pickupGps, '◆', 'Pickup GPS'); add(d.deliveryGps, '■', 'Delivery GPS'); add(d.ngoLocation, '⌂', `NGO – ${d.ngoName || ''}`);
      }
      if (first && pts.length) { map.fitBounds(pts, { padding: [30, 30], maxZoom: 14 }); first = false; }
    }
  };
  await load();
  const t = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 20000);
  onCleanup(() => clearInterval(t));
}

export async function complaints(ctx) {
  const { el, query } = ctx;
  const { complaints: list } = await get(`/api/admin/complaints?status=${encodeURIComponent(query.status || '')}`);
  el.innerHTML = String(html`<div class="page-head"><div><h1>Complaints & reports</h1></div></div>
    <div class="grid">${list.length ? list.map((c) => html`<section class="card"><div class="dc-top"><h3>${label(c.type)}</h3>${badge(c.status)}</div>
      <p>${c.description}</p><p class="small muted">By ${c.reporterName} (${c.reporterRole}) · ${fmtDate(c.createdAt)}${c.donationId ? html` · <a href="#/donation/${c.donationId}">Donation</a>` : ''}${c.againstUserId ? html` · <a href="#/admin/users/${c.againstUserId}">Reported user</a>` : ''} · <a href="#/admin/users/${c.reporterId}">Reporter</a></p>
      ${c.photoFileIds?.length ? photoGrid(c.photoFileIds) : ''}
      ${c.resolution ? html`<p><strong>Resolution:</strong> ${c.resolution}</p>` : ''}
      ${['open', 'investigating'].includes(c.status) ? html`<div class="row">${c.status === 'open' ? html`<button class="btn btn-sm btn-secondary" data-c="${c.id}" data-s="investigating">Start investigating</button>` : ''}<button class="btn btn-sm btn-primary" data-c="${c.id}" data-s="resolved">Resolve</button><button class="btn btn-sm btn-ghost" data-c="${c.id}" data-s="dismissed">Dismiss</button></div>` : ''}
    </section>`) : empty('No complaints.')}</div>`);
  hydrateFiles(el);
  $$('[data-c]', el).forEach((b) => b.addEventListener('click', async () => {
    let resolution = '';
    if (b.dataset.s !== 'investigating') { const r = await modal(`${label(b.dataset.s)} complaint`, '<label class="field"><span>Resolution / findings <em class="req">*</em></span><textarea name="resolution" required rows="3"></textarea></label><p class="small muted">To block a fraudulent account, open the user and suspend it.</p>', { submitText: label(b.dataset.s) }); if (!r) return; resolution = r.resolution; }
    await busy(b, async () => { await patch(`/api/admin/complaints/${b.dataset.c}`, { status: b.dataset.s, resolution }); await complaints(ctx); });
  }));
}

export async function reports({ el }) {
  const today = new Date().toISOString().slice(0, 10);
  el.innerHTML = String(html`<div class="page-head"><div><h1>Reports</h1><p class="muted">Daily, weekly, monthly and yearly reports (India Standard Time). Export to PDF or Excel.</p></div></div>
    <form class="card row filters" id="rf">
      <label class="field"><span>Period</span><select name="period">${['daily', 'weekly', 'monthly', 'yearly'].map((p) => html`<option value="${p}" ${raw(p === 'monthly' ? 'selected' : '')}>${label(p)}</option>`)}</select></label>
      <label class="field"><span>Date within period</span><input type="date" name="date" value="${today}"></label>
      <button class="btn btn-primary" type="submit">Generate</button>
      <button class="btn btn-secondary" type="button" data-x="pdf">⬇ PDF</button><button class="btn btn-secondary" type="button" data-x="xlsx">⬇ Excel</button></form>
    <div id="rout"></div>`);
  const f = $('#rf');
  const qs = () => `period=${f.elements.period.value}&date=${f.elements.date.value}`;
  const show = async () => {
    const r = await get(`/api/admin/reports?${qs()}`);
    const m = r.metrics;
    $('#rout').innerHTML = String(html`<h2 class="section-title">${r.label}</h2>
      <div class="stats">${statTile(fmtNum(m.totalDonations), 'Donations')}${statTile(fmtNum(m.successfulDonations), 'Completed')}${statTile(fmtNum(m.rejectedDonations), 'Rejected')}${statTile(`${fmtNum(m.totalDonatedKg)} kg`, 'Donated')}${statTile(`${fmtNum(m.totalDeliveredKg)} kg`, 'Delivered')}${statTile(fmtNum(m.estimatedMeals), 'Meals (estimated)')}${statTile(fmtNum(m.peopleServedReported), 'People served (reported)')}</div>
      <div class="card"><table class="table"><thead><tr><th>Date</th><th>Donor</th><th>Food</th><th class="num">kg</th><th class="num">Received</th><th>NGO</th><th>Volunteer</th><th>Status</th></tr></thead><tbody>
      ${r.rows.length ? r.rows.map((x) => html`<tr><td>${fmtDate(x.createdAt)}</td><td>${x.donor}</td><td><a href="#/donation/${x.id}">${x.food}</a></td><td class="num">${x.quantityKg}</td><td class="num">${x.receivedKg}</td><td>${x.ngo}</td><td>${x.volunteer}</td><td>${badge(x.status)}</td></tr>`) : html`<tr><td colspan="8">${empty('No donations in this period.')}</td></tr>`}</tbody></table></div>`);
  };
  f.addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, show); });
  $$('[data-x]', f).forEach((b) => b.addEventListener('click', () => busy(b, () => download(`/api/admin/reports/export?${qs()}&format=${b.dataset.x}`, `foodbridge-${f.elements.period.value}-report.${b.dataset.x}`))));
  await show();
}

export async function audit({ el, query }) {
  const q = query.entityId ? `entityId=${encodeURIComponent(query.entityId)}` : query.actorId ? `actorId=${encodeURIComponent(query.actorId)}` : '';
  const { logs } = await get(`/api/admin/audit?limit=300&${q}`);
  el.innerHTML = String(html`<div class="page-head"><div><h1>Audit log</h1><p class="muted">${q ? 'Filtered view' : 'Latest 300 events'} · every important action is recorded and cannot be edited from the app.</p></div>
    <div class="row">${q ? html`<a class="btn btn-ghost" href="#/admin/audit">Clear filter</a>` : ''}<button class="btn btn-secondary" id="ax">⬇ Export Excel</button></div></div>
    <div class="card"><table class="table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>IP</th><th>Details</th></tr></thead><tbody>
    ${logs.map((l) => html`<tr><td class="nowrap">${fmtDate(l.at)}</td><td>${l.actorName} <small class="muted">${l.actorRole}</small></td><td><code>${l.action}</code></td><td>${l.entityType === 'food_donation' ? html`<a href="#/donation/${l.entityId}">donation</a>` : l.entityType === 'user' ? html`<a href="#/admin/users/${l.entityId}">user</a>` : l.entityType}</td><td class="small">${l.ip || ''}</td><td class="small details">${JSON.stringify(l.details || {}).slice(0, 200)}</td></tr>`)}
    </tbody></table></div>`);
  $('#ax').addEventListener('click', (e) => busy(e.target, () => download('/api/admin/audit/export', 'foodbridge-audit-log.xlsx')));
}

export async function settings({ el }) {
  const s = await get('/api/admin/settings');
  const F = [
    ['servingSizeKg', 'Serving size per meal (kg)', '0.05', 'Used only to ESTIMATE meals. Estimated meals are never treated as verified beneficiaries.'],
    ['matchRadiusKm', 'NGO matching radius (km)', '1', ''], ['maxOffers', 'NGOs offered per donation', '1', ''],
    ['otpTtlMinutes', 'OTP validity (minutes)', '1', ''], ['otpMaxAttempts', 'Max wrong OTP attempts', '1', ''],
    ['otpMaxRegenerations', 'Max OTP regenerations', '1', ''], ['gpsToleranceKm', 'GPS mismatch tolerance (km)', '0.1', 'Pickup/delivery GPS further than this from the registered location is flagged.'],
  ];
  el.innerHTML = String(html`<div class="card form-card"><h1>Platform settings</h1><form id="sf">
    ${F.map(([k, t, step, hint]) => html`<label class="field"><span>${t}</span><input type="number" name="${k}" step="${step}" value="${s[k]}" required>${hint ? html`<small class="muted">${hint}</small>` : ''}</label>`)}
    <button class="btn btn-primary" type="submit">Save settings</button></form>
    <p class="small muted">Food-safety time and temperature limits are fixed in code (src/lib/safety.js) so they cannot be loosened from the UI.</p></div>`);
  $('#sf').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, async () => { await put('/api/admin/settings', Object.fromEntries(new FormData(e.target))); toast('Settings saved'); }); });
}
