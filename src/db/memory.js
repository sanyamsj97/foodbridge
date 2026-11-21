'use strict';
// In-memory document store with the same interface as the Firestore adapter.
// Used for automated tests and optional local development. NOT for production.
const crypto = require('crypto');
const fs = require('fs');
const { getPath, matches } = require('./util');

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

class MemoryDB {
  constructor({ file } = {}) {
    this.kind = 'memory';
    this.file = file;
    this.data = {};
    this.queue = Promise.resolve();
    if (file && fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  newId() { return crypto.randomBytes(10).toString('hex'); }
  _col(c) { return (this.data[c] ||= {}); }
  _persist() { if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.data)); }

  async get(c, id) { const d = this._col(c)[id]; return d ? { id, ...clone(d) } : null; }
  async create(c, data, id = this.newId()) {
    const col = this._col(c);
    if (col[id]) { const e = new Error('Document already exists'); e.code = 'already-exists'; throw e; }
    col[id] = clone(data); this._persist();
    return { id, ...clone(data) };
  }
  async set(c, id, data) { this._col(c)[id] = clone(data); this._persist(); return { id, ...clone(data) }; }
  async update(c, id, patch) {
    const col = this._col(c);
    if (!col[id]) { const e = new Error(`${c}/${id} not found`); e.code = 'not-found'; throw e; }
    col[id] = { ...col[id], ...clone(patch) };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete col[id][k];
    this._persist();
  }
  async delete(c, id) { delete this._col(c)[id]; this._persist(); }
  async find(c, where = {}, { limit } = {}) {
    let out = Object.entries(this._col(c))
      .filter(([, d]) => matches(d, where))
      .map(([id, d]) => ({ id, ...clone(d) }));
    if (limit) out = out.slice(0, limit);
    return out;
  }
  async findOrdered(c, where, field, limit) {
    const all = await this.find(c, where);
    return all.sort((a, b) => String(getPath(b, field)).localeCompare(String(getPath(a, field)))).slice(0, limit);
  }
  async count(c, where = {}) { return (await this.find(c, where)).length; }
  async recent(c, field, limit) {
    const all = await this.find(c);
    return all.sort((a, b) => String(getPath(b, field)).localeCompare(String(getPath(a, field)))).slice(0, limit);
  }
  // Serialised transaction: reads see committed state, writes are applied atomically at the end.
  tx(fn) {
    const run = this.queue.then(async () => {
      const writes = [];
      const t = {
        get: (c, id) => this.get(c, id),
        find: (c, where, opts) => this.find(c, where, opts),
        create: (c, data, id = this.newId()) => {
          if (this._col(c)[id]) { const e = new Error('Document already exists'); e.code = 'already-exists'; throw e; }
          writes.push(() => this.create(c, data, id)); return { id, ...clone(data) };
        },
        set: (c, id, data) => { writes.push(() => this.set(c, id, data)); },
        update: (c, id, patch) => { writes.push(() => this.update(c, id, patch)); },
        delete: (c, id) => { writes.push(() => this.delete(c, id)); },
      };
      const result = await fn(t);
      for (const w of writes) await w();
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

module.exports = MemoryDB;
