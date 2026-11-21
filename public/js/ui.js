import { fileUrl } from './api.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Safe HTML string: interpolated values are escaped unless they are themselves raw()/html results. */
export const raw = (value) => ({ __raw: true, value: String(value ?? ''), toString() { return this.value; } });
const part = (v) => (v == null || v === false ? '' : v.__raw ? v.value : Array.isArray(v) ? v.map(part).join('') : esc(v));
export function html(strings, ...vals) {
  return raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));
}

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '—');
export const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
export const label = (s) => String(s ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export function timeLeft(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'passed';
  const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m left` : `${m}m left`;
}
/** Value for <input type="datetime-local"> in local time. */
export function localInput(date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

// Status: icon + label + tone (never colour alone).
const STATUS = {
  pending_review: ['⏳', 'Awaiting admin review', 'warn'],
  approved: ['✓', 'Approved · finding NGO', 'info'],
  ngo_accepted: ['🏠', 'NGO accepted · needs volunteer', 'info'],
  volunteer_assigned: ['👤', 'Volunteer assigned', 'info'],
  in_pickup: ['🚲', 'Volunteer en route', 'info'],
  picked_up: ['📦', 'Picked up · in transit', 'info'],
  awaiting_receipt: ['📍', 'Arrived · NGO verifying', 'info'],
  received: ['✓', 'Received by NGO', 'good'],
  distributed: ['🍽', 'Distributed', 'info'],
  completed: ['✔', 'Completed', 'good'],
  rejected: ['✕', 'Rejected', 'bad'],
  cancelled: ['✕', 'Cancelled', 'neutral'],
  expired: ['⌛', 'Expired', 'neutral'],
  unsafe_rejected: ['⚠', 'Rejected as unsafe', 'bad'],
  pending: ['⏳', 'Pending verification', 'warn'],
  active: ['✔', 'Active', 'good'],
  suspended: ['⛔', 'Suspended', 'bad'],
  verified: ['✔', 'Verified', 'good'],
  open: ['●', 'Open', 'warn'],
  investigating: ['🔎', 'Investigating', 'info'],
  resolved: ['✔', 'Resolved', 'good'],
  dismissed: ['–', 'Dismissed', 'neutral'],
  pass: ['✔', 'Pass', 'good'],
  flag: ['⚠', 'Flagged', 'warn'],
  fail: ['✕', 'Fail', 'bad'],
};
export function badge(status, text) {
  const [icon, lbl, tone] = STATUS[status] || ['•', label(status), 'neutral'];
  return raw(`<span class="badge badge-${tone}"><span aria-hidden="true">${icon}</span> ${esc(text || lbl)}</span>`);
}
export const vegBadge = (v) => raw(v === 'veg' ? '<span class="veg veg-yes" title="Vegetarian"><span aria-hidden="true">●</span> Veg</span>' : '<span class="veg veg-no" title="Non-vegetarian"><span aria-hidden="true">▲</span> Non-veg</span>');

export function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, type === 'error' ? 7000 : 4000);
}
export const errorToast = (e) => toast(e?.message || 'Something went wrong', 'error');

/** Modal dialog; resolves with FormData object or null. */
export function modal(title, bodyHtml, { submitText = 'Confirm', danger = false, wide = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<form class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="mt">
      <h2 id="mt">${esc(title)}</h2><div class="modal-body">${bodyHtml}</div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button>
      <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(submitText)}</button></div></form>`;
    const close = (v) => { wrap.remove(); resolve(v); };
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.hasAttribute('data-close')) close(null); });
    wrap.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const out = Object.fromEntries(new FormData(e.target));
      e.target.querySelectorAll('input[type=file]').forEach((i) => { out[i.name] = [...i.files]; });
      close(out);
    });
    document.body.appendChild(wrap);
    (wrap.querySelector('input,textarea,select') || wrap.querySelector('button[type=submit]')).focus();
  });
}
export const confirmBox = (title, text, opts) => modal(title, `<p>${esc(text)}</p>`, opts);
export const reasonBox = (title, { submitText = 'Submit', danger = false, placeholder = '' } = {}) => modal(title, `<label class="field"><span>Reason</span><textarea name="reason" required minlength="5" rows="3" placeholder="${esc(placeholder)}"></textarea></label>`, { submitText, danger });

/** Run an async action with button busy state and error toast. */
export async function busy(btn, fn) {
  if (btn) { btn.disabled = true; btn.dataset.txt = btn.textContent; btn.textContent = 'Please wait…'; }
  try { return await fn(); } catch (e) { errorToast(e); return undefined; } finally { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.txt; } }
}

