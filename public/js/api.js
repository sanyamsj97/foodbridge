// API client: access token kept in memory; refresh token is an httpOnly cookie.
let accessToken = null;
let currentUser = null;
let refreshing = null;

export const session = {
  get user() { return currentUser; },
  set(user, token) { currentUser = user; accessToken = token; },
  clear() { currentUser = null; accessToken = null; },
};

export class ApiError extends Error {
  constructor(status, body) { super(body?.error || `Request failed (${status})`); this.status = status; this.body = body; }
}

export async function refresh() {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) { session.clear(); return false; }
        const b = await r.json();
        session.set(b.user, b.accessToken);
        return true;
      })
      .catch(() => false)
      .finally(() => { setTimeout(() => { refreshing = null; }, 0); });
  }
  return refreshing;
}

async function raw(method, url, body, { retry = true } = {}) {
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (r.status === 401 && retry && !url.startsWith('/api/auth/login')) {
    if (await refresh()) return raw(method, url, body, { retry: false });
    window.dispatchEvent(new CustomEvent('fb:logged-out'));
  }
  return r;
}

export async function api(method, url, body) {
  const r = await raw(method, url, body);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await r.json() : null;
  if (!r.ok) throw new ApiError(r.status, data);
  return data;
}

export const get = (u) => api('GET', u);
export const post = (u, b = {}) => api('POST', u, b);
export const patch = (u, b = {}) => api('PATCH', u, b);
export const put = (u, b = {}) => api('PUT', u, b);

/** Fetch a protected binary (image/PDF/XLSX) and return a Blob. */
export async function blob(url) {
  const r = await raw('GET', url);
  if (!r.ok) {
    let msg = `Download failed (${r.status})`;
    try { msg = (await r.json()).error || msg; } catch { /* ignore */ }
    throw new ApiError(r.status, { error: msg });
  }
  return r.blob();
}

const objectUrls = new Map();
export async function fileUrl(id) {
  if (objectUrls.has(id)) return objectUrls.get(id);
  const b = await blob(`/api/files/${encodeURIComponent(id)}`);
  const u = URL.createObjectURL(b);
  objectUrls.set(id, u);
  return u;
}

export async function download(url, filename) {
  const b = await blob(url);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* ignore */ }
  session.clear();
}
