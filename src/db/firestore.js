'use strict';
// Cloud Firestore adapter (works on the free Spark plan).
// Only the server (Admin SDK) touches Firestore; client access is denied by firestore.rules.
const fs = require('fs');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function loadCredential(cfg) {
  if (cfg.serviceAccountBase64) return JSON.parse(Buffer.from(cfg.serviceAccountBase64, 'base64').toString('utf8'));
  if (cfg.serviceAccountPath) return JSON.parse(fs.readFileSync(cfg.serviceAccountPath, 'utf8'));
  return null;
}

class FirestoreDB {
  constructor(firebaseCfg) {
    this.kind = 'firestore';
    if (!getApps().length) {
      const sa = loadCredential(firebaseCfg);
      initializeApp(sa ? { credential: cert(sa), projectId: sa.project_id } : { projectId: firebaseCfg.projectId || undefined });
    }
    this.fs = getFirestore();
    this.fs.settings({ ignoreUndefinedProperties: true });
  }
  newId() { return this.fs.collection('_ids').doc().id; }
  ref(c, id) { return this.fs.collection(c).doc(id); }
  _query(c, where = {}, { limit } = {}) {
    let q = this.fs.collection(c);
    for (const [k, v] of Object.entries(where)) {
      q = v && typeof v === 'object' && Array.isArray(v.in) ? q.where(k, 'in', v.in) : q.where(k, '==', v);
    }
    if (limit) q = q.limit(limit);
    return q;
  }
  async get(c, id) { const s = await this.ref(c, id).get(); return s.exists ? { id: s.id, ...s.data() } : null; }
  async create(c, data, id = this.newId()) { await this.ref(c, id).create(data); return { id, ...data }; }
  async set(c, id, data) { await this.ref(c, id).set(data); return { id, ...data }; }
  async update(c, id, patch) {
    const { FieldValue } = require('firebase-admin/firestore');
    const p = {};
    for (const [k, v] of Object.entries(patch)) p[k] = v === undefined ? FieldValue.delete() : v;
    await this.ref(c, id).update(p);
  }
  async delete(c, id) { await this.ref(c, id).delete(); }
  async find(c, where, opts) { const s = await this._query(c, where, opts).get(); return s.docs.map((d) => ({ id: d.id, ...d.data() })); }
  // Equality-only query sorted in memory, so no composite index has to be deployed first.
  // (Per-user notifications / per-entity audit trails are small.)
  async findOrdered(c, where, field, limit) {
    const docs = await this.find(c, where);
    return docs.sort((a, b) => String(b[field]).localeCompare(String(a[field]))).slice(0, limit);
  }
  async count(c, where) { const s = await this._query(c, where).count().get(); return s.data().count; }
  async recent(c, field, limit) {
    const s = await this.fs.collection(c).orderBy(field, 'desc').limit(limit).get();
    return s.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  tx(fn) {
    return this.fs.runTransaction(async (tx) => {
      const writes = [];
      const t = {
        get: async (c, id) => { const s = await tx.get(this.ref(c, id)); return s.exists ? { id: s.id, ...s.data() } : null; },
        find: async (c, where, opts) => { const s = await tx.get(this._query(c, where, opts)); return s.docs.map((d) => ({ id: d.id, ...d.data() })); },
        create: (c, data, id = this.newId()) => { writes.push(() => tx.create(this.ref(c, id), data)); return { id, ...data }; },
        set: (c, id, data) => { writes.push(() => tx.set(this.ref(c, id), data)); },
        update: (c, id, patch) => { writes.push(() => tx.update(this.ref(c, id), patch)); },
        delete: (c, id) => { writes.push(() => tx.delete(this.ref(c, id))); },
      };
      const result = await fn(t);
      writes.forEach((w) => w());
      return result;
    });
  }
}

module.exports = FirestoreDB;