// ---------- images & files
const MAX_BYTES = 650 * 1024;
function loadImage(file) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('Could not read image')); img.src = URL.createObjectURL(file); });
}
/** Compress an image client-side (Firestore stores files ≤ ~700 KB). */
export async function compressImage(file, maxDim = 1280) {
  const img = await loadImage(file);
  let scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.8, 0.7, 0.6, 0.5]) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (url.length * 0.75 < MAX_BYTES) return url;
    }
    scale *= 0.75;
  }
  throw new Error('Image is too large even after compression');
}
export async function fileToDataUrl(file) {
  if (file.type.startsWith('image/')) return compressImage(file);
  if (file.type !== 'application/pdf') throw new Error('Only images or PDF files are allowed');
  if (file.size > MAX_BYTES) throw new Error('PDF must be smaller than 650 KB – please upload a photo/scan instead');
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read file')); r.readAsDataURL(file); });
}
export async function filesToDataUrls(input) { return Promise.all([...(Array.isArray(input) ? input : input?.files || [])].map(fileToDataUrl)); }

/** Fill <img data-file="id"> / <a data-file-link> elements with protected file content. */
export function hydrateFiles(root = document) {
  $$('img[data-file]', root).forEach(async (img) => {
    try { img.src = await fileUrl(img.dataset.file); } catch { img.alt = 'Image unavailable'; img.classList.add('img-missing'); }
  });
  $$('a[data-file-link]', root).forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    try { window.open(await fileUrl(a.dataset.fileLink), '_blank', 'noopener'); } catch (err) { errorToast(err); }
  }));
}
export const photoGrid = (ids = []) => (ids.length ? raw(`<div class="photos">${ids.map((id) => `<a href="#" data-file-link="${esc(id)}"><img data-file="${esc(id)}" alt="Uploaded photo" loading="lazy"></a>`).join('')}</div>`) : raw('<p class="muted">No photos</p>'));

// ---------- GPS & maps (Leaflet + OpenStreetMap: free, no API key)
export function getGps() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('GPS not supported on this device'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), accuracy: Math.round(p.coords.accuracy) }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission denied – please allow location access' : 'Could not get your location')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}
export function makeMap(el, center = [20.5937, 78.9629], zoom = 5) {
  if (!window.L) { el.innerHTML = '<p class="muted">Map unavailable (offline).</p>'; return null; }
  const map = window.L.map(el).setView(center, zoom);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  setTimeout(() => map.invalidateSize(), 50);
  return map;
}
/** Location picker bound to hidden lat/lng inputs. */
export function locationPicker(container, { lat, lng } = {}) {
  const mapEl = $('.map', container);
  const latIn = $('input[name$="lat"]', container); const lngIn = $('input[name$="lng"]', container);
  const status = $('.gps-status', container);
  const map = makeMap(mapEl, lat ? [lat, lng] : undefined, lat ? 15 : 5);
  let marker = null;
  const set = (la, ln, msg) => {
    latIn.value = la; lngIn.value = ln;
    status.textContent = msg || `Location set: ${la}, ${ln}`;
    if (map) { if (marker) marker.setLatLng([la, ln]); else marker = window.L.marker([la, ln]).addTo(map); map.setView([la, ln], Math.max(map.getZoom(), 15)); }
  };
  if (lat) set(lat, lng);
  map?.on('click', (e) => set(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6), 'Location set from map'));
  $('.gps-btn', container).addEventListener('click', async (e) => {
    await busy(e.target, async () => { const p = await getGps(); set(p.lat, p.lng, `GPS location captured (±${p.accuracy} m)`); });
  });
}
export const locationField = (prefix = 'location', title = 'Location') => raw(`
  <div class="field location-field"><span>${esc(title)} <em class="req">*</em></span>
    <div class="row"><button type="button" class="btn btn-secondary gps-btn">📍 Use my current GPS location</button><span class="gps-status muted">Or tap on the map to set the location.</span></div>
    <div class="map map-sm"></div>
    <input type="hidden" name="${prefix}.lat" required><input type="hidden" name="${prefix}.lng" required>
  </div>`);
export const navLink = (loc, text = 'Navigate') => (loc?.lat != null ? raw(`<a class="btn btn-secondary" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${loc.lat},${loc.lng}`)}">🧭 ${esc(text)}</a>`) : '');

/** Convert flat FormData (with dotted names) into a nested object. */
export function nest(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const parts = k.split('.');
    let o = out;
    parts.slice(0, -1).forEach((p) => { o = (o[p] ||= {}); });
    o[parts.at(-1)] = v;
  }
  return out;
}

export const empty = (text) => raw(`<div class="empty">${esc(text)}</div>`);
export const statTile = (value, title, note) => raw(`<div class="stat"><div class="stat-value">${esc(value)}</div><div class="stat-label">${esc(title)}</div>${note ? `<div class="stat-note">${esc(note)}</div>` : ''}</div>`);
