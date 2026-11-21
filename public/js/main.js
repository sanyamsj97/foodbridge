import { session, refresh, get, logout } from './api.js';
import { $, html, esc, errorToast } from './ui.js';
import * as pub from './pages/public.js';
import * as donor from './pages/donor.js';
import * as ngo from './pages/ngo.js';
import * as volunteer from './pages/volunteer.js';
import * as donation from './pages/donation.js';
import * as admin from './pages/admin.js';
import * as common from './pages/common.js';

export const state = { config: null };

const HOME = { admin: '/admin', donor: '/donor', ngo: '/ngo', volunteer: '/volunteer' };
const NAV = {
  admin: [['/admin', 'Dashboard'], ['/admin/users', 'Verifications & users'], ['/admin/donations', 'Donations'], ['/admin/live', 'Live tracking'], ['/admin/complaints', 'Complaints'], ['/admin/reports', 'Reports'], ['/admin/audit', 'Audit log'], ['/admin/settings', 'Settings']],
  donor: [['/donor', 'My donations'], ['/donor/new', 'Donate food'], ['/complaints', 'Reports & complaints'], ['/profile', 'Profile']],
  volunteer: [['/volunteer', 'My pickups'], ['/complaints', 'Report an issue'], ['/profile', 'Profile']],
  ngo: [['/ngo', 'Food donations'], ['/ngo/impact', 'Impact reports'], ['/complaints', 'Report an issue'], ['/profile', 'Profile']],
};

// [pattern, handler, roles|null(public)]
const ROUTES = [
  ['/', pub.landing, null],
  ['/login/:role', pub.login, null],
  ['/register/:role', pub.register, null],
  ['/donor', donor.dashboard, ['donor']],
  ['/donor/new', donor.newDonation, ['donor']],
  ['/ngo', ngo.board, ['ngo']],
  ['/ngo/impact', ngo.impact, ['ngo']],
  ['/volunteer', volunteer.board, ['volunteer']],
  ['/donation/:id', donation.detail, ['admin', 'donor', 'ngo', 'volunteer']],
  ['/admin', admin.dashboard, ['admin']],
  ['/admin/users', admin.users, ['admin']],
  ['/admin/users/:id', admin.userDetail, ['admin']],
  ['/admin/donations', admin.donations, ['admin']],
  ['/admin/live', admin.live, ['admin']],
  ['/admin/complaints', admin.complaints, ['admin']],
  ['/admin/reports', admin.reports, ['admin']],
  ['/admin/audit', admin.audit, ['admin']],
  ['/admin/settings', admin.settings, ['admin']],
  ['/notifications', common.notifications, ['admin', 'donor', 'ngo', 'volunteer']],
  ['/complaints', common.complaints, ['admin', 'donor', 'ngo', 'volunteer']],
  ['/profile', common.profile, ['admin', 'donor', 'ngo', 'volunteer']],
];

function match(path) {
  for (const [pattern, handler, roles] of ROUTES) {
    const pp = pattern.split('/'); const ap = path.split('/');
    if (pp.length !== ap.length) continue;
    const params = {};
    if (pp.every((p, i) => (p.startsWith(':') ? ((params[p.slice(1)] = decodeURIComponent(ap[i])), true) : p === ap[i]))) return { handler, roles, params };
  }
  return null;
}

export const go = (path) => { if (location.hash === `#${path}`) render(); else location.hash = path; };
export const homeFor = (user) => HOME[user?.role] || '/';

let cleanup = null;
let unreadTimer = null;

function layout(user) {
  const nav = $('#nav');
  const hdr = $('#user-area');
  if (!user) { nav.innerHTML = ''; hdr.innerHTML = '<a class="btn btn-ghost btn-sm" href="#/">Home</a>'; document.body.dataset.role = ''; return; }
  document.body.dataset.role = user.role;
  const path = location.hash.slice(1) || '/';
  nav.innerHTML = String(html`<ul>${NAV[user.role].map(([href, text]) => html`<li><a href="#${href}" class="${path === href ? 'active' : ''}">${text}</a></li>`)}</ul>`);
  hdr.innerHTML = String(html`
    <a href="#/notifications" class="bell" aria-label="Notifications"><span aria-hidden="true">🔔</span><span class="bell-count" id="bell-count" hidden></span></a>
    <span class="who"><strong>${user.name}</strong><small>${user.role.toUpperCase()}</small></span>
    <button class="btn btn-ghost btn-sm" id="logout-btn">Sign out</button>`);
  $('#logout-btn').onclick = async () => { const role = user.role; await logout(); go(`/login/${role}`); };
  updateUnread();
}

async function updateUnread() {
  if (!session.user) return;
  try {
    const { unread } = await get('/api/notifications/unread-count');
    const el = $('#bell-count');
    if (el) { el.hidden = !unread; el.textContent = unread > 99 ? '99+' : unread; }
  } catch { /* ignore */ }
}

export async function render() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const m = match(path);
  const el = $('#app');
  const user = session.user;
  layout(user);
  if (!m) { el.innerHTML = '<div class="card"><h1>Page not found</h1><p><a href="#/">Go home</a></p></div>'; return; }
  if (m.roles && !user) { go(`/login/${path.startsWith('/admin') ? 'admin' : (path.split('/')[1] in HOME ? path.split('/')[1] : 'donor')}`); return; }
  if (m.roles && !m.roles.includes(user.role)) { go(homeFor(user)); return; }
  if (!m.roles && user && path === '/') { go(homeFor(user)); return; }
  el.innerHTML = '<div class="loading" role="status">Loading…</div>';
  window.scrollTo(0, 0);
  try {
    const banner = user && user.status === 'pending' ? `<div class="alert alert-warn" role="status"><strong>Your account is awaiting verification.</strong> An administrator is reviewing your documents. You'll be notified once approved; until then, actions are disabled.</div>` : '';
    const ctx = { params: m.params, query: Object.fromEntries(new URLSearchParams(qs || '')), el, user, banner, config: state.config, onCleanup: (fn) => { cleanup = fn; } };
    await m.handler(ctx);
    if (banner && !el.querySelector('.alert-warn')) el.insertAdjacentHTML('afterbegin', banner);
  } catch (e) {
    el.innerHTML = `<div class="card"><h1>Could not load this page</h1><p>${esc(e.message)}</p><p><a href="#/" class="btn btn-secondary">Go home</a></p></div>`;
    if (e.status !== 403 && e.status !== 404) errorToast(e);
  }
}

window.addEventListener('hashchange', render);
document.addEventListener('click', (e) => { if (e.target.closest('[data-back]')) { e.preventDefault(); history.back(); } });
window.addEventListener('fb:logged-out', () => { const role = session.user?.role || 'donor'; session.clear(); go(`/login/${role}`); });

(async function boot() {
  try { state.config = await get('/api/public/config'); } catch { state.config = { enums: {} }; }
  await refresh(); // restore session from httpOnly refresh cookie
  await render();
  unreadTimer = setInterval(updateUnread, 30000);
  // Keep access token fresh (15 min TTL).
  setInterval(() => { if (session.user) refresh(); }, 12 * 60 * 1000);
})();
